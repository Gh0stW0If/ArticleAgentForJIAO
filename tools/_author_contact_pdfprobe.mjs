/**
 * "连全文都没有"的那批邮箱，到底是**扫描件/图片**，还是 **MinDoc 把块丢了**？
 *
 * 判据：拿 PyMuPDF 取 PDF 原生文字层全文，搜该邮箱。
 *   · 原生文字层有 → MinDoc/ingest 丢块（**可修**）；
 *   · 原生文字层也没有 → 真的是图片/扫描，或邮箱印在图里（**要 OCR/多模态才可能拿到**）。
 *
 * 用法：node tools/_author_contact_pdfprobe.mjs
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(ROOT, 'build', '_ac_rows.json'), 'utf8'));

/* 只查"连全文都没有"的那批 */
const targets = rows.filter((r) => r.gold && !r.inMat && !r.inFull && r.emails?.length);
console.log(`待查：${targets.length} 篇`);

/** id → PDF 路径（Datas/articles/<year>/<id>.pdf，容忍前导连字符）。 */
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
for (const t of targets) {
  const pdf = pdfOf(t.year, t.id);
  if (pdf) jobs.push({ ...t, pdf });
}

const tmp = mkdtempSync(join(tmpdir(), 'acpdf-'));
const listFile = join(tmp, 'list.json');
const outFile = join(tmp, 'out.json');
writeFileSync(listFile, JSON.stringify(jobs.map((j) => ({ pdf: j.pdf, needles: j.emails }))), 'utf8');

const py = `
import json, sys, pymupdf
jobs = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for j in jobs:
    doc = pymupdf.open(j['pdf'])
    text = ''.join(p.get_text() for p in doc).lower()
    flat = ''.join(text.split())
    hits = [n for n in j['needles'] if n in flat or n in text]
    out.append({'pdf': j['pdf'], 'pages': doc.page_count, 'chars': len(text), 'hits': hits})
    doc.close()
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
`;
const pyFile = join(tmp, 'probe.py');
writeFileSync(pyFile, py, 'utf8');
const r = spawnSync(join(ROOT, 'runtime', 'mineru', 'Scripts', 'python.exe'), [pyFile, listFile, outFile], {
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
if (r.status !== 0) { console.error(String(r.stderr).slice(0, 400)); process.exit(1); }
const out = JSON.parse(readFileSync(outFile, 'utf8'));
const byPdf = new Map(out.map((o) => [o.pdf, o]));

let inNative = 0; let notInNative = 0;
const rowsOut = [];
for (const j of jobs) {
  const o = byPdf.get(j.pdf);
  const hit = !!o && o.hits.length > 0;
  if (hit) inNative++; else notInNative++;
  rowsOut.push({ year: j.year, id: j.id, gold: j.gold, pages: o?.pages ?? 0, chars: o?.chars ?? 0, inNative: hit, emails: j.emails });
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ "连全文都没有"的 ${jobs.length} 篇：邮箱在不在 PDF 原生文字层？ ══\n`);
console.log(`  ✅ 原生文字层里**有** → ingest/MinDoc 丢块（可修）：${inNative}（${pc(inNative, jobs.length)}）`);
console.log(`  ❌ 原生文字层里**也没有** → 图片/扫描或印在图里：${notInNative}（${pc(notInNative, jobs.length)}）`);

console.log('\n  可修的（前 15）：');
for (const r of rowsOut.filter((x) => x.inNative).slice(0, 15)) {
  console.log(`   ${r.id}  ${String(r.gold).slice(0, 44)}`);
}
console.log('\n  真拿不到的（前 10）：');
for (const r of rowsOut.filter((x) => !x.inNative).slice(0, 10)) {
  console.log(`   ${r.id}  页数 ${r.pages} 字符 ${r.chars}  ${String(r.gold).slice(0, 40)}`);
}

writeFileSync(join(ROOT, 'build', 'author_contact_pdfprobe.json'),
  JSON.stringify({ at: new Date().toISOString(), total: jobs.length, inNative, notInNative, rows: rowsOut }, null, 1), 'utf8');
console.log(`\n明细 build/author_contact_pdfprobe.json\n`);
