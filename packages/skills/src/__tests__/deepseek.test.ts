/**
 * DeepSeek 客户端测试 —— 全部用假 fetch，不联网、不需要密钥。
 *
 * 覆盖的都是"真实跑起来会踩到"的点：
 *   · 请求形状（JSON 模式、model、temperature、max_tokens、鉴权头）
 *   · 三级 JSON 解析降级（干净 / ``` 围栏 / 前后有废话）
 *   · finish_reason=length 必须单独报错（截断会伪装成"字段缺失"）
 *   · 429/5xx 重试、401 立即失败、超时报错
 *   · 任何错误信息里都不出现 apiKey
 */

import { describe, it, expect, vi } from 'vitest';
import { createDeepSeekLlm, DeepSeekError, parseJsonLoose, escapeControlCharsInStrings } from '../deepseek.ts';

const KEY = 'sk-test-should-never-leak-1234567890';

const okResponse = (content: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    model: 'deepseek-chat',
    ...extra,
  }),
  text: async () => '',
});

const errResponse = (status: number, body = 'boom') => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => body,
});

const req = (over: Partial<{ system: string; user: string; tag: string; temperature: number }> = {}) => ({
  system: '你是抽取员，请输出 json',
  user: '材料……',
  tag: 'test@0.1.0:2015-01',
  ...over,
});

describe('deepseek — 请求形状', () => {
  it('构造正确的 URL、鉴权头与 JSON 模式', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const llm = createDeepSeekLlm({
      apiKey: KEY,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return okResponse('{"title":{"value":"A","quote":"A"}}');
      }) as unknown as typeof fetch,
    });

    const res = await llm.invoke(req());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(8000);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toBe('材料……');
    expect(res.json).toEqual({ title: { value: 'A', quote: 'A' } });
    expect(res.model).toBe('deepseek-chat');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('baseUrl 带 /v1 或尾斜杠时不会拼出双斜杠', async () => {
    const urls: string[] = [];
    const mk = (baseUrl: string) => createDeepSeekLlm({
      apiKey: KEY, baseUrl,
      fetchImpl: (async (url: string) => { urls.push(url); return okResponse('{}'); }) as unknown as typeof fetch,
    });
    await mk('https://api.deepseek.com/v1/').invoke(req());
    await mk('https://api.deepseek.com').invoke(req());
    expect(urls).toEqual([
      'https://api.deepseek.com/v1/chat/completions',
      'https://api.deepseek.com/chat/completions',
    ]);
  });

  it('请求级 temperature 覆盖默认值；maxTokens / model 可配置', async () => {
    let body: Record<string, unknown> = {};
    const llm = createDeepSeekLlm({
      apiKey: KEY, model: 'deepseek-reasoner', temperature: 0.7, maxTokens: 4096,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return okResponse('{}');
      }) as unknown as typeof fetch,
    });
    await llm.invoke(req({ temperature: 0.2 }));
    expect(body.temperature).toBe(0.2);
    expect(body.model).toBe('deepseek-reasoner');
    expect(body.max_tokens).toBe(4096);
  });
});

describe('deepseek — JSON 解析降级', () => {
  it('直接 JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it('去掉 ```json 围栏', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('前后带解释文字', () => {
    expect(parseJsonLoose('好的，结果如下：\n{"a":1}\n希望有帮助')).toEqual({ a: 1 });
  });
  it('空文本报 empty', () => {
    expect(() => parseJsonLoose('   ')).toThrowError(/空文本/);
  });
  it('彻底不是 JSON 时报错并带上片段', () => {
    try {
      parseJsonLoose('抱歉，我无法完成');
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(DeepSeekError);
      expect((e as DeepSeekError).kind).toBe('parse');
      expect((e as Error).message).toContain('抱歉');
    }
  });

  /*
   * 实测踩到的坑：模型把多行 quote 原样粘进 JSON 字符串（裸换行），
   * JSON 规范禁止 → parse 直接失败，整环节输出全丢（40 次调用里栽了 5 次）。
   */
  it('字符串内的裸换行（模型原样粘贴多行 quote）会被转义后解析成功', () => {
    const bad = '{\n  "followUpDescription": { "value": "12 months", "quote": "During the follow-up period, significant\n  differences (p<0.01) in favour of the IA group\n  persisted at 12 months", "confidence": 0.9 }\n}';
    expect(() => JSON.parse(bad)).toThrow();          // 原样确实是非法 JSON
    const parsed = parseJsonLoose(bad) as { followUpDescription: { quote: string; value: string } };
    expect(parsed.followUpDescription.quote).toContain('persisted at 12 months');
    expect(parsed.followUpDescription.value).toBe('12 months');
  });

  it('字符串外的换行与缩进不受影响；制表符同样被转义', () => {
    const bad = '{"a": "x\ty\nz",\n "b": 2}';
    expect(parseJsonLoose(bad)).toEqual({ a: 'x\ty\nz', b: 2 });
  });

  it('合法的转义序列（\\" 与 \\\\）不会被破坏', () => {
    const good = '{"a":"he said \\"hi\\"","b":"path\\\\to"}';
    expect(parseJsonLoose(good)).toEqual({ a: 'he said "hi"', b: 'path\\to' });
    // 含转义 + 裸换行混合
    const mixed = '{"a":"he said \\"hi\\"\nthere"}';
    expect(parseJsonLoose(mixed)).toEqual({ a: 'he said "hi"\nthere' });
  });

  it('escapeControlCharsInStrings 只动字符串内部', () => {
    const src = '{\n  "a": "1\n2",\n  "b": [\n    3\n  ]\n}';
    const out = escapeControlCharsInStrings(src);
    expect(out).toContain('"1\\n2"');
    expect(out).toContain('[\n    3\n  ]');   // 数组里的换行保持原样
    expect(JSON.parse(out)).toEqual({ a: '1\n2', b: [3] });
  });
});

describe('deepseek — 失败处理', () => {
  it('finish_reason=length 报 truncated（不伪装成字段缺失）', async () => {
    const llm = createDeepSeekLlm({
      apiKey: KEY,
      fetchImpl: (async () => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }),
        text: async () => '',
      })) as unknown as typeof fetch,
    });
    await expect(llm.invoke(req())).rejects.toThrowError(/截断/);
    expect(llm.calls[0]!.kind).toBe('truncated');
  });

  it('401 立即失败且不重试', async () => {
    const fetchImpl = vi.fn(async () => errResponse(401, 'invalid api key'));
    const llm = createDeepSeekLlm({ apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch, retries: 3 });
    await expect(llm.invoke(req())).rejects.toThrowError(/鉴权失败/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429 会重试并最终成功', async () => {
    let n = 0;
    const llm = createDeepSeekLlm({
      apiKey: KEY, retries: 2,
      fetchImpl: (async () => (++n < 2 ? errResponse(429) : okResponse('{"a":1}'))) as unknown as typeof fetch,
    });
    const res = await llm.invoke(req());
    expect(res.json).toEqual({ a: 1 });
    expect(n).toBe(2);
    expect(llm.calls.map((c) => c.ok)).toEqual([false, true]);
  });

  it('5xx 重试耗尽后抛错', async () => {
    const fetchImpl = vi.fn(async () => errResponse(503));
    const llm = createDeepSeekLlm({ apiKey: KEY, retries: 1, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(llm.invoke(req())).rejects.toThrowError(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('网络异常按 network 归类并重试', async () => {
    let n = 0;
    const llm = createDeepSeekLlm({
      apiKey: KEY, retries: 1,
      fetchImpl: (async () => { if (++n === 1) throw new Error('ECONNRESET'); return okResponse('{}'); }) as unknown as typeof fetch,
    });
    await llm.invoke(req());
    expect(llm.calls[0]!.kind).toBe('network');
    expect(n).toBe(2);
  });

  it('超时按 timeout 归类', async () => {
    const llm = createDeepSeekLlm({
      apiKey: KEY, retries: 0, timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })) as unknown as typeof fetch,
    });
    await expect(llm.invoke(req())).rejects.toThrowError(/超时/);
    expect(llm.calls[0]!.kind).toBe('timeout');
  });

  it('缺少 apiKey 直接 config 报错', () => {
    expect(() => createDeepSeekLlm({ apiKey: '  ' })).toThrowError(/缺少 apiKey/);
  });

  it('任何错误信息里都不出现 apiKey', async () => {
    const llm = createDeepSeekLlm({
      apiKey: KEY, retries: 0,
      fetchImpl: (async () => errResponse(401, `bad key ${KEY}`)) as unknown as typeof fetch,
    });
    await llm.invoke(req()).catch((e: Error) => {
      expect(e.message).not.toContain(KEY);
    });
    // 观测回调同样不含密钥
    expect(JSON.stringify(llm.calls)).not.toContain(KEY);
  });

  it('JSON 坏掉时改提示词重试一次（温度=0 重发同请求只会复现同样的坏输出）', async () => {
    const users: string[] = [];
    let n = 0;
    const llm = createDeepSeekLlm({
      apiKey: KEY, retries: 3,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        users.push(body.messages[1].content);
        n++;
        // 第 1 次：字符串里有未转义的引号 → 非法 JSON；第 2 次返回合法 JSON
        return n === 1 ? okResponse('{"a":"he said "hi""}') : okResponse('{"a":"he said \\"hi\\""}');
      }) as unknown as typeof fetch,
    });

    const res = await llm.invoke(req());
    expect(res.json).toEqual({ a: 'he said "hi"' });
    expect(n).toBe(2);
    expect(users[1], '第二次请求必须带上格式修正提示').toContain('不是合法 JSON');
    expect(users[1]).toContain('必须写成');
  });

  it('retryOnParseError=false 时不重试，直接抛错', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"a":"bad "quote""}'));
    const llm = createDeepSeekLlm({
      apiKey: KEY, retryOnParseError: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(llm.invoke(req())).rejects.toThrowError(/不是合法 JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('deepseek — 观测记录', () => {
  it('onCall 收到耗时/用量/字符数，且可累计', async () => {
    const seen: unknown[] = [];
    const llm = createDeepSeekLlm({
      apiKey: KEY,
      onCall: (info) => seen.push(info),
      fetchImpl: (async () => okResponse('{"a":1}')) as unknown as typeof fetch,
    });
    await llm.invoke(req({ system: 'x'.repeat(30), user: 'y'.repeat(70) }));
    expect(seen).toHaveLength(1);
    const info = llm.calls[0]!;
    expect(info.ok).toBe(true);
    expect(info.promptChars).toBe(100);
    expect(info.outputChars).toBe(7);
    expect(info.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(info.tag).toBe('test@0.1.0:2015-01');
  });
});
