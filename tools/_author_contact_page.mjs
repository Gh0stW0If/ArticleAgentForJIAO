/**
 * 假设检验：`author_contact` 抽不到，是不是因为**邮箱不在首页**、而材料只取 `pages:[1,2]`？
 *
 * 做法：对每个"金标准确实是邮箱"的样本，用 PyMuPDF 逐页取文字、定位邮箱在**第几页**，
 * 再与"模型答得对不对""邮箱在不在 article-meta 的材料里"交叉制表。
 *
 * 这样能把三种原因分开：
 *   · 邮箱在第 1~2 页 → 材料覆盖到了，抽不到是模型/提示词问题；
 *   · 邮箱在第 3 页及以后 → **材料策略盲区**（正是要点检验的假设）；
 *   · 任何页都找不到 → 印在图里或字体编码坏（与页数无关）。
 *
 * 用法：node tools/_author_contact_page.mjs
 * 输出：build/author_contact_page.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rows = JSON.parse(readFileSync(join(ROOT, 'build', '_ac_rows.json'), 'utf8'))
  .filter((r) => r.emails && r.emails.length);

function pdfOf(year, id) {
  const dir = join(ROOT, 'Datas', 'articles', year);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.pdf')) continue;
    if (f.replace(/\.pdf$/i, '').replace(/^-+/, '') === id) return join(dir, f);
  }
  return null;
}

const jobs = [];
for (const r of rows) {
  const pdf = pdfOf(r.year, r.id);
  if (pdf) jobs.push({ year: r.year, id: r.id, pdf, emails: r.emails, verdict: r.verdict, inMat: r.inMat });
}

const tmp = mkdtempSync(join(tmpdir(), 'acpage-'));
const listFile = join(tmp, 'list.json');
const outFile = join(tmp, 'out.json');
const pyFile = join(tmp, 'probe.py');
writeFileSync(listFile, JSON.stringify(jobs.map((j) => ({ pdf: j.pdf, needles: j.emails }))), 'utf8');
writeFileSync(pyFile, `
import json, sys, pymupdf
jobs = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for j in jobs:
    doc = pymupdf.open(j['pdf'])
    pages = []
    for i, page in enumerate(doc):
        t = page.get_text()
        pages.append(''.join(t.lower().split()))
    found = []
    for n in j['needles']:
        hit_pages = [i + 1 for i, t in enumerate(pages) if n in t]
        found.append({'needle': n, 'pages': hit_pages})
    out.append({'pdf': j['pdf'], 'page_count': doc.page_count, 'found': found})
    doc.close()
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
`, 'utf8');

const r = spawnSync(join(ROOT, 'runtime', 'mineru', 'Scripts', 'python.exe'), [pyFile, listFile, outFile], {
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
if (r.status !== 0) { console.error(String(r.stderr).slice(0, 500)); process.exit(1); }
const out = JSON.parse(readFileSync(outFile, 'utf8'));
const byPdf = new Map(out.map((o) => [o.pdf, o]));

/** 邮箱落在第几页（取最小页号；找不到为 null）。 */
const rowsOut = [];
for (const j of jobs) {
  const o = byPdf.get(j.pdf);
  const pages = (o?.found ?? []).flatMap((f) => f.pages);
  const page = pages.length ? Math.min(...pages) : null;
  rowsOut.push({ year: j.year, id: j.id, verdict: j.verdict, inMat: j.inMat, page, pageCount: o?.page_count ?? 0, emails: j.emails });
}

const W = VERDICT_WEIGHT;
const bucket = (p) => (p === null ? '任何页都没有' : p <= 2 ? '第 1~2 页（材料覆盖得到）' : `第 ${p} 页（材料盲区）`);
const buckets = ['第 1~2 页（材料覆盖得到）', '任何页都没有'];
for (const r2 of rowsOut) { const b = bucket(r2.page); if (!buckets.includes(b)) buckets.push(b); }
buckets.sort((a, b) => (a.startsWith('第 1~2') ? -1 : b.startsWith('第 1~2') ? 1 : a.localeCompare(b)));

console.log(`\n══ 邮箱在第几页 × 模型答得对不对 ══（共 ${rowsOut.length} 条"金标准确实是邮箱"）\n`);
console.log('  位置'.padEnd(26), '条数   满分  半分   错   加权正确率');
for (const b of buckets) {
  const rs = rowsOut.filter((r2) => bucket(r2.page) === b);
  if (!rs.length) continue;
  const full = rs.filter((r2) => W[r2.verdict] === 1).length;
  const half = rs.filter((r2) => W[r2.verdict] === 0.5).length;
  const w = rs.reduce((a, r2) => a + (W[r2.verdict] ?? 0), 0);
  console.log('  ' + b.padEnd(26), String(rs.length).padStart(4),
    String(full).padStart(6), String(half).padStart(5), String(rs.length - full - half).padStart(5),
    `   ${((w / rs.length) * 100).toFixed(1)}%`);
}

/* 只看"机器答了 NR / 没答出来"的那些，它们分布在哪些页 */
const failed = rowsOut.filter((r2) => (W[r2.verdict] ?? 0) < 1);
console.log(`\n  只看"没拿满分"的 ${failed.length} 条：`);
for (const b of buckets) {
  const rs = failed.filter((r2) => bucket(r2.page) === b);
  if (rs.length) console.log(`   ${b}：${rs.length} 条`);
}

console.log('\n  ⚠ 在第 3 页及以后（材料盲区）的样本：');
for (const r2 of rowsOut.filter((x) => x.page !== null && x.page > 2).slice(0, 40)) {
  const w = W[r2.verdict] ?? 0;
  console.log(`   ${r2.id}  第 ${r2.page}/${r2.pageCount} 页  ${w === 1 ? '✅满分' : w === 0.5 ? '◐半分' : '❌错'}  ${String(r2.emails[0]).slice(0, 40)}`);
}

console.log('\n  任何页都找不到的（与页数无关）：');
for (const r2 of rowsOut.filter((x) => x.page === null).slice(0, 20)) {
  const w = W[r2.verdict] ?? 0;
  console.log(`   ${r2.id}  ${w === 1 ? '✅满分' : w === 0.5 ? '◐半分' : '❌错'}  ${String(r2.emails[0]).slice(0, 40)}`);
}

writeFileSync(join(ROOT, 'build', 'author_contact_page.json'),
  JSON.stringify({ at: new Date().toISOString(), rows: rowsOut }, null, 1), 'utf8');
console.log('\n明细 build/author_contact_page.json\n');
