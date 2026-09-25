/**
 * tools/export_review.test.mjs — 导出链路单测
 *
 * 覆盖两段纯逻辑：
 *   · tools/lib/xlsxwrite.mjs —— ZIP + OOXML 写入（用仓库自己的读器往返验证）
 *   · tools/export_review.mjs —— 字段视图摊平成表（分歧判定、机器值、批量、CSV 转义）
 *
 * 为什么值得单测：这两段出错的方式都很隐蔽——xlsx 坏了自己不一定打得开才发现，
 * 表格串列则要人工比对才看得出来。
 *
 * 列位置一律**按表头查**，不写死下标：表头是给导回用的稳定契约（见 import_review.mjs），
 * 写死下标的话加一列就得改一堆断言，而且容易改漏。
 */

import { describe, it, expect } from 'vitest';
import { buildXlsx, STYLE } from './lib/xlsxwrite.mjs';
import { readWorkbook, makeGrid, readZipEntry } from './lib/xlsx.mjs';
import { buildReviewExport, toCsv, csvBuffer, exportFileName } from './export_review.mjs';

/* ------------------------------ 夹具 ------------------------------ */

const field = (over) => ({
  fieldPath: 'x',
  key: 'x',
  label: '字段',
  raw: '',
  decidedBy: 'model',
  overridden: false,
  inGold: true,
  ...over,
});

const GROUPS = [
  {
    id: 'article',
    title: '文章级（LLM 抽取）',
    fields: [
      field({ fieldPath: 'country', key: 'country', label: '国家', raw: 'Turkey', evidence: [{ page: 2, quote: 'carried out in Ankara, Turkey' }] }),
      // 有分歧：结论不同 → 不生效，保留机器原值
      field({
        fieldPath: 'condition', key: 'condition', label: '疾病名称', raw: 'Turkey', reviewStatus: 'disputed',
        reviews: [
          { reviewer: '乙', action: 'override', raw: 'China' },
          { reviewer: '甲', action: 'override', raw: 'Spain' },
        ],
      }),
      // 一致 → 生效
      field({
        fieldPath: 'title', key: 'title', label: '题目', raw: 'T-new', decidedBy: 'human', overridden: true,
        llmRaw: 'T-old', reviewStatus: 'agreed',
        reviews: [
          { reviewer: '甲', action: 'override', raw: 'T-new' },
          { reviewer: '乙', action: 'override', raw: 'T-new' },
        ],
      }),
    ],
  },
  { id: 'cmp-0', title: '比较组 1', fields: [field({ fieldPath: 'comparisons.0.deqi', key: 'deqi', label: '得气', raw: '1' })] },
  { id: 'studyOutcomes', title: 'Sheet2 结局分类', fields: [field({ fieldPath: 'studyOutcomes.outcomePain', key: 'outcomePain', label: '疼痛类', raw: 'VAS' })] },
  { id: 'out-0', title: '结局 1', fields: [field({ fieldPath: 'outcomes.0.outcome.name', key: 'name', label: '结局名称', raw: 'Pain' })] },
  { id: 'otherOutcomes', title: '其他结局', fields: [field({ fieldPath: 'outcomePlan.otherOutcomes.0', key: 'other', label: '其他', raw: 'x' })] },
  // 不导出：候选结局还没成为正式行
  { id: 'candidates', title: '待纳入', fields: [field({ fieldPath: 'candidate.0', key: 'c', label: '候选' })] },
];

const SUBJECT = { year: '2019', study: '2019-01', groups: GROUPS, headerOf: { country: '国家', condition: '疾病名称', title: '题目', deqi: '得气' } };
const OPTS = { label: '2019_2019-01', subjects: [SUBJECT], generatedAt: '2026-09-25T00:00:00.000Z' };

/** 表头文字 → 下标。 */
const cols = (rows) => rows[0].map((c) => (c && typeof c === 'object' ? c.v : c));
const at = (rows, name) => cols(rows).indexOf(name);
const cell = (row, i) => (row[i] && typeof row[i] === 'object' ? row[i].v : row[i]);

/* ------------------------------ xlsx 写入 ------------------------------ */

describe('xlsxwrite — 写出的 xlsx 能被读回', () => {
  const build = () => buildXlsx([
    { name: '核对汇总', rows: [['指标', '值'], ['研究', '2019 / 2019-01']] },
    { name: 'Sheet1', rows: [['a', 'b'], ['1', '2']] },
  ]);

  it('产出合法 ZIP（PK 头）且工作表名与内容往返一致', () => {
    const buf = build();
    expect(buf.subarray(0, 2).toString('hex')).toBe('504b');
    const wb = readWorkbook(buf);
    expect(wb.sheetNames).toEqual(['核对汇总', 'Sheet1']);
  });

  it('XML 特殊字符与换行原样保留（& < > 引号）', () => {
    const buf = buildXlsx([{ name: 'S', rows: [['h'], ['A & B <c> "d" \'e\'']] }]);
    const wb = readWorkbook(buf);
    expect(makeGrid(wb.sheets[0].rows).at(2, 0)).toBe('A & B <c> "d" \'e\'');
  });

  it('剥离 XML 非法控制字符（来自 PDF 的 quote 里真的有）', () => {
    const buf = buildXlsx([{ name: 'S', rows: [['h'], ['a\u0000b\u0007c\u001Fd']] }]);
    const wb = readWorkbook(buf);
    expect(makeGrid(wb.sheets[0].rows).at(2, 0)).toBe('abcd');
  });

  it('超长文本按 Excel 上限截断并留标记', () => {
    const buf = buildXlsx([{ name: 'S', rows: [['h'], ['x'.repeat(40000)]] }]);
    const wb = readWorkbook(buf);
    const v = makeGrid(wb.sheets[0].rows).at(2, 0);
    expect(v.length).toBeLessThanOrEqual(32767);
    expect(v.endsWith('…[已截断]')).toBe(true);
  });

  it('工作表名净化：非法字符替换、空名兜底', () => {
    const buf = buildXlsx([
      { name: 'a/b:c*d?e[f]g', rows: [['h']] },
      { name: '', rows: [['h']] },
    ]);
    const wb = readWorkbook(buf);
    expect(wb.sheetNames[0]).toBe('a_b_c_d_e_f_g');
    expect(wb.sheetNames[1]).toBe('Sheet2');
  });

  it('首行强制表头样式；显式传入的样式按格生效', () => {
    const buf = buildXlsx([{ name: 'S', rows: [['h'], [{ v: 'x', s: STYLE.DISPUTED }]] }]);
    const xml = readZipEntry(buf, 'xl/worksheets/sheet1.xml').toString('utf8');
    expect(xml).toContain('<c r="A1" s="1"');
    expect(xml).toContain('<c r="A2" s="3"');
  });

  it('没有工作表时明确报错，而不是产出坏文件', () => {
    expect(() => buildXlsx([])).toThrow(/至少要有一个工作表/);
  });
});

/* ------------------------------ 导出摊平 ------------------------------ */

describe('export_review — 摊成表（单篇）', () => {
  const out = buildReviewExport(OPTS);
  const sheetOf = (n) => out.sheets.find((s) => s.name === n);
  const rowFor = (n, fieldPath) => {
    const rows = sheetOf(n).rows;
    const p = at(rows, 'fieldPath');
    const i = rows.findIndex((r) => cell(r, p) === fieldPath);
    return i < 0 ? null : rows[i];
  };

  it('四张工作表且顺序为 核对汇总 / Sheet1 / Sheet2 / Sheet3', () => {
    expect(out.sheets.map((s) => s.name)).toEqual(['核对汇总', 'Sheet1', 'Sheet2', 'Sheet3']);
  });

  it('列结构：标识列 + 基础列 + 每位核对人三列 + 收尾列', () => {
    expect(cols(sheetOf('Sheet1').rows)).toEqual([
      '工作表', '年份', '研究', '所在行', '字段', '原始列', 'fieldPath', '机器值', '机器证据',
      '甲 · 值', '甲 · 动作', '甲 · 备注', '乙 · 值', '乙 · 动作', '乙 · 备注',
      '核对状态', '采用值', '是否改动',
    ]);
  });

  it('核对人列按名字排序（跨研究、跨多次导出都稳定，导回才能对得上表头）', () => {
    // localeCompare 对中文按**拼音**排：甲(jiǎ) 在 乙(yǐ) 之前
    expect(out.columns.slice(9, 12)).toEqual(['甲 · 值', '甲 · 动作', '甲 · 备注']);
    expect(out.columns.slice(12, 15)).toEqual(['乙 · 值', '乙 · 动作', '乙 · 备注']);
  });

  it('按所属表分组：article/cmp → Sheet1，studyOutcomes → Sheet2，out/other → Sheet3', () => {
    expect(rowFor('Sheet1', 'country')).toBeTruthy();
    expect(rowFor('Sheet1', 'comparisons.0.deqi')).toBeTruthy();
    expect(rowFor('Sheet2', 'studyOutcomes.outcomePain')).toBeTruthy();
    expect(rowFor('Sheet3', 'outcomes.0.outcome.name')).toBeTruthy();
    expect(rowFor('Sheet3', 'outcomePlan.otherOutcomes.0')).toBeTruthy();
  });

  it('不导出候选结局（它还不是正式行）', () => {
    const all = out.sheets.flatMap((s) => s.rows).flat().map((c) => cell([c], 0));
    expect(all).not.toContain('candidate.0');
  });

  it('分歧：状态标出、采用值仍是机器原值、整行标红', () => {
    const rows = sheetOf('Sheet1').rows;
    const row = rowFor('Sheet1', 'condition');
    expect(cell(row, at(rows, '核对状态'))).toBe('有分歧');
    expect(cell(row, at(rows, '采用值'))).toBe('Turkey');   // 采用值 = 机器原值
    expect(cell(row, at(rows, '是否改动'))).toBe('');        // 不算"已改动"
    expect(row.every((c) => typeof c === 'object' && c.s === STYLE.DISPUTED)).toBe(true);
  });

  it('一致：采用人工值、保留机器原值、标记为已改动', () => {
    const rows = sheetOf('Sheet1').rows;
    const row = rowFor('Sheet1', 'title');
    expect(cell(row, at(rows, '机器值'))).toBe('T-old');
    expect(cell(row, at(rows, '核对状态'))).toBe('一致');
    expect(cell(row, at(rows, '采用值'))).toBe('T-new');
    expect(cell(row, at(rows, '是否改动'))).toBe('是');
  });

  it('未核对：状态为「未核对」、无人工意见', () => {
    const rows = sheetOf('Sheet1').rows;
    const row = rowFor('Sheet1', 'country');
    expect(cell(row, at(rows, '核对状态'))).toBe('未核对');
    for (const r of ['甲 · 值', '甲 · 动作', '甲 · 备注', '乙 · 值', '乙 · 动作', '乙 · 备注']) {
      expect(cell(row, at(rows, r))).toBe('');
    }
  });

  it('机器无值、人工补录时明确写出，而不是留空', () => {
    const g = [{ id: 'article', title: 'A', fields: [field({ fieldPath: 'doi', key: 'doi', label: 'DOI', raw: '10.1/x', decidedBy: 'human', reviewStatus: 'single', reviews: [{ reviewer: '甲', action: 'add', raw: '10.1/x' }] })] }];
    const o = buildReviewExport({ label: 'x', subjects: [{ ...SUBJECT, groups: g }] });
    const rows = o.sheets[1].rows;
    expect(cell(rows[1], at(rows, '机器值'))).toBe('（机器无值，人工补录）');
  });

  it('自算统计：四态计数与已改动数', () => {
    expect(out.stats).toMatchObject({ total: 7, agreed: 1, disputed: 1, single: 0, machineOnly: 5, reviewed: 2, changed: 1 });
  });

  it('汇总表含范围、逐人统计、两两一致率与待仲裁清单（机器值是真的）', () => {
    const rows = sheetOf('核对汇总').rows;
    const flat = rows.flat().join('\n');
    expect(flat).toContain('2019_2019-01');
    expect(flat).toContain('两两一致率');
    const i = rows.findIndex((r) => r[0] === '年份' && r[2] === 'fieldPath');
    expect(i).toBeGreaterThan(0);
    expect(rows[i + 1][2]).toBe('condition');
    expect(rows[i + 1][3]).toBe('Turkey');   // 曾因 summary.machineRaw 恒为 null 显示成「（无）」
  });
});

describe('export_review — 批量（多研究）', () => {
  const subj2 = { year: '2019', study: '2019-02', groups: [{ id: 'article', title: '文章级', fields: [field({ fieldPath: 'country', key: 'country', label: '国家', raw: 'China' })] }] };
  const out = buildReviewExport({ label: '2019_全部', subjects: [SUBJECT, subj2], generatedAt: '2026-09-25T00:00:00.000Z' });
  const rows = out.sheets.find((s) => s.name === 'Sheet1').rows;

  it('每行带年份与研究，用于筛选/透视', () => {
    const iy = at(rows, '年份');
    const is = at(rows, '研究');
    const studies = new Set(rows.slice(1).map((r) => cell(r, is)));
    expect(studies.has('2019-01')).toBe(true);
    expect(studies.has('2019-02')).toBe(true);
    expect(rows.slice(1).every((r) => cell(r, iy) === '2019')).toBe(true);
  });

  it('两篇的同名字段各占一行，不会互相覆盖', () => {
    const p = at(rows, 'fieldPath');
    const s = at(rows, '研究');
    const hit = rows.filter((r) => cell(r, p) === 'country');
    expect(hit.map((r) => `${cell(r, s)}=${cell(r, at(rows, '采用值'))}`).sort())
      .toEqual(['2019-01=Turkey', '2019-02=China']);
  });

  it('汇总表写研究数与范围', () => {
    const sum = out.sheets.find((s) => s.name === '核对汇总').rows;
    expect(sum.some((r) => r[0] === '研究数' && r[1] === '2')).toBe(true);
    expect(sum.some((r) => r[0] === '导出范围' && String(r[1]).includes('2019_全部'))).toBe(true);
  });

  it('跨研究的同名字段不会在一致率里串味', () => {
    // 甲/乙 只在 2019-01 有意见（condition + title 两个字段）；
    // 2019-02 也有个叫 country 的字段，但不带意见 → 不该进分母
    const pair = out.pairwise.find((p) => [p.a, p.b].sort().join() === ['甲', '乙'].sort().join());
    expect(pair).toBeTruthy();
    expect(pair.common).toBe(2);
  });
});

/* ------------------------------ CSV ------------------------------ */

describe('export_review — CSV', () => {
  it('含逗号/引号/换行的单元格按 RFC4180 转义', () => {
    expect(toCsv([['a,b', 'c"d', 'e\nf']])).toBe('"a,b","c""d","e\nf"');
  });

  it('CSV 首列是工作表、表头与 XLSX 一致', () => {
    const out = buildReviewExport(OPTS);
    const head = out.csv.split('\r\n')[0];
    expect(head.startsWith('工作表,年份,研究,所在行,字段')).toBe(true);
    expect(head).toBe(out.columns.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(','));
  });

  it('CSV 行数覆盖三张数据表', () => {
    const out = buildReviewExport(OPTS);
    const expected = 1 + out.sheets.slice(1).reduce((n, s) => n + s.rows.length - 1, 0);
    const lines = out.csv.split('\r\n');
    // 证据里可能含换行 → 被引号包住，这里只断言下界
    expect(lines.length).toBeGreaterThanOrEqual(expected);
  });

  it('CSV 带 UTF-8 BOM（否则 Excel 打开中文乱码）', () => {
    const b = csvBuffer('a,b');
    expect([...b.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(b.subarray(3).toString('utf8')).toBe('a,b');
  });

  it('文件名去掉研究号前导 -，并清掉路径非法字符', () => {
    expect(exportFileName('2015_2015-01', 'xlsx', new Date('2026-09-25T00:00:00Z')))
      .toBe('人工核对_2015_2015-01_2026-09-25.xlsx');
    expect(exportFileName('全部年份', 'csv', new Date('2026-09-25T00:00:00Z')))
      .toBe('人工核对_全部年份_2026-09-25.csv');
    expect(exportFileName('a/b:c', 'csv', new Date('2026-09-25T00:00:00Z')))
      .toBe('人工核对_a_b_c_2026-09-25.csv');
  });
});
