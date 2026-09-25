/**
 * tools/export_review.test.mjs — 导出链路单测
 *
 * 覆盖两段纯逻辑：
 *   · tools/lib/xlsxwrite.mjs —— ZIP + OOXML 写入（用仓库自己的读器往返验证）
 *   · tools/export_review.mjs —— 字段视图摊平成表（分歧判定、机器值、CSV 转义）
 *
 * 为什么值得单测：这两段出错的方式都很隐蔽——xlsx 坏了自己不一定打得开才发现，
 * 表格串列则要人工比对才看得出来。
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

const OPTS = {
  year: '2019',
  study: '2019-01',
  groups: GROUPS,
  headerOf: { country: '国家', condition: '疾病名称', title: '题目', deqi: '得气' },
  reviewers: ['甲', '乙'],
  generatedAt: '2026-09-25T00:00:00.000Z',
};

/* ------------------------------ xlsx 写入 ------------------------------ */

describe('xlsxwrite — 写出的 xlsx 能被读回', () => {
  const build = () => buildXlsx([
    { name: '核对汇总', rows: [['指标', '值'], ['研究', '2019 / 2019-01']] },
    { name: 'Sheet1', rows: [['a', 'b'], ['1', '2']] },
  ]);

  it('产出合法 ZIP（PK 头）且工作表名与内容往返一致', () => {
    const buf = build();
    expect(buf.slice(0, 2).toString('hex')).toBe('504b');
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

  it('工作表名净化：非法字符替换、截到 31 字符、空名兜底', () => {
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

describe('export_review — 摊成表', () => {
  const out = buildReviewExport(OPTS);
  const sheetOf = (n) => out.sheets.find((s) => s.name === n);
  const rowFor = (n, fieldPath) => {
    const rows = sheetOf(n).rows;
    const i = rows.findIndex((r) => (r[4] && typeof r[4] === 'object' ? r[4].v : r[4]) === fieldPath);
    return i < 0 ? null : rows[i].map((c) => (c && typeof c === 'object' ? c.v : c));
  };

  it('四张工作表且顺序为 核对汇总 / Sheet1 / Sheet2 / Sheet3', () => {
    expect(out.sheets.map((s) => s.name)).toEqual(['核对汇总', 'Sheet1', 'Sheet2', 'Sheet3']);
  });

  it('列结构：基础列 + 每位核对人三列 + 收尾列', () => {
    expect(out.sheets[1].rows[0]).toEqual([
      '工作表', '所在行', '字段', '原始列', 'fieldPath', '机器值', '机器证据',
      '甲 · 值', '甲 · 动作', '甲 · 备注', '乙 · 值', '乙 · 动作', '乙 · 备注',
      '核对状态', '采用值', '是否改动',
    ]);
  });

  it('按所属表分组：article/cmp → Sheet1，studyOutcomes → Sheet2，out/other → Sheet3', () => {
    expect(sheetOf('Sheet1').rows.some((r) => r[4] === 'country')).toBe(true);
    expect(sheetOf('Sheet1').rows.some((r) => r[4] === 'comparisons.0.deqi')).toBe(true);
    expect(sheetOf('Sheet2').rows.some((r) => r[4] === 'studyOutcomes.outcomePain')).toBe(true);
    expect(sheetOf('Sheet3').rows.some((r) => r[4] === 'outcomes.0.outcome.name')).toBe(true);
    expect(sheetOf('Sheet3').rows.some((r) => r[4] === 'outcomePlan.otherOutcomes.0')).toBe(true);
  });

  it('不导出候选结局（它还不是正式行）', () => {
    const all = out.sheets.flatMap((s) => s.rows).flat();
    expect(all.some((c) => c && typeof c === 'object' && c.v === 'candidate.0')).toBe(false);
  });

  it('分歧：状态标出、采用值仍是机器原值、整行标红', () => {
    const row = rowFor('Sheet1', 'condition');
    expect(row[13]).toBe('有分歧');
    expect(row[14]).toBe('Turkey');            // 采用值 = 机器原值
    expect(row[15]).toBe('');                  // 不算"已改动"
    const raw = sheetOf('Sheet1').rows.find((r) => {
      const c = r[4];
      return (c && typeof c === 'object' ? c.v : c) === 'condition';
    });
    expect(raw.every((c) => typeof c === 'object' && c.s === STYLE.DISPUTED)).toBe(true);
  });

  it('一致：采用人工值、保留机器原值、标记为已改动', () => {
    const row = rowFor('Sheet1', 'title');
    expect(row[5]).toBe('T-old');              // 机器值 = LLM 原值
    expect(row[13]).toBe('一致');
    expect(row[14]).toBe('T-new');
    expect(row[15]).toBe('是');
  });

  it('未核对：状态为「未核对」、无人工意见', () => {
    const row = rowFor('Sheet1', 'country');
    expect(row[13]).toBe('未核对');
    expect(row.slice(7, 13)).toEqual(['', '', '', '', '', '']);
  });

  it('核对人按姓名排序稳定（甲/乙来自字段内顺序，列顺序以传入 reviewers 为准）', () => {
    expect(out.columns.slice(7, 10)).toEqual(['甲 · 值', '甲 · 动作', '甲 · 备注']);
  });

  it('核对汇总含进度、逐人统计、两两一致率与待仲裁清单', () => {
    const text = sheetOf('核对汇总').rows.flat().map((c) => (c && typeof c === 'object' ? c.v : c)).join('|');
    expect(text).toContain('2019 / 2019-01');
    expect(text).toContain('两两一致率');
    expect(text).toContain('待第三方仲裁');
    // 仲裁表里的机器值必须是真的（曾因 summary.machineRaw 恒为 null 显示成「（无）」）
    const rows = sheetOf('核对汇总').rows;
    const i = rows.findIndex((r) => r[0] === 'fieldPath' && r[1] === '机器值');
    expect(rows[i + 1][0]).toBe('condition');
    expect(rows[i + 1][1]).toBe('Turkey');
  });

  it('机器无值、人工补录时明确写出，而不是留空', () => {
    const g = [{ id: 'article', title: 'A', fields: [field({ fieldPath: 'doi', key: 'doi', label: 'DOI', raw: '10.1/x', decidedBy: 'human', reviewStatus: 'single', reviews: [{ reviewer: '甲', action: 'add', raw: '10.1/x' }] })] }];
    const o = buildReviewExport({ ...OPTS, groups: g });
    const row = o.sheets[1].rows[1].map((c) => (c && typeof c === 'object' ? c.v : c));
    expect(row[5]).toBe('（机器无值，人工补录）');
  });
});

/* ------------------------------ CSV ------------------------------ */

describe('export_review — CSV', () => {
  it('含逗号/引号/换行的单元格按 RFC4180 转义', () => {
    expect(toCsv([['a,b', 'c"d', 'e\nf']])).toBe('"a,b","c""d","e\nf"');
  });

  it('CSV 首列是工作表、行数等于三张表之和', () => {
    const out = buildReviewExport(OPTS);
    const lines = out.csv.split('\r\n');
    const expected = 1 + out.sheets.slice(1).reduce((n, s) => n + s.rows.length - 1, 0);
    // 证据里可能含换行 → 用引号内的换行不算行分隔，这里断言近似下界
    expect(lines.length).toBeGreaterThanOrEqual(expected);
    expect(lines[0].startsWith('工作表,所在行,字段')).toBe(true);
  });

  it('CSV 带 UTF-8 BOM（否则 Excel 打开中文乱码）', () => {
    const b = csvBuffer('a,b');
    expect([...b.slice(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(b.slice(3).toString('utf8')).toBe('a,b');
  });

  it('文件名带年份/研究号/日期，且去掉研究号前导 -', () => {
    const n = exportFileName('2015', '-2015-01', 'xlsx', new Date('2026-09-25T00:00:00Z'));
    expect(n).toBe('人工核对_2015_2015-01_2026-09-25.xlsx');
  });
});
