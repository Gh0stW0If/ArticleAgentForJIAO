/**
 * `tools/lib/align.mjs` 的候选边与对齐语义。
 *
 * 重点是**把两个退化陷阱钉死**——这两个都是实测踩出来的：
 *
 *   ① `score >= MIN_SCORE` 太宽：`sameConstruct(+0.25) + sameSub(+0.15)` 就有 0.40，
 *      越过 0.34。1:1 贪心里只是排序偏好，但在覆盖率口径（多对一）下，
 *      因为所有结局行的叶子路径结构相同，漏抽会**退化成 0**
 *      （实测 2015 年 Sheet3 虚高到 77%）。
 *   ② 只看 `textScore >= MIN_SCORE || corr >= 2` 又太窄：金标准名字短、
 *      量表名塞在名字里（`BI score change`），产物写描述
 *      （`activities of daily living / BI: Barthel Index`），文本分只有 0.33。
 */

import { describe, it, expect } from 'vitest';
import { isOutcomeCandidate, outcomeSimilarity, MIN_SCORE } from './lib/align.mjs';

/** 造一条结局行。`nums` 是时点里的数值（数值佐证只看 |值| ≥ 10）。 */
const row = ({ name = '', instr = '', construct, sub, nums = [] } = {}) => ({
  outcome: {
    name: { raw: name },
    instrument: { raw: instr },
    ...(construct !== undefined ? { construct_code: { raw: construct } } : {}),
    ...(sub !== undefined ? { subconstruct_code: { raw: sub } } : {}),
  },
  timepoints: nums.length
    ? { end_of_treatment: { continuous: { experimental: Object.fromEntries(nums.map((n, i) => [`n${i}`, { raw: String(n) }])) } } }
    : {},
});

/** 产物侧是 camelCase —— 相似度函数直接读这两个键名。 */
const prow = ({ name = '', instr = '', construct, sub, nums = [] } = {}) => ({
  outcome: {
    name: { raw: name },
    instrument: { raw: instr },
    ...(construct !== undefined ? { constructCode: { raw: construct } } : {}),
    ...(sub !== undefined ? { subconstructCode: { raw: sub } } : {}),
  },
  timepoints: nums.length
    ? { endOfTreatment: { continuous: { experimental: Object.fromEntries(nums.map((n, i) => [`n${i}`, { raw: String(n) }])) } } }
    : {},
});

describe('isOutcomeCandidate —— 候选边', () => {
  it('陷阱①：construct+subconstruct 全同但**毫无文本重合**，不能成边', () => {
    const g = row({ name: 'fibromyalgia', construct: '2', sub: '1' });
    const p = prow({ name: 'nerve conduction velocity', construct: '2', sub: '1' });
    const s = outcomeSimilarity(g, p);
    // 加成确实把总分推过了阈值——所以**不能**只看 score
    expect(s.textScore).toBe(0);
    expect(s.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(isOutcomeCandidate(g, p)).toBe(false);
  });

  it('陷阱①：construct+subconstruct 全同且只有**一个**数值重合，仍然不能成边', () => {
    const g = row({ name: 'fibromyalgia', construct: '2', sub: '1', nums: [44] });
    const p = prow({ name: 'nerve conduction velocity', construct: '2', sub: '1', nums: [44] });
    const s = outcomeSimilarity(g, p);
    expect(s.corr).toBe(1);            // < 2，不加分
    expect(isOutcomeCandidate(g, p)).toBe(false);
  });

  it('数值佐证 ≥2 个数就能成边（哪怕名字完全不同）', () => {
    const g = row({ name: 'fibromyalgia', nums: [44, 51.2] });
    const p = prow({ name: 'nerve conduction velocity', nums: [44, 51.2] });
    expect(outcomeSimilarity(g, p).corr).toBe(2);
    expect(isOutcomeCandidate(g, p)).toBe(true);
  });

  it('陷阱②：金标准量表名塞在名字里、产物写描述——文本分 0.33 够不到阈值，但**要有边**', () => {
    // 这一对是 2025-01 的真实形状：明显同一个结局，文本分却差 0.01
    const g = row({ name: 'BI score change', instr: '', construct: '3', sub: '5' });
    const p = prow({ name: 'activities of daily living', instr: 'BI: Barthel Index', construct: '3', sub: '5' });
    const s = outcomeSimilarity(g, p);
    expect(s.textScore).toBeGreaterThan(0);
    expect(s.textScore).toBeLessThan(MIN_SCORE);   // 光看文本会被拒
    expect(s.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(isOutcomeCandidate(g, p)).toBe(true);   // ✓ 加成把它救了回来
  });

  it('名字高度相似 → 成边', () => {
    const g = row({ name: 'level of depression' });
    const p = prow({ name: 'level of depression' });
    expect(isOutcomeCandidate(g, p)).toBe(true);
  });

  it('完全不相干的两条 → 不成边', () => {
    const g = row({ name: 'quality of life', instr: 'SF-36' });
    const p = prow({ name: 'residual urine volume' });
    expect(isOutcomeCandidate(g, p)).toBe(false);
  });

  it('阈值本身没被偷偷改掉（口径变更必须是有意的）', () => {
    expect(MIN_SCORE).toBe(0.34);
  });
});
