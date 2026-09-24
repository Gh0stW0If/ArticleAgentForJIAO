/**
 * Europe PMC 客户端测试。**全部用注入的 fetch 桩，不触网。**
 *
 * 夹具取自真实响应（`10.1186/s13063-015-0857-0` 的 `authorAffiliationDetailsList` 形态）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createEuropePmcClient, normalizeDoi } from '../client.ts';

/** 造一个 fetch 桩：返回给定的 JSON，并记录请求 URL。 */
const stubFetch = (payload: unknown, status = 200) => {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; },
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const realShape = {
  resultList: {
    result: [{
      doi: '10.1186/s13063-015-0857-0',
      title: 'Acupuncture for Chronic Severe Functional Constipation: A Randomized Trial.',
      pubYear: '2016',
      pmid: '27056817',
      pmcid: 'PMC4837519',
      journalInfo: { journal: { title: 'Trials', medlineAbbreviation: 'Trials' } },
      authorList: {
        author: [
          { fullName: 'Kim JE', authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: 'Korea Institute of Oriental Medicine, Daejeon, South Korea. eujuki@gmail.com.' }] } },
          { fullName: 'Choi SM', authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: 'KIOM, Daejeon, South Korea. smchoi@kiom.re.kr.' }] } },
          /* 兼容老结构：邮箱挂在 author.affiliation 上 */
          { fullName: 'Lee MH', affiliation: 'Some Univ. minimarine@hanmail.net.' },
        ],
      },
    }],
  },
};

describe('europepmc — 客户端', () => {
  it('解析题名/期刊/年份/pmid，并收齐所有作者邮箱', async () => {
    const { impl, calls } = stubFetch(realShape);
    const c = createEuropePmcClient({ fetchImpl: impl });
    const w = await c.byDoi('10.1186/s13063-015-0857-0');
    expect(w).not.toBeNull();
    expect(w!.title).toBe('Acupuncture for Chronic Severe Functional Constipation: A Randomized Trial.');
    expect(w!.journal).toBe('Trials');
    expect(w!.pubYear).toBe('2016');
    expect(w!.pmid).toBe('27056817');
    expect(w!.authorEmails).toEqual(['eujuki@gmail.com', 'smchoi@kiom.re.kr', 'minimarine@hanmail.net']);
    /* 查询串必须把 DOI 用引号包住（Europe PMC 的语法） */
    expect(calls[0]).toContain(encodeURIComponent('DOI:"10.1186/s13063-015-0857-0"'));
  });

  it('未收录 → 返回 null（不是抛错）', async () => {
    const { impl } = stubFetch({ resultList: { result: [] } });
    const c = createEuropePmcClient({ fetchImpl: impl });
    expect(await c.byDoi('10.9999/nonexistent')).toBeNull();
  });

  it('4xx 直接返回 null 且不重试；5xx 会重试后抛错', async () => {
    const bad4 = stubFetch({}, 404);
    const s4 = vi.fn();
    expect(await createEuropePmcClient({ fetchImpl: bad4.impl, sleepImpl: s4 }).byDoi('10.1/x')).toBeNull();
    expect(bad4.calls.length).toBe(1);
    expect(s4).not.toHaveBeenCalled();

    const bad5 = stubFetch({}, 503);
    const sleep = vi.fn(async () => {});
    await expect(createEuropePmcClient({ fetchImpl: bad5.impl, retries: 2, sleepImpl: sleep }).byDoi('10.1/x'))
      .rejects.toThrow(/503/);
    expect(bad5.calls.length).toBe(3);
  });

  it('DOI 规范化：URL 前缀与 doi: 前缀都被剥掉', async () => {
    expect(normalizeDoi('https://doi.org/10.1136/acupmed-2015-010950')).toBe('10.1136/acupmed-2015-010950');
    expect(normalizeDoi('http://dx.doi.org/10.1/x')).toBe('10.1/x');
    expect(normalizeDoi('doi: 10.1/x')).toBe('10.1/x');
    const { impl } = stubFetch({ resultList: { result: [] } });
    const c = createEuropePmcClient({ fetchImpl: impl });
    expect(await c.byDoi('')).toBeNull();
  });

  it('题名里的 HTML 实体被解码', async () => {
    const { impl } = stubFetch({ resultList: { result: [{ doi: '10.1/x', title: 'Pain &amp; anxiety in &lt;children&gt;' }] } });
    const c = createEuropePmcClient({ fetchImpl: impl });
    const w = await c.byDoi('10.1/x');
    expect(w!.title).toBe('Pain & anxiety in <children>');
  });

  /**
   * ⚠️ 实测踩过：Europe PMC 的题名里会夹**内联标签**——2023-02 返回的是
   * `… Controlled, 2 <b>×</b> 2 Factorial Trial.`，不清理就会把 `<b>` 写进产物，
   * 使该篇题名从"半分"掉成"错"（A/B 实测 1 篇退步就是这么来的）。
   */
  it('题名里的内联标签被剥离（2023-02 的真实形态）', async () => {
    const { impl } = stubFetch({
      resultList: {
        result: [{
          doi: '10.1/x',
          title: 'Acupuncture and Doxylamine–Pyridoxine for Nausea and Vomiting in Pregnancy : A Randomized, Controlled, 2 <b>×</b> 2 Factorial Trial.',
        }],
      },
    });
    const c = createEuropePmcClient({ fetchImpl: impl });
    const w = await c.byDoi('10.1/x');
    expect(w!.title).not.toContain('<b>');
    expect(w!.title).toContain('2 × 2 Factorial Trial');
  });
});
