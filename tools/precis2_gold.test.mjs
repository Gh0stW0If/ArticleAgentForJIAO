/**
 * PRECIS-2 金标准加载器的回归测试。
 *
 * 真实 06 表里有三类坑，必须钉死：
 *   ① 列布局：CT–DC 是九领域 + 总分，按列字母取，不按"第几个字段"猜；
 *   ② ID 漂移：A 列带 `-01` 比较组后缀，个别行还有跨年笔误（2022-05 写成 2024-05）；
 *   ③ 缺失语义：`/` 是 N/A，**不是 3**；空值是缺失，不进分母。
 */
import { describe, it, expect } from 'vitest';
import { makeGrid } from './lib/xlsx.mjs';
import {
  normalizeScore,
  titleSimilarity,
  matchRow,
  parseRows,
  DOMAIN_KEYS,
} from './lib/precis2_gold.mjs';

describe('normalizeScore', () => {
  it('数字 1–5', () => {
    expect(normalizeScore('2')).toMatchObject({ label: '2', numeric: 2 });
    expect(normalizeScore(5)).toMatchObject({ label: '5', numeric: 5 });
  });

  it('/ 是 N/A，不是 3', () => {
    expect(normalizeScore('/')).toMatchObject({ label: 'N/A', numeric: null });
    expect(normalizeScore('N/A')).toMatchObject({ label: 'N/A', numeric: null });
  });

  it('3-B / 3-U 按 05 归一化', () => {
    expect(normalizeScore('3-B')).toMatchObject({ label: '3-B', numeric: 3 });
    expect(normalizeScore('3-U')).toMatchObject({ label: '3-U', numeric: 3, uncertain: true });
  });

  it('空值与无法识别的值', () => {
    expect(normalizeScore('')).toMatchObject({ label: null, numeric: null });
    expect(normalizeScore('见正文')).toMatchObject({ invalid: true });
  });
});

describe('titleSimilarity', () => {
  it('忽略大小写、标点与换行', () => {
    expect(titleSimilarity('Acupuncture for pain', 'acupuncture  for PAIN!')).toBe(1);
  });

  it('不同题名分数低', () => {
    expect(titleSimilarity('Acupuncture for fibromyalgia', 'Surgery for knee osteoarthritis')).toBeLessThan(0.4);
  });
});

describe('matchRow', () => {
  const known = [
    { studyId: '2015-04', year: '2015', title: 'Acupuncture for chronic fatigue syndrome' },
    { studyId: '2024-05', year: '2024', title: 'Auricular acupressure for insomnia in dialysis' },
    { studyId: '2022-05', year: '2022', title: 'Different trial of manual acupuncture for pain' },
    { studyId: '2025-01', year: '2025', title: 'Acupuncture as adjunctive therapy for acute cerebral infarction: a randomized clinical trial' },
    { studyId: '2025-02', year: '2025', title: 'Acupuncture as adjunctive therapy for acute cerebral infarction: a randomized clinical trial' },
  ];

  it('A 列的 -01 后缀能对回文章 ID', () => {
    const row = { idA: '2015-04-01', idB: '2015-04', title: 'Acupuncture for chronic fatigue syndrome', year: '2015' };
    expect(matchRow(row, known).study?.studyId).toBe('2015-04');
  });

  it('跨年笔误靠标题纠正（B 写错年份）', () => {
    const row = { idA: '2022-05', idB: '2024-05', title: 'Auricular acupressure for insomnia in dialysis', year: '2022' };
    expect(matchRow(row, known).study?.studyId).toBe('2024-05');
  });

  it('同题并列时用 ID 打破，不随便取一个', () => {
    const row = { idA: '2025-01', idB: '2025-01', title: 'Acupuncture as adjunctive therapy for acute cerebral infarction: a randomized clinical trial', year: '2025' };
    expect(matchRow(row, known).study?.studyId).toBe('2025-01');
  });

  it('对不上时返回 null（不硬配）', () => {
    const row = { idA: '2019-99', idB: '2019-99', title: 'A completely unrelated paper about surgery', year: '2019' };
    expect(matchRow(row, known).study).toBeNull();
  });
});

describe('parseRows（列布局）', () => {
  /** 构造一行 107 列的网格：A/B/C/H/I + CT..DB + DC。 */
  const rowOf = (vals) => {
    const cells = new Array(107).fill('');
    cells[0] = vals.A ?? '';
    cells[1] = vals.B ?? '';
    cells[2] = vals.C ?? '';
    cells[7] = vals.H ?? '';
    cells[8] = vals.I ?? '';
    // CT=97 … DB=105
    const domainVals = [3, 4, 2, 3, 1, '/', 2, 5, 4];
    domainVals.forEach((v, i) => { cells[97 + i] = String(v); });
    cells[106] = '3.3333';
    return { r: 3, cells };
  };

  it('九领域按 CT–DB 取，总分取 DC；/ 归一化为 N/A', () => {
    const grid = makeGrid([rowOf({ A: '2015-01', B: '2015-01', C: 'EN009', H: 'T', I: '2015' })]);
    const rows = parseRows(grid);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(DOMAIN_KEYS.map((k) => r.domains[k].label)).toEqual(['3', '4', '2', '3', '1', 'N/A', '2', '5', '4']);
    expect(r.domains.flex_adherence.numeric).toBeNull();
    expect(r.total).toBeCloseTo(3.3333);
    expect(r.title).toBe('T');
  });

  it('表头行（无 YYYY-NN 编号）被跳过', () => {
    const cells = new Array(107).fill('');
    cells[0] = '序号';
    const grid = makeGrid([{ r: 2, cells }, rowOf({ A: '2015-01', B: '2015-01' })]);
    expect(parseRows(grid)).toHaveLength(1);
  });
});
