/**
 * tools/import_review.test.mjs — 导回链路单测
 *
 * 重点覆盖两类容易出事的逻辑：
 *   · **解析**：CSV 里的引号/内嵌换行、xlsx 往返、表头 BOM/空格
 *   · **判定**：动作现算（confirm/override/add）、空格子默认不删、对不上就报错
 *
 * 其中「导出 → xlsx → 读回 → 算差异」是一条真实的往返链路，
 * 单独用 fixture 拼表测不出「导出的表头导不回来」这类问题。
 */

import { describe, it, expect } from 'vitest';
import { buildReviewExport } from './export_review.mjs';
import { buildXlsx } from './lib/xlsxwrite.mjs';
import { parseCsv, readReviewTables, planImport, readSignature, HEAD } from './import_review.mjs';

/* ------------------------------ 夹具 ------------------------------ */

const field = (over) => ({
  fieldPath: 'x', key: 'x', label: '字段', raw: '', decidedBy: 'model', overridden: false, inGold: true, ...over,
});

/** 一篇带 甲/乙 两位核对人记录的字段视图。 */
const SUBJECT = {
  year: '2019',
  study: '2019-01',
  headerOf: {},
  groups: [{
    id: 'article',
    title: '文章级',
    fields: [
      field({ fieldPath: 'country', key: 'country', label: '国家', raw: 'Turkey' }),
      field({ fieldPath: 'condition', key: 'condition', label: '疾病名称', raw: 'Fibromyalgia' }),
      field({ fieldPath: 'doi', key: 'doi', label: 'DOI', raw: '', decidedBy: 'human', overridden: true, reviewStatus: 'single', reviews: [{ reviewer: '甲', action: 'add', raw: '10.1/old' }] }),
    ],
  }],
};

const buildTable = (reviewer, values) => ({
  tag: 'Sheet1',
  columns: ['工作表', '年份', '研究', '所在行', '字段', '原始列', 'fieldPath', '机器值', '机器证据',
    `${reviewer} · 值`, `${reviewer} · 动作`, `${reviewer} · 备注`, '核对状态', '采用值', '是否改动'],
  rows: values.map(([fieldPath, v, note = '']) =>
    ['Sheet1', '2019', '2019-01', '文章级', '字段', '', fieldPath, '', '', v, '', note, '未核对', '', '']),
});

const INDEX = () => new Map([
  ['2019/2019-01::country', { machineRaw: 'Turkey', hasMachine: true }],
  ['2019/2019-01::condition', { machineRaw: 'Fibromyalgia', hasMachine: true, existing: { raw: 'Fibromyalgia', action: 'confirm' } }],
  ['2019/2019-01::doi', { machineRaw: '', hasMachine: false, existing: { raw: '10.1/old', action: 'add' } }],
]);

/* ------------------------------ 解析 ------------------------------ */

describe('import_review — CSV 解析', () => {
  it('引号内的逗号与换行不切分', () => {
    const rows = parseCsv('a,b,c\n"x,1","y\n2",z\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x,1', 'y\n2', 'z']]);
  });

  it('"" 转义成单个引号', () => {
    expect(parseCsv('"他说""你好"""')).toEqual([['他说"你好"']]);
  });

  it('去掉 BOM、丢掉全空行（含只有分隔符的行）', () => {
    expect(parseCsv('\uFEFFa,b\n\n,\n')).toEqual([['a', 'b']]);
  });

  it('最后一行没有换行符也能收尾', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('import_review — 读表', () => {
  const SIGNED = { label: '2019_2019-01', scope: 'study', signer: '评审甲' };

  it('导出 → xlsx → 读回：表头与行数对得上（签名表自动跳过）', () => {
    const { sheets } = buildReviewExport({ ...SIGNED, subjects: [SUBJECT] });
    const tables = readReviewTables(buildXlsx(sheets), 'xlsx');
    // 只认有 fieldPath 列的数据表，跳过「核对汇总」与「签名」
    expect(tables.map((t) => t.tag)).toEqual(['Sheet1']);
    expect(tables[0].columns).toContain(HEAD.fieldPath);
    expect(tables[0].rows.length).toBe(3);
    expect(tables[0].rows.some((r) => r.includes('country'))).toBe(true);
  });

  it('导出 → csv → 读回：跳过顶部签名注释、按「工作表」切段', () => {
    const { csv, signature } = buildReviewExport({ ...SIGNED, subjects: [SUBJECT] });
    expect(csv.startsWith('# AA-REVIEW-SIGNATURE ')).toBe(true);
    const tables = readReviewTables(Buffer.from(csv, 'utf8'), 'csv');
    expect(tables.length).toBe(1);
    expect(tables[0].rows.length).toBe(3);
    // 注释行不能被当成表头
    expect(tables[0].columns[0]).toBe('工作表');
    expect(readSignature(Buffer.from(csv, 'utf8'), 'csv')).toEqual(signature);
  });

  it('表头带多余空格也能认出来', () => {
    const t = readReviewTables(Buffer.from('工作表, 年份 ,研究,fieldPath\nSheet1,2019,2019-01,x\n', 'utf8'), 'csv');
    expect(t.length).toBe(1);
  });

  it('表头不认识时明确报错，而不是当成 0 行静默通过', () => {
    expect(() => readReviewTables(Buffer.from('a,b\n1,2\n', 'utf8'), 'csv')).toThrow(/表头不认识/);
  });
});

describe('import_review — 读签名', () => {
  it('有签名：xlsx 与 csv 都能读回同一份', () => {
    const { sheets, csv, signature } = buildReviewExport({
      label: '2019_全部', scope: 'year', signer: '评审甲', subjects: [SUBJECT],
    });
    expect(readSignature(buildXlsx(sheets), 'xlsx')).toEqual(signature);
    expect(readSignature(Buffer.from(csv, 'utf8'), 'csv')).toEqual(signature);
    expect(signature.scope).toBe('year');
  });

  it('没签名（旧版导出的文件）返回 null，不报错', () => {
    const { sheets, csv } = buildReviewExport({ label: 'x', subjects: [SUBJECT] });
    expect(readSignature(buildXlsx(sheets), 'xlsx')).toBeNull();
    expect(readSignature(Buffer.from(csv, 'utf8'), 'csv')).toBeNull();
  });

  it('签名注释只在**顶部**生效：正文里以 # 开头的行不算签名', () => {
    const buf = Buffer.from('工作表,年份,研究,fieldPath\nSheet1,2019,2019-01,#not-a-signature\n', 'utf8');
    expect(readSignature(buf, 'csv')).toBeNull();
  });

  it('签名 JSON 损坏时返回 null，而不是抛异常', () => {
    const buf = Buffer.from('# AA-REVIEW-SIGNATURE {坏掉的}\n工作表,年份,研究,fieldPath\n', 'utf8');
    expect(readSignature(buf, 'csv')).toBeNull();
  });
});

/* ------------------------------ 判定 ------------------------------ */

describe('import_review — 差异判定', () => {
  it('值等于机器值 → confirm', () => {
    const r = planImport({ tables: [buildTable('甲', [['country', 'Turkey']])], reviewer: '甲', index: INDEX() });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ action: 'confirm', fieldPath: 'country', machineRaw: 'Turkey' });
  });

  it('值与机器值不同 → override（带出改前的值）', () => {
    const r = planImport({ tables: [buildTable('甲', [['condition', 'China']])], reviewer: '甲', index: INDEX() });
    expect(r.changes[0]).toMatchObject({ action: 'override', fieldPath: 'condition', raw: 'China', before: 'Fibromyalgia' });
  });

  it('机器本来没有值 → add', () => {
    const r = planImport({ tables: [buildTable('甲', [['doi', '10.1/new']])], reviewer: '甲', index: INDEX() });
    expect(r.changes[0]).toMatchObject({ action: 'add', fieldPath: 'doi', before: '10.1/old' });
  });

  it('值与已有标注相同 → 不计入变更', () => {
    const r = planImport({ tables: [buildTable('甲', [['condition', 'Fibromyalgia']])], reviewer: '甲', index: INDEX() });
    expect(r.changes).toHaveLength(0);
    expect(r.unchanged).toBe(1);
  });

  it('备注会一起带过来', () => {
    const r = planImport({ tables: [buildTable('甲', [['country', 'Spain', '与摘要不一致']])], reviewer: '甲', index: INDEX() });
    expect(r.changes[0].note).toBe('与摘要不一致');
  });

  it('空格子默认**不删**（避免误清空把人工工作弄丢）', () => {
    const r = planImport({ tables: [buildTable('甲', [['doi', '']])], reviewer: '甲', index: INDEX() });
    expect(r.changes).toHaveLength(0);
    expect(r.cleared).toHaveLength(0);
    expect(r.unchanged).toBe(1);
  });

  it('显式打开 retractCleared 才把空格子当作撤回', () => {
    const r = planImport({ tables: [buildTable('甲', [['doi', '']])], reviewer: '甲', index: INDEX(), retractCleared: true });
    expect(r.cleared).toHaveLength(1);
    expect(r.cleared[0]).toMatchObject({ fieldPath: 'doi', before: '10.1/old', retract: true });
  });

  it('对不上的字段进 errors 并带行号，不静默丢弃', () => {
    const r = planImport({ tables: [buildTable('甲', [['country', 'Spain'], ['already-retired', 'x']])], reviewer: '甲', index: INDEX() });
    expect(r.changes).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, fieldPath: 'already-retired' });
    expect(r.errors[0].reason).toMatch(/没有这个字段/);
  });

  it('缺该核对人的列时明确报错（而不是"0 处变更"让人以为成功了）', () => {
    const r = planImport({ tables: [buildTable('乙', [['country', 'Spain']])], reviewer: '甲', index: INDEX() });
    expect(r.changes).toHaveLength(0);
    expect(r.errors[0].reason).toMatch(/没有核对人「甲」的列/);
  });

  it('缺 fieldPath 的行单独报错', () => {
    const t = buildTable('甲', [['', 'x']]);
    const r = planImport({ tables: [t], reviewer: '甲', index: INDEX() });
    expect(r.errors[0].reason).toBe('缺 fieldPath');
  });

  it('多张表一起导回（Sheet1/2/3 各一段）', () => {
    const a = buildTable('甲', [['country', 'Spain']]);
    const b = { ...buildTable('甲', [['condition', 'China']]), tag: 'Sheet2' };
    const r = planImport({ tables: [a, b], reviewer: '甲', index: INDEX() });
    expect(r.changes.map((c) => c.fieldPath).sort()).toEqual(['condition', 'country']);
  });
});
