/**
 * @aa/crossref — Crossref REST API 客户端
 *
 * 需求 4：允许使用 Crossref 作为联网补充，验证文章的 meta 信息准确。
 *
 * 设计要点：
 *
 *  1. **可测试**：网络层通过 `fetchImpl` 注入，测试用假实现，不打真实网络。
 *     这样离线也能跑 `pnpm check`。
 *
 *  2. **礼貌池**：Crossref 建议在 User-Agent 或 `mailto` 参数里留下联系方式，
 *     否则可能被限流（429）。这里强制要求配置 `mailto`。
 *
 *  3. **实测教训（见 docs/00-recon-findings.md）**：从 PDF 里用正则捞 DOI 很不可靠——
 *     文本流拼接会产出 `10.1136/acupmed-2015-010950group.bmj.com` 这类脏值，
 *     甚至从参考文献里捞出无关论文的 DOI。因此本模块**不负责**从文本提 DOI，
 *     只负责"给定 DOI → 取权威元信息"与"给定标题 → 反查候选 DOI"。
 *     候选的取舍由调用方（SKILL 的校验步骤）决定。
 */

import type { CrossrefClient, CrossrefWork } from '@aa/core';

/** Crossref 原始响应里我们关心的字段。 */
interface CrMessage {
  DOI?: string;
  title?: string[];
  'container-title'?: string[];
  'short-container-title'?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  type?: string;
  ISSN?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  'is-referenced-by-count'?: number;
}

interface CrResponse {
  status?: string;
  'message-type'?: string;
  message?: CrMessage | { items?: CrMessage[] };
}

export interface CrossrefClientOptions {
  /** 联系方式，Crossref 礼貌池要求（会作为 mailto 参数发送） */
  mailto: string;
  /** 注入的 fetch 实现；默认用全局 fetch。测试时替换 */
  fetchImpl?: typeof fetch;
  /** 基础地址，便于指向镜像或 mock 服务 */
  baseUrl?: string;
  /** 超时（ms），默认 15s */
  timeoutMs?: number;
  /** 重试次数（仅对 429/5xx/网络错误），默认 2 */
  retries?: number;
  /** 可选：Crossref Plus 的 API key */
  apiKey?: string;
}

export class CrossrefError extends Error {
  constructor(
    message: string,
    public readonly kind: 'not_found' | 'rate_limited' | 'http' | 'network' | 'parse' | 'bad_request',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CrossrefError';
  }
}

/** DOI 规范化：去前缀 URL、去尾部标点、小写。 */
export function normalizeDoi(input: string): string {
  let d = String(input ?? '').trim();
  // 去掉 https://doi.org/ 、doi: 等前缀
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  // 去掉常见的尾随标点（实测文本流拼接会带 . , ; ) 等）
  d = d.replace(/[.,;:)\]}'"]+$/, '');
  return d.toLowerCase();
}

/**
 * 判断是否形如合法 DOI。
 *
 * ⚠️ 不能只用 `^10\.\d{4,9}\/\S+$`：`\S+` 会把域名一起吃掉。
 * 实测脏值 `10.1136/acupmed-2015-010950group.bmj.com`（正文文本流拼接产物）
 * 会被该正则判为合法，进而拿去 Crossref 查询并失败。
 *
 * 因此额外要求：后缀以字母/数字结尾，且不含常见域名片段。
 */
export function isLikelyDoi(s: string): boolean {
  const d = normalizeDoi(s);
  if (!/^10\.\d{4,9}\/\S+$/.test(d)) return false;
  const suffix = d.slice(d.indexOf('/') + 1);
  // 以标点结尾 → 多半是拼接残留
  if (/[^a-z0-9]$/i.test(suffix)) return false;
  // 含域名片段 → 拼接残留
  if (/(?:group|www|http|doi)\.(?:bmj|com|org|net|edu|gov)/i.test(suffix)) return false;
  if (/\.(?:com|org|net|edu|gov)(?:\/|$)/i.test(suffix)) return false;
  // 后缀只允许 DOI 规范字符
  if (!/^[a-z0-9._;()/:<>-]+$/i.test(suffix)) return false;
  // 后缀长度异常（真实 DOI 后缀从 `bmj` 到几十字符都有，故下限取 1）
  if (suffix.length < 1 || suffix.length > 80) return false;
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Crossref 文本里常见的 HTML 实体（实测 title/container-title 里会带 `&amp;`）。 */
function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 Crossref 的 message 规整成我们的 CrossrefWork。 */
function toWork(m: CrMessage): CrossrefWork | null {
  const doi = m.DOI ? normalizeDoi(m.DOI) : '';
  if (!doi) return null;

  const yearOf = (d?: { 'date-parts'?: number[][] }): string | undefined => {
    const y = d?.['date-parts']?.[0]?.[0];
    return typeof y === 'number' ? String(y) : undefined;
  };
  const year = yearOf(m.issued) ?? yearOf(m['published-print']) ?? yearOf(m['published-online']);

  const authors = (m.author ?? [])
    .map((a) => decodeEntities(a.name ?? [a.given, a.family].filter(Boolean).join(' ')))
    .filter((s): s is string => Boolean(s && s.trim()));

  const title = decodeEntities(m.title?.[0]);
  const container = decodeEntities(m['container-title']?.[0] ?? m['short-container-title']?.[0]);

  return {
    doi,
    ...(title ? { title } : {}),
    ...(container ? { containerTitle: container } : {}),
    ...(year ? { issuedYear: year } : {}),
    ...(authors.length ? { authors } : {}),
    ...(m.type ? { type: m.type } : {}),
  };
}

export interface CrossrefClientExtended extends CrossrefClient {
  /** 原始请求次数统计，便于观测与限流保护 */
  readonly stats: { requests: number; retries: number; rateLimited: number };
}

/**
 * 创建 Crossref 客户端。
 *
 * @example
 * const cr = createCrossrefClient({ mailto: 'you@example.com' });
 * const work = await cr.byDoi('10.1136/acupmed-2015-010950');
 */
export function createCrossrefClient(opts: CrossrefClientOptions): CrossrefClientExtended {
  if (!opts.mailto || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.mailto)) {
    throw new Error('createCrossrefClient 需要合法的 mailto（Crossref 礼貌池要求）');
  }
  const base = (opts.baseUrl ?? 'https://api.crossref.org').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('未提供 fetchImpl 且运行环境无全局 fetch');
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.retries ?? 2;

  const stats = { requests: 0, retries: 0, rateLimited: 0 };

  async function request(path: string, params: Record<string, string> = {}): Promise<CrResponse> {
    const url = new URL(base + path);
    url.searchParams.set('mailto', opts.mailto);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (opts.apiKey) url.searchParams.set('api-key', opts.apiKey);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        stats.retries++;
        // 指数退避：限流时退得更久
        await sleep(Math.min(8000, 400 * 2 ** attempt));
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        stats.requests++;
        const res = await doFetch(url.toString(), {
          signal: ctrl.signal,
          headers: {
            // Crossref 建议带上 UA；mailto 参数已满足礼貌池
            'User-Agent': `article-agent/0.1 (mailto:${opts.mailto})`,
            Accept: 'application/json',
          },
        });
        clearTimeout(timer);

        if (res.status === 404) throw new CrossrefError('DOI 不存在', 'not_found', 404);
        if (res.status === 429) {
          stats.rateLimited++;
          lastErr = new CrossrefError('被限流 (429)', 'rate_limited', 429);
          continue;   // 重试
        }
        if (res.status >= 500) {
          lastErr = new CrossrefError(`服务端错误 ${res.status}`, 'http', res.status);
          continue;   // 重试
        }
        if (!res.ok) throw new CrossrefError(`HTTP ${res.status}`, 'http', res.status);

        return (await res.json()) as CrResponse;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof CrossrefError) {
          if (e.kind === 'not_found' || e.kind === 'http') throw e;
          lastErr = e;
          continue;
        }
        // AbortError / 网络错误 → 重试
        lastErr = new CrossrefError(`网络错误: ${(e as Error).message}`, 'network');
        continue;
      }
    }
    throw lastErr instanceof CrossrefError ? lastErr : new CrossrefError('请求失败', 'network');
  }

  return {
    stats,

    async byDoi(doi: string): Promise<CrossrefWork | null> {
      const d = normalizeDoi(doi);
      if (!isLikelyDoi(d)) throw new CrossrefError(`不是合法 DOI: ${doi}`, 'bad_request');
      try {
        const r = await request(`/works/${encodeURIComponent(d)}`);
        const msg = r.message;
        if (!msg || Array.isArray(msg)) return null;
        return toWork(msg as CrMessage);
      } catch (e) {
        if (e instanceof CrossrefError && e.kind === 'not_found') return null;
        throw e;
      }
    },

    async byTitle(title: string, o: { year?: string } = {}): Promise<readonly CrossrefWork[]> {
      const q = String(title ?? '').trim();
      if (q.length < 10) throw new CrossrefError('标题过短，拒绝查询', 'bad_request');

      const params: Record<string, string> = {
        'query.bibliographic': q,
        rows: '5',
        // 只取期刊论文，减少噪声
        filter: 'type:journal-article',
      };
      /*
       * ⚠️ 年份必须是 4 位数字才拼进 filter。
       *
       * 实测踩到的坑：模型把发表年份答成 `NR`（未报告）时，
       * filter 会变成 `from-pub-date:NR-01-01`，Crossref 直接回 **HTTP 400**——
       * 表现为"Crossref 校验失败（已降级）"，整条联网核验通路静默失效。
       */
      const y = String(o.year ?? '').trim();
      if (/^\d{4}$/.test(y)) params.filter += `,from-pub-date:${y}-01-01,until-pub-date:${y}-12-31`;

      const r = await request('/works', params);
      const msg = r.message;
      const items = msg && !Array.isArray(msg) ? (msg as { items?: CrMessage[] }).items : undefined;
      if (!items?.length) return [];
      const works: CrossrefWork[] = [];
      for (const m of items) {
        const w = toWork(m);
        if (w) works.push(w);
      }
      return works;
    },
  };
}
