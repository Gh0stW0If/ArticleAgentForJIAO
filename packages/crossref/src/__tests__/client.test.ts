import { describe, it, expect, vi } from 'vitest';
import { createCrossrefClient, CrossrefError, normalizeDoi, isLikelyDoi } from '../client.ts';
import type { CrossrefWork } from '@aa/core';

/** 构造假 fetch，按 URL 路由返回预设响应。 */
type FetchInput = Parameters<typeof fetch>[0];

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: FetchInput) => {
    const url = String(input);
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(resp.body === undefined ? '' : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not routed', { status: 500 });
  }) as typeof fetch;
}

const WORK_BODY = {
  status: 'ok',
  'message-type': 'work',
  message: {
    DOI: '10.1136/acupmed-2015-010950',
    title: ['Acupuncture for fibromyalgia in primary care: a randomised controlled trial'],
    'container-title': ['Acupuncture in Medicine'],
    author: [
      { given: 'Jorge', family: 'Vas' },
      { given: 'Koldo', family: 'Santos-Rey' },
    ],
    issued: { 'date-parts': [[2015, 6, 1]] },
    type: 'journal-article',
  },
};

describe('crossref — DOI 规范化', () => {
  it('去 URL 前缀并小写', () => {
    expect(normalizeDoi('https://doi.org/10.1136/Acupmed-2015-010950')).toBe('10.1136/acupmed-2015-010950');
    expect(normalizeDoi('doi:10.1016/j.anai.2015.05.017')).toBe('10.1016/j.anai.2015.05.017');
  });

  it('去掉文本流拼接产生的尾随标点（实测真实问题）', () => {
    // 实测从 PDF 正则捞到过 "10.1016/j.anai.2015.05.017.References"
    expect(normalizeDoi('10.1016/j.anai.2015.05.017.References')).toBe('10.1016/j.anai.2015.05.017.references');
    expect(normalizeDoi('10.1136/acupmed-2015-010950.')).toBe('10.1136/acupmed-2015-010950');
    expect(normalizeDoi('10.1136/x)')).toBe('10.1136/x');
  });

  it('校验 DOI 形态', () => {
    expect(isLikelyDoi('10.1136/acupmed-2015-010950')).toBe(true);
    expect(isLikelyDoi('not-a-doi')).toBe(false);
    expect(isLikelyDoi('10.1136')).toBe(false);
  });
});

describe('crossref — 客户端', () => {
  it('缺少合法 mailto 时拒绝创建（礼貌池要求）', () => {
    expect(() => createCrossrefClient({ mailto: 'not-an-email' })).toThrow(/mailto/);
    expect(() => createCrossrefClient({ mailto: '' })).toThrow(/mailto/);
  });

  it('byDoi 成功取回并规整字段', async () => {
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: fakeFetch({ '/works/': { status: 200, body: WORK_BODY } }) });
    const w = await cr.byDoi('https://doi.org/10.1136/acupmed-2015-010950');
    expect(w).not.toBeNull();
    expect(w!.doi).toBe('10.1136/acupmed-2015-010950');
    expect(w!.title).toContain('fibromyalgia');
    expect(w!.containerTitle).toBe('Acupuncture in Medicine');
    expect(w!.issuedYear).toBe('2015');
    expect(w!.authors).toEqual(['Jorge Vas', 'Koldo Santos-Rey']);
  });

  it('请求携带 mailto 与 UA', async () => {
    let seenUrl = '';
    let seenUa = '';
    const spy = (async (input: FetchInput, init?: RequestInit) => {
      seenUrl = String(input);
      seenUa = String((init?.headers as Record<string, string>)?.['User-Agent'] ?? '');
      return new Response(JSON.stringify(WORK_BODY), { status: 200 });
    }) as typeof fetch;
    const cr = createCrossrefClient({ mailto: 'me@example.com', fetchImpl: spy });
    await cr.byDoi('10.1136/acupmed-2015-010950');
    expect(seenUrl).toContain('mailto=me%40example.com');
    expect(seenUa).toContain('me@example.com');
  });

  it('404 返回 null 而不抛错（DOI 不存在是正常情况）', async () => {
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: fakeFetch({ '/works/': { status: 404 } }) });
    await expect(cr.byDoi('10.9999/nope')).resolves.toBeNull();
  });

  it('非法 DOI 直接拒绝，不发请求', async () => {
    const spy = vi.fn();
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: spy as unknown as typeof fetch });
    await expect(cr.byDoi('garbage')).rejects.toThrow(CrossrefError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('429 会重试并最终成功', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) return new Response('', { status: 429 });
      return new Response(JSON.stringify(WORK_BODY), { status: 200 });
    }) as typeof fetch;
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: flaky, retries: 2 });
    const w = await cr.byDoi('10.1136/acupmed-2015-010950');
    expect(w).not.toBeNull();
    expect(n).toBe(2);
    expect(cr.stats.rateLimited).toBe(1);
    expect(cr.stats.retries).toBe(1);
  }, 20_000);

  it('5xx 重试耗尽后抛错', async () => {
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: fakeFetch({ '/works/': { status: 503 } }), retries: 1 });
    await expect(cr.byDoi('10.1136/x')).rejects.toThrow(/503|服务端/);
  }, 20_000);

  it('byTitle 返回候选列表并带上年份过滤', async () => {
    let seenUrl = '';
    const spy = (async (input: FetchInput) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ message: { items: [WORK_BODY.message] } }), { status: 200 });
    }) as typeof fetch;
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: spy });
    const list = await cr.byTitle('Acupuncture for fibromyalgia in primary care', { year: '2015' });
    expect(list.length).toBe(1);
    expect(list[0]!.doi).toBe('10.1136/acupmed-2015-010950');
    expect(seenUrl).toContain('from-pub-date%3A2015-01-01');
    expect(seenUrl).toContain('query.bibliographic');
  });

  it('标题过短拒绝查询（避免噪声）', async () => {
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: fakeFetch({}) });
    await expect(cr.byTitle('short')).rejects.toThrow(/过短/);
  });

  /*
   * 实测踩到的坑：模型把年份答成 NR 时，filter 会变成 `from-pub-date:NR-01-01`，
   * Crossref 回 HTTP 400 → 整条联网核验通路静默失效（表现为"Crossref 校验失败（已降级）"）。
   * 因此非 4 位数字的年份一律不拼进 filter。
   */
  it('年份不是 4 位数字时不拼日期过滤（否则 Crossref 报 400）', async () => {
    const urls: string[] = [];
    const spy = (async (input: FetchInput) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ message: { items: [WORK_BODY.message] } }), { status: 200 });
    }) as typeof fetch;
    const cr = createCrossrefClient({ mailto: 'a@b.com', fetchImpl: spy });

    await cr.byTitle('Acupuncture for fibromyalgia in primary care', { year: 'NR' });
    await cr.byTitle('Acupuncture for fibromyalgia in primary care', { year: '2015年' });
    await cr.byTitle('Acupuncture for fibromyalgia in primary care', { year: '15' });

    for (const u of urls) {
      expect(u).not.toContain('from-pub-date');
      expect(u).not.toContain('NR');
    }
  });
});
