/**
 * Europe PMC 比对测试。锁住三条策略：
 *   ① **只在"真前缀"时补全题名**（其余一律不补，避免把两篇不同论文混起来）；
 *   ② 题名/期刊/年份不一致时**只报告、不改值**；
 *   ③ 年份按四位数比（`2016-02-15` 与 `2016` 算一致）。
 */

import { describe, expect, it } from 'vitest';
import { titlePrefixGain, verifyWithEuropePmc } from '../verify.ts';
import type { EuropePmcWork } from '../client.ts';

const work = (over: Partial<EuropePmcWork> = {}): EuropePmcWork => ({
  doi: '10.1/x',
  title: 'Acupuncture for Chronic Severe Functional Constipation: A Randomized Trial.',
  journal: 'Annals of Internal Medicine',
  pubYear: '2016',
  authorEmails: [],
  ...over,
});

describe('europepmc — 题名补全的判据', () => {
  it('真是前缀且明显更短 → 补（实测最常见的失分形态）', () => {
    expect(titlePrefixGain(
      'Acupuncture for Chronic Severe Functional Constipation',
      'Acupuncture for Chronic Severe Functional Constipation: A Randomized Trial.',
    )).toBe(true);
  });

  it('只是标点/大小写差异 → 不补', () => {
    expect(titlePrefixGain('Effect of Acupuncture: A Trial', 'Effect of Acupuncture: A Trial.')).toBe(false);
  });

  it('两篇不同的论文 → 不补（这是"前缀"判据存在的意义）', () => {
    expect(titlePrefixGain(
      'Acupressure for frail older people in community dwellings',
      'Acupressure as adjuvant treatment for the inpatient management of nausea',
    )).toBe(false);
  });

  it('我们的更长 → 不补（不降级）', () => {
    expect(titlePrefixGain(
      'Acupuncture for Chronic Severe Functional Constipation: A Randomized Trial',
      'Acupuncture for Chronic Severe Functional Constipation',
    )).toBe(false);
  });

  it('过短的题名不作为前缀依据', () => {
    expect(titlePrefixGain('Acupuncture', 'Acupuncture for Chronic Pain: A Randomized Trial')).toBe(false);
  });
});

describe('europepmc — 比对结果', () => {
  it('题名是前缀 → 给出 titleCompletion，且题名一项算 match（副标题有无不算错）', () => {
    const v = verifyWithEuropePmc({ title: 'Acupuncture for Chronic Severe Functional Constipation', journal: 'Annals of Internal Medicine', pubYear: '2016' }, work());
    expect(v.titleCompletion?.to).toContain('A Randomized Trial');
    expect(v.comparisons.find((c) => c.field === 'title')!.verdict).toBe('match');
    expect(v.comparisons.find((c) => c.field === 'journal')!.verdict).toBe('match');
    expect(v.comparisons.find((c) => c.field === 'pubYear')!.verdict).toBe('match');
  });

  it('年份按四位数比：`2016-02-15` 与 `2016` 算一致', () => {
    const v = verifyWithEuropePmc({ pubYear: '2016-02-15' }, work());
    expect(v.comparisons.find((c) => c.field === 'pubYear')!.verdict).toBe('match');
  });

  it('期刊不一致 → mismatch 且记 note，但**不提供**任何覆盖', () => {
    const v = verifyWithEuropePmc({ journal: 'Trials' }, work());
    const j = v.comparisons.find((c) => c.field === 'journal')!;
    expect(j.verdict).toBe('mismatch');
    expect(j.ours).toBe('Trials');
    expect(j.theirs).toBe('Annals of Internal Medicine');
    expect(v.notes.some((n) => n.includes('不一致'))).toBe(true);
    /* 接口上根本没有"覆盖值"这种字段——策略是只报告不改值 */
    expect(Object.keys(v)).not.toContain('override');
  });

  it('EPMC 未收录 → found=false，三项都标 epmc_missing', () => {
    const v = verifyWithEuropePmc({ title: 'x' }, null);
    expect(v.found).toBe(false);
    expect(v.comparisons.every((c) => c.verdict === 'epmc_missing')).toBe(true);
    expect(v.notes.some((n) => n.includes('未收录'))).toBe(true);
  });

  it('本地没抽到 / EPMC 没给值 → 分别标 pdf_missing / epmc_missing', () => {
    /* 用解构剔除 journal，而不是传 `journal: undefined`——
       tsconfig 开了 exactOptionalPropertyTypes，显式 undefined 不算"省略"。 */
    const { journal: _drop, ...noJournal } = work();
    void _drop;
    const v = verifyWithEuropePmc({}, noJournal as EuropePmcWork);
    expect(v.comparisons.find((c) => c.field === 'journal')!.verdict).toBe('epmc_missing');
    expect(v.comparisons.find((c) => c.field === 'title')!.verdict).toBe('pdf_missing');
  });
});
