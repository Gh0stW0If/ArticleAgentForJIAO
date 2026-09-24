/** 复核：治疗频次三列的"漏抽/过填"到底出在哪（与 _scheme_columns_direct.mjs 同逻辑，但打明细）。 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const codeOf = (o) => (o && typeof o === 'object' && 'code' in o && o.code ? String(o.code) : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';
const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const cols = ['frequency_desc', 'frequency_value', 'frequency_unit'];
const stat = Object.fromEntries(cols.map((c) => [c, { n: 0, miss: 0, over: 0, diff: 0, same: 0, bothNR: 0 }]));
const missSamples = { frequency_value: [], frequency_unit: [] };
const missingComp = [];

for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(d)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    const pf = join(d, `${a.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    const gcs = a.comparisons ?? []; const pcs = pred.comparisons ?? [];
    if (pcs.length !== gcs.length) missingComp.push(`${a.article_id}: 比较组数 金标准 ${gcs.length} vs 机器 ${pcs.length}`);
    for (let i = 0; i < gcs.length; i++) {
      const p = pcs[i];
      if (!p) continue;
      for (const k of cols) {
        const gLeaf = gcs[i][k]; const pLeaf = p[CAMEL(k)];
        const gv = raw(gLeaf); const pv = raw(pLeaf);
        const gc = codeOf(gLeaf); const pc = codeOf(pLeaf);
        const gSent = isSent(gv); const pSent = isSent(pv);
        const gHas = k.endsWith('_unit') ? !!gc : !gSent;
        const pHas = k.endsWith('_unit') ? !!pc : !pSent;
        const s = stat[k]; s.n++;
        if (gSent && pSent) { s.bothNR++; continue; }
        if (gHas && pHas) { if (String(gv).replace(/\s+/g, '') === String(pv).replace(/\s+/g, '')) s.same++; else s.diff++; continue; }
        if (gHas && !pHas) {
          s.miss++;
          if (missSamples[k] && missSamples[k].length < 10) missSamples[k].push(`${a.article_id} 比较组${i + 1}  金标准 ${JSON.stringify(gv)}/${JSON.stringify(gc)}  机器 ${JSON.stringify(pv)}/${JSON.stringify(pc)}  desc=${JSON.stringify(raw(gcs[i].frequency_desc).slice(0, 40))}`);
          continue;
        }
        if (!gHas && pHas) { s.over++; continue; }
      }
    }
  }
}

console.log('\n治疗频次三列明细：');
for (const k of cols) {
  const s = stat[k];
  console.log(`  ${k.padEnd(18)} 样本 ${s.n}｜一致报NR ${s.bothNR}｜值一致 ${s.same}｜值不同 ${s.diff}｜**漏抽 ${s.miss}**｜过填 ${s.over}`);
}
console.log('\n比较组数不一致的文章：', missingComp.length);
for (const m of missingComp.slice(0, 10)) console.log('  ' + m);
for (const k of ['frequency_value', 'frequency_unit']) {
  console.log(`\n${k} 漏抽样例：`);
  for (const x of missSamples[k]) console.log('  ' + x);
}
