/**
 * PRECIS-2 结果导出：XLSX + 独立 HTML（05 §7）
 *
 * 产物：
 *   build/precis2/PRECIS2_<first>-<last>.xlsx
 *   build/precis2/PRECIS2_<first>-<last>.html
 *
 * XLSX 四个工作表（与 05 §7.2 对齐）：
 *   1. Horizontal Matrix —— 行=字段/九领域（每领域 score/evidence/rationale 三行），列=研究；
 *   2. Score Summary      —— 每篇一行：九领域数值、有效领域数、描述性总分/均值、备注；
 *   3. Source Audit       —— 每篇的 PDF/附件清单与使用状态；
 *   4. Scoring Guide      —— 标签定义、九领域问题、本批元信息。
 *
 * ⚠️ 总分/均值只用于数据管理，**不是** PRECIS-2 官方综合分（05 §8）。
 * ⚠️ HTML 只读、无外部依赖；XLSX 以 base64 内嵌，页面可直接下载。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildXlsx } from './lib/xlsxwrite.mjs';
import { DOMAINS } from './lib/precis2_gold.mjs';

const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = (() => {
  const out = { years: null, out: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--years') out.years = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
})();

const precisDir = join(ROOT, 'build', 'precis2');
const gold = existsSync(join(precisDir, 'gold.json'))
  ? JSON.parse(readFileSync(join(precisDir, 'gold.json'), 'utf8'))
  : { studies: [] };
const goldById = new Map(gold.studies.map((s) => [s.studyId, s]));

const years = args.years ?? readdirSync(precisDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
  .map((d) => d.name)
  .sort();

const records = [];
for (const year of years) {
  const dir = join(precisDir, year);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
    records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
}
records.sort((a, b) => a.studyId.localeCompare(b.studyId));
if (!records.length) {
  console.error('build/precis2 下没有机器评分产物');
  process.exit(2);
}

/** 读同篇的三张表抽取产物，仅用于矩阵里的人工可读上下文；缺失时留空。 */
const extractionOf = (studyId) => {
  const f = join(ROOT, 'build', 'extraction', studyId.slice(0, 4), `${studyId}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
};

const raw = (v) => (v && typeof v === 'object' && typeof v.raw === 'string' ? v.raw : '');
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

const contextOf = (rec) => {
  const ext = extractionOf(rec.studyId);
  const g = goldById.get(rec.studyId);
  const cmp = ext?.comparisons?.[0];
  return {
    title: raw(ext?.article?.title) || g?.title || '',
    // 正式发表年优先用 06（医生维护的基准）；抽取产物的年可能与卷期/在线年不一致，另起一行标出
    year: g?.year || raw(ext?.article?.publicationYear) || rec.studyId.slice(0, 4),
    extractedYear: raw(ext?.article?.publicationYear),
    doi: raw(ext?.article?.doi),
    country: raw(ext?.article?.country),
    condition: raw(ext?.article?.condition),
    journal: raw(ext?.article?.journal),
    intervention: raw(cmp?.intervention),
    comparator: raw(cmp?.control),
    design: 'Randomised controlled trial',
  };
};

const scoreCell = (d) => (d ? d.label ?? '' : '');
const numericCell = (d) => (d && d.numeric !== null && d.numeric !== undefined
  ? { v: d.numeric, t: 'n' }
  : '');

/** 描述性汇总（05 §8）：排除 N/A 与 AS；3-B/3-U 记 3。 */
const summaryOf = (rec) => {
  let scored = 0;
  let total = 0;
  const notes = [];
  for (const d of DOMAINS) {
    const r = rec.payload?.domains?.[d.key];
    const label = r?.label ?? '';
    if (!label) continue;
    if (label === 'N/A') { notes.push(`${d.en}: N/A`); continue; }
    if (r?.armSpecific) { notes.push(`${d.en}: ${label}`); continue; }
    if (r?.uncertain) notes.push(`${d.en}: 3-U`);
    if (r?.grounded === false && !r?.absenceBased) notes.push(`${d.en}: 未接地`);
    if (r?.numeric !== null && r?.numeric !== undefined) { scored++; total += r.numeric; }
  }
  return { scored, total, mean: scored ? Number((total / scored).toFixed(2)) : null, notes };
};

/** 该篇在 Datas/articles 下的文件清单。 */
const sourcesOf = (studyId) => {
  const dir = join(ROOT, 'Datas', 'articles', studyId.slice(0, 4));
  if (!existsSync(dir)) return [];
  const base = studyId;
  return readdirSync(dir)
    .filter((f) => f.startsWith(base) && /\.pdf$/i.test(f))
    .sort()
    .map((f) => ({
      file: f,
      role: /-(sup|supp|appendix)/i.test(f) ? 'supplement' : 'main article',
      use: /-(sup|supp|appendix)/i.test(f) ? 'not ingested（待补：本期只解析正文 PDF）' : 'used as MiniDoc input',
    }));
};

/* ------------------------------ Matrix ------------------------------ */

const ids = records.map((r) => r.studyId);
const matrix = [['Field / Study', ...ids]];

/** 一行：首列标签 + 每篇取值。 */
const pushRow = (label, valueOf) => {
  matrix.push([label, ...records.map((r) => text(valueOf(r)))]);
};

const ctx = new Map(records.map((r) => [r.studyId, contextOf(r)]));

pushRow('Study ID', (r) => r.studyId);
pushRow('Title', (r) => ctx.get(r.studyId).title);
pushRow('Formal publication year', (r) => ctx.get(r.studyId).year);
pushRow('Publication year note', (r) => {
  const c = ctx.get(r.studyId);
  return c.extractedYear && c.extractedYear !== c.year
    ? `抽取产物写 ${c.extractedYear}；06/编号为 ${c.year}（在线 vs 卷期？投稿前核）`
    : '';
});
pushRow('DOI', (r) => ctx.get(r.studyId).doi);
pushRow('Country', (r) => ctx.get(r.studyId).country);
pushRow('Clinical condition', (r) => ctx.get(r.studyId).condition);
pushRow('Acupuncture / acupoint modality', (r) => ctx.get(r.studyId).intervention);
pushRow('Comparator', (r) => ctx.get(r.studyId).comparator);
pushRow('Trial design', (r) => ctx.get(r.studyId).design);
pushRow('Target usual-care context', (r) => r.payload?.usualCareContext ?? '');

const ROW_KIND = new Map();
const mark = (labels, kind) => { for (const l of labels) ROW_KIND.set(l, kind); };
mark(['Study ID', 'Title', 'Formal publication year', 'Publication year note', 'DOI', 'Country', 'Clinical condition',
  'Acupuncture / acupoint modality', 'Comparator', 'Trial design', 'Target usual-care context'], 'extract');

for (const d of DOMAINS) {
  const scoreLabel = `${d.en} (${d.zh}) — score`;
  const evidenceLabel = `${d.en} — extracted evidence`;
  const rationaleLabel = `${d.en} — scoring rationale`;
  pushRow(scoreLabel, (r) => scoreCell(r.payload?.domains?.[d.key]));
  pushRow(evidenceLabel, (r) => r.payload?.domains?.[d.key]?.evidenceText ?? '');
  pushRow(rationaleLabel, (r) => r.payload?.domains?.[d.key]?.rationale ?? '');
  mark([scoreLabel], 'score');
  mark([evidenceLabel], 'evidence');
  mark([rationaleLabel], 'rationale');
}

pushRow('Conflicts / reporting issues', (r) => (r.payload?.conflicts ?? []).join(' ｜ '));
mark(['Conflicts / reporting issues'], 'extract');

/* --------------------------- Score Summary --------------------------- */

const summaryHeader = ['Study ID', 'Short title', ...DOMAINS.map((d) => d.en),
  'Valid domains', 'Descriptive total', 'Descriptive mean', 'Notes', 'Year', 'Source files'];
const summaryRows = [summaryHeader];
for (const r of records) {
  const s = summaryOf(r);
  const c = ctx.get(r.studyId);
  summaryRows.push([
    r.studyId,
    c.title.length > 90 ? `${c.title.slice(0, 90)}…` : c.title,
    ...DOMAINS.map((d) => numericCell(r.payload?.domains?.[d.key])),
    { v: s.scored, t: 'n' },
    s.scored ? { v: s.total, t: 'n' } : '',
    s.mean !== null ? { v: s.mean, t: 'n' } : '',
    s.notes.join('; '),
    c.year,
    sourcesOf(r.studyId).map((s2) => s2.file).join(', '),
  ]);
}
summaryRows.push([]);
summaryRows.push(['说明', 'Descriptive total/mean 仅用于数据管理，不是 PRECIS-2 官方综合分（05 §8）。N/A 与 AS 不计入；3-U 按 3 计入并在 Notes 标出。']);

/* ---------------------------- Source Audit ---------------------------- */

const auditRows = [['Study ID', 'Filename', 'Role', 'Use status', 'Audit note']];
for (const r of records) {
  const files = sourcesOf(r.studyId);
  if (!files.length) {
    auditRows.push([r.studyId, '—', '—', '—', '未在 Datas/articles 找到对应文件']);
    continue;
  }
  for (const f of files) {
    const note = f.role === 'supplement'
      ? '正文已解析；附件尚未纳入 MiniDoc（05 §2 要求用附件核对，下一阶段补）'
      : '作为 MiniDoc 输入解析；页码/表号证据见 Matrix';
    auditRows.push([r.studyId, f.file, f.role, f.use, note]);
  }
}

/* ---------------------------- Scoring Guide ---------------------------- */

const guideRows = [
  ['评分标签', '含义', '数值处理'],
  ['1', 'Very explanatory（极解释性）', '1'],
  ['2', 'Rather explanatory（偏解释性）', '2'],
  ['3-B', 'Genuine balance（真正平衡）', '3'],
  ['3-U', 'Insufficient / contradictory reporting（信息不足或矛盾）', '3（仅数据管理；必须标出）'],
  ['4', 'Rather pragmatic（偏实用性）', '4'],
  ['5', 'Very pragmatic（极实用性）', '5'],
  ['N/A', '不适用（05 §4.3：只允许灵活性-依从）', '排除'],
  ['AS: …', '按组分别评分', '排除'],
  [],
  ['领域', '问题'],
  ...DOMAINS.map((d) => [d.en, domainQuestion(d.key)]),
  [],
  ['本批', `研究 ${records.length} 篇：${ids[0]} … ${ids[ids.length - 1]}`],
  ['来源', '机器评分（precis2 SKILL）+ MiniDoc；人工金标准见 06 表 CT–DC 列'],
  ['提醒', '3-U 不是 3-B；N/A 不是"中间"；总分/均值不是官方结论。'],
];

function domainQuestion(key) {
  return {
    eligibility: '入组者与常规诊疗人群有多像？',
    recruitment: '超出常规诊疗路径的招募努力有多少？',
    setting: '试验场所与目标常规使用场所有多像？',
    organisation: '人员、专长、培训、设备与常规诊疗有多像？',
    flex_delivery: '操作者对"怎么实施"有多少裁量？',
    flex_adherence: '为保证依从做了多少额外努力？',
    follow_up: '随访接触与测量比常规诊疗多密集？',
    primary_outcome: '主要结局对参与者有多直接重要？',
    primary_analysis: '主要分析在多大程度上保留随机分组？',
  }[key] ?? '';
}

/* ------------------------------- XLSX ------------------------------- */

const workbook = buildXlsx([
  { name: 'Horizontal Matrix', rows: matrix, widths: [52, ...records.map(() => 46)], freeze: true },
  { name: 'Score Summary', rows: summaryRows, widths: [12, 60, ...DOMAINS.map(() => 16), 10, 12, 12, 46, 8, 40], freeze: true },
  { name: 'Source Audit', rows: auditRows, widths: [12, 42, 14, 34, 70], freeze: true },
  { name: 'Scoring Guide', rows: guideRows, widths: [24, 78, 28], freeze: true },
]);

const first = ids[0];
const last = ids[ids.length - 1];
const firstYear = first.slice(0, 4);
const lastYear = last.slice(0, 4);
const stem = firstYear === lastYear
  ? `PRECIS2_${firstYear}-${first.slice(5)}-${last.slice(5)}`
  : `PRECIS2_${firstYear}-${lastYear}_${first.slice(5)}-${last.slice(5)}`;
const outBase = args.out ?? join(precisDir, stem);
mkdirSync(dirname(outBase), { recursive: true });
const xlsxPath = `${outBase}.xlsx`;
const htmlPath = `${outBase}.html`;
writeFileSync(xlsxPath, workbook);

/* ------------------------------- HTML ------------------------------- */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const b64 = workbook.toString('base64');

const htmlRows = matrix.slice(1).map((row) => {
  const kind = ROW_KIND.get(row[0]) ?? 'extract';
  const cells = row.map((v, j) => (j === 0
    ? `<th scope="row">${esc(v)}</th>`
    : `<td>${esc(v)}</td>`)).join('');
  return `<tr class="k-${kind}">${cells}</tr>`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PRECIS-2 评分矩阵 ${esc(first)} – ${esc(last)}</title>
<style>
  :root{--border:#d6dbe3;--ink:#1f2937;--muted:#6b7280;--bg:#f5f6f8;--head:#eef1f5;--score:#fff7e6;--ev:#f3f8ff;--rat:#f6f3ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--border);padding:12px 18px}
  h1{margin:0 0 6px;font-size:17px}
  .meta{color:var(--muted);font-size:12px}
  .bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  button{font:inherit;padding:5px 12px;border:1px solid var(--border);background:#fff;border-radius:7px;cursor:pointer}
  button:hover{border-color:#9aa4b2}
  button.active{background:#1f2937;color:#fff;border-color:#1f2937}
  .wrap{overflow:auto;max-height:calc(100vh - 120px);padding:12px 18px 40px}
  table{border-collapse:separate;border-spacing:0;background:#fff;min-width:100%}
  th,td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px 9px;vertical-align:top;min-width:220px;max-width:420px;white-space:pre-wrap;overflow-wrap:anywhere}
  thead th{position:sticky;top:0;z-index:3;background:var(--head);font-size:12px}
  tbody th,tfoot th{position:sticky;left:0;z-index:2;background:#fafbfc;text-align:left;min-width:220px;max-width:260px}
  thead th:first-child{left:0;z-index:4;min-width:220px}
  tr.k-score th,tr.k-score td{background:var(--score)}
  tr.k-evidence td{background:var(--ev)}
  tr.k-rationale td{background:var(--rat)}
  tr.k-score th{font-weight:600}
  .hidden{display:none}
  .legend{margin:10px 0 0;color:var(--muted);font-size:12px}
  .legend code{background:#eef1f5;padding:0 4px;border-radius:4px}
  @media print{header{position:static}.bar{display:none}.wrap{max-height:none;overflow:visible}th,td{min-width:0}}
</style>
</head>
<body>
<header>
  <h1>PRECIS-2 九领域评分矩阵 · ${esc(first)} – ${esc(last)}</h1>
  <div class="meta">机器初评（precis2 SKILL）｜ ${records.length} 篇 ｜ 每领域三行：score / extracted evidence / scoring rationale</div>
  <div class="bar">
    <button data-mode="all" class="active">Show all</button>
    <button data-mode="extract">Extraction only</button>
    <button data-mode="scores">Scores &amp; rationales only</button>
    <button id="dl-xlsx">Download XLSX</button>
    <button id="dl-csv">Export visible table to CSV</button>
    <button id="print">Print / PDF</button>
  </div>
  <div class="legend">标签：<code>1</code> 极解释 · <code>2</code> 偏解释 · <code>3-B</code> 真正平衡 · <code>3-U</code> 信息不足/矛盾 · <code>4</code> 偏实用 · <code>5</code> 极实用 · <code>N/A</code> 不适用（仅灵活性-依从） · <code>AS:</code> 按组评分。3-U 不是 3-B；总分/均值不是官方结论。</div>
</header>
<div class="wrap">
<table id="t">
<thead><tr><th>Field / Study</th>${ids.map((id) => `<th>${esc(id)}</th>`).join('')}</tr></thead>
<tbody>
${htmlRows}
</tbody>
</table>
</div>
<script>
const XLSX_B64 = "${b64}";
const rows = [...document.querySelectorAll('#t tbody tr')];
const btn = (m) => document.querySelector('button[data-mode="' + m + '"]');
function show(mode){
  for (const r of rows){
    const k = [...r.classList].find(c => c.startsWith('k-'))?.slice(2) ?? 'extract';
    const on = mode === 'all'
      || (mode === 'extract' && k === 'extract')
      || (mode === 'scores' && (k === 'score' || k === 'evidence' || k === 'rationale'));
    r.classList.toggle('hidden', !on);
  }
  for (const m of ['all','extract','scores']) btn(m).classList.toggle('active', m === mode);
}
for (const m of ['all','extract','scores']) btn(m).onclick = () => show(m);
document.getElementById('dl-xlsx').onclick = () => {
  const bin = atob(XLSX_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const a = document.createElement('a');
  a.href = url; a.download = ${JSON.stringify(`${stem}.xlsx`)};
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
};
document.getElementById('dl-csv').onclick = () => {
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const lines = [];
  for (const tr of document.querySelectorAll('#t tr')){
    if (tr.classList.contains('hidden')) continue;
    lines.push([...tr.children].map(td => q(td.textContent)).join(','));
  }
  const blob = new Blob(['\\uFEFF' + lines.join('\\r\\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = ${JSON.stringify(`${stem}.csv`)};
  a.click();
};
document.getElementById('print').onclick = () => print();
</script>
</body>
</html>`;

writeFileSync(htmlPath, html, 'utf8');

console.log(`已导出 ${records.length} 篇：${first} – ${last}`);
console.log(`  XLSX ${xlsxPath} (${(workbook.length / 1024).toFixed(0)} KB)`);
console.log(`  HTML ${htmlPath} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
console.log(`  XLSX sheet: Horizontal Matrix / Score Summary / Source Audit / Scoring Guide`);
