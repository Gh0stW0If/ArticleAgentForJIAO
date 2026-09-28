/**
 * @aa/skills — DeepSeek LLM 接入（OpenAI 兼容 Chat Completions）
 *
 * 这是 `packages/skills/src/llm.ts` 里那份"交接契约"的实现：
 *
 *  1. **结构化输出**：所有 SKILL 都需要 `res.json`，因此默认强制
 *     `response_format: { type: 'json_object' }`。为防模型仍加围栏/前后缀，
 *     解析走三级降级（直接 parse → 去 ``` 围栏 → 取首尾大括号）。
 *  2. **禁止模型给坐标**：这里完全不碰坐标；坐标由本地 `locateEvidence()` 定位。
 *  3. **失败要抛错**：鉴权/参数错误立即失败；429/5xx/网络/超时按指数退避重试；
 *     输出被截断（finish_reason=length）单独报错——那通常意味着 max_tokens 不够，
 *     静默截断会变成"字段莫名其妙缺失"。
 *  4. **可复现**：记录 model、采样参数、usage，响应原文可由运行器落盘做回放。
 *  5. **不泄露密钥**：任何错误信息与回调都不包含 apiKey。
 */

import type { LlmInvoker, LlmRequest, LlmResponse } from '@aa/core';

/* --------------------------------- 类型 --------------------------------- */

export type DeepSeekErrorKind = 'config' | 'auth' | 'http' | 'network' | 'timeout' | 'parse' | 'truncated' | 'empty';

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly kind: DeepSeekErrorKind,
    readonly detail: { tag: string; attempt: number; status?: number; body?: string } = { tag: '', attempt: 0 },
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export interface DeepSeekCallInfo {
  tag: string;
  model: string;
  attempt: number;
  ms: number;
  ok: boolean;
  /** HTTP 状态码（仅失败时有意义） */
  status?: number;
  /** 提示词与输出长度（字符数），用于粗看成本 */
  promptChars: number;
  outputChars: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  error?: string;
  kind?: DeepSeekErrorKind;
}

export interface DeepSeekOptions {
  apiKey: string;
  /** 默认 https://api.deepseek.com */
  baseUrl?: string;
  /** 默认 deepseek-chat */
  model?: string;
  /** 请求级 temperature 缺省时用它，默认 0 */
  temperature?: number;
  /** 默认 8000（deepseek-chat 单次输出上限） */
  maxTokens?: number;
  /** 默认 300000ms（大材料 + 长输出） */
  timeoutMs?: number;
  /** 可重试错误的最大重试次数，默认 2（即最多 3 次请求） */
  retries?: number;
  fetchImpl?: typeof fetch;
  /** 是否强制 JSON 模式，默认 true（本项目的 SKILL 全部需要 JSON） */
  jsonMode?: boolean;
  /**
   * JSON 解析失败时是否追加一次「修正格式」重试，默认 true。
   *
   * 实测价值：模型偶尔会在字符串里塞入未转义的引号/换行，整个响应作废；
   * 而温度=0 重发同一请求只会得到同样的坏输出，因此必须**改提示词**再试一次。
   */
  retryOnParseError?: boolean;
  /** 每次请求结束后的观测回调（不含密钥） */
  onCall?: (info: DeepSeekCallInfo) => void;
}

export interface DeepSeekLlm extends LlmInvoker {
  readonly kind: 'deepseek';
  readonly model: string;
  readonly calls: readonly DeepSeekCallInfo[];
}

/* --------------------------------- 工具 --------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 转义字符串字面量里的裸控制字符。
 *
 * 实测必要性：模型会把多行 quote **原样**粘进 JSON 字符串，例如
 *   "quote": "During the follow-up period, significant
 *     differences (p<0.01) in favour of the IA group persisted at 12 months"
 * 而 JSON 规范禁止字符串里出现裸换行 —— `JSON.parse` 直接抛错，
 * 整个环节的输出全丢（实测 40 次调用里有 5 次栽在这上面）。
 *
 * 这里做最小修复：只在字符串内部把 \n \r \t 等转义，字符串外的空白不动，
 * 反斜杠转义状态也照常维护，因此不会误伤合法的 `\"` 与 `\\`。
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        out += ch === '\n' ? '\\n'
          : ch === '\r' ? '\\r'
            : ch === '\t' ? '\\t'
              : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** 解析模型输出为 JSON，容忍围栏、前后缀与字符串内的裸控制字符。 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) throw new DeepSeekError('模型返回空文本', 'empty');

  const tryParse = (s: string): { ok: true; value: unknown } | { ok: false } => {
    try { return { ok: true, value: JSON.parse(s) }; } catch { /* 再试修正版 */ }
    try { return { ok: true, value: JSON.parse(escapeControlCharsInStrings(s)) }; } catch { return { ok: false }; }
  };

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  const candidates: string[] = [
    t,
    ...(fence?.[1]?.trim() ? [fence[1].trim()] : []),
    ...(s >= 0 && e > s ? [t.slice(s, e + 1)] : []),
  ];

  for (const c of candidates) {
    const r = tryParse(c);
    if (r.ok) return r.value;
  }
  throw new DeepSeekError(
    `模型输出不是合法 JSON（已尝试转义字符串内换行；前 200 字符）：${t.slice(0, 200)}`,
    'parse',
  );
}

/** 由 HTTP 状态判断是否值得重试。 */
const retriable = (status: number): boolean => status === 408 || status === 429 || status >= 500;/* --------------------------------- 实现 --------------------------------- */

export function createDeepSeekLlm(opts: DeepSeekOptions): DeepSeekLlm {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) throw new DeepSeekError('缺少 apiKey', 'config');

  const baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = opts.model ?? 'deepseek-chat';
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 8000;
  /*
   * `maxTokens` 给 0 或负数 = **不限制**：把 `max_tokens` 整个省略、由服务端用它自己的默认上限。
   *
   * 为什么要留这个口子：实测 gpt-6-sol 在 outcome-values/audit 这类长输出上会超过 8000，
   * 结果 `finish_reason === 'length'`，回来的是**截断的 JSON**、整段字段白丢。
   * 而"到底该填多少"没人说得准（不同模型上限不同），所以"不填"比"填一个拍脑袋的数"可靠。
   */
  const noMaxTokens = !(Number.isFinite(maxTokens) && maxTokens > 0);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const retries = opts.retries ?? 2;
  const jsonMode = opts.jsonMode ?? true;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const calls: DeepSeekCallInfo[] = [];

  if (typeof doFetch !== 'function') throw new DeepSeekError('当前运行环境没有 fetch', 'config');

  const record = (info: DeepSeekCallInfo): void => {
    calls.push(info);
    opts.onCall?.(info);
  };

  /**
   * 屏蔽密钥。
   *
   * 实测必要性：部分网关会在报错时把收到的 Authorization 原样回显，
   * 若直接把它拼进错误信息/日志，密钥就泄露到磁盘与终端里了。
   * 因此凡是"把外部文本带出来"的地方一律先过这里。
   */
  const redact = (s: string): string => s
    .split(apiKey).join('«apiKey»')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{6,}/gi, 'Bearer «apiKey»')
    .replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, 'sk-«apiKey»');

  async function once(req: LlmRequest, attempt: number): Promise<LlmResponse> {
    const started = Date.now();
    const base = {
      tag: req.tag, model, attempt,
      promptChars: req.system.length + req.user.length,
    };

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? temperature,
      // 不限制时整个省略 —— 见上面 noMaxTokens 的说明
      ...(noMaxTokens ? {} : { max_tokens: maxTokens }),
      stream: false,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      const kind: DeepSeekErrorKind = aborted ? 'timeout' : 'network';
      const msg = aborted
        ? `请求超时（${timeoutMs}ms）`
        : `网络错误：${(e as Error).message}`;
      record({ ...base, ms: Date.now() - started, ok: false, outputChars: 0, error: msg, kind });
      throw new DeepSeekError(msg, kind, { tag: req.tag, attempt });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const kind: DeepSeekErrorKind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
      const msg = redact(
        `DeepSeek HTTP ${res.status}${kind === 'auth' ? '（鉴权失败，请检查 API key）' : ''}：${text.slice(0, 300)}`,
      );
      record({ ...base, ms: Date.now() - started, ok: false, outputChars: 0, status: res.status, error: msg, kind });
      throw new DeepSeekError(msg, kind, { tag: req.tag, attempt, status: res.status, body: redact(text.slice(0, 500)) });
    }

    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    } | null;

    const choice = data?.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason ?? undefined;
    const usage = data?.usage
      ? {
          ...(typeof data.usage.prompt_tokens === 'number' ? { inputTokens: data.usage.prompt_tokens } : {}),
          ...(typeof data.usage.completion_tokens === 'number' ? { outputTokens: data.usage.completion_tokens } : {}),
        }
      : undefined;

    if (finishReason === 'length') {
      const msg = noMaxTokens
        ? '输出被服务端上限截断（本次未限制 max_tokens），JSON 必然不完整——请缩小材料或换更短输出的模型'
        : `输出被 max_tokens(${maxTokens}) 截断，JSON 必然不完整——请提高 maxTokens 或缩小材料`;
      record({ ...base, ms: Date.now() - started, ok: false, outputChars: text.length, ...(usage ? { usage } : {}), finishReason, error: msg, kind: 'truncated' });
      throw new DeepSeekError(msg, 'truncated', { tag: req.tag, attempt });
    }

    let json: unknown;
    try {
      json = parseJsonLoose(text);
    } catch (e) {
      const msg = redact((e as Error).message);
      record({ ...base, ms: Date.now() - started, ok: false, outputChars: text.length, ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), error: msg, kind: 'parse' });
      throw new DeepSeekError(msg, 'parse', { tag: req.tag, attempt, body: redact(text.slice(0, 500)) });
    }

    record({
      ...base,
      ms: Date.now() - started, ok: true, outputChars: text.length,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    });

    return {
      text,
      json,
      model: data?.model ?? model,
      ...(usage ? { usage } : {}),
    };
  }

  return {
    kind: 'deepseek' as const,
    model,
    calls,

    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const retryOnParse = opts.retryOnParseError ?? true;
      let lastErr: unknown;
      let current = req;
      let parseRetried = false;

      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          return await once(current, attempt);
        } catch (e) {
          lastErr = e;
          const err = e as DeepSeekError;

          // JSON 格式坏了：改提示词重试一次（同请求重发在 temperature=0 下必然复现同样的坏输出）
          if (err.kind === 'parse' && retryOnParse && !parseRetried) {
            parseRetried = true;
            current = {
              ...current,
              user: `${current.user}\n\n---\n注意：上一次的回复不是合法 JSON，无法解析。请重新输出**完整且合法**的 JSON：\n` +
                `1) 字符串内部不得出现真实换行（用空格连接）；\n` +
                `2) 字符串内部的引号必须写成 \\"；\n` +
                `3) 反斜杠必须写成 \\\\；\n` +
                `4) 不要输出 JSON 以外的任何文字。`,
            };
            continue;
          }

          // 鉴权/参数/截断问题重试无意义（截断要改的是 max_tokens，不是重发）
          const canRetry = err.kind === 'timeout' || err.kind === 'network'
            || (err.kind === 'http' && retriable(err.detail.status ?? 0));
          if (!canRetry || attempt > retries) throw e;
          const backoff = Math.min(30_000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          await sleep(backoff);
        }
      }
      throw lastErr;
    },
  };
}
