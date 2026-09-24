/**
 * 逐行核对 2015 Sheet3：原始表有多少行、gold 收了多少行、差在哪。
 * 用法：node tools/_sheet3_2015_audit.mjs
 */
import { readWorkbook, norm } from './lib/xlsx.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wb = readWorkbook(join(ROOT, 'Datas', 'label', '2015-6篇-0813.xlsx'));
const sh = wb.sheets['2'];
console.log(`Sheet3 名=${sh.name}  总行数=${sh.rows.length}`);
for (const r of sh.rows) {
  const c = (r.cells ?? []).map(norm);
  const a = c[0] ?? '';
  const i = c[8] ?? '';
  console.log(`  r=${String(r.r).padStart(2)}  A=${JSON.stringify(a).slice(0, 18).padEnd(20)} C=${JSON.stringify(c[2] ?? '').slice(0, 12).padEnd(14)} I=${JSON.stringify(i).slice(0, 34)}`);
}
const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', '2015.json'), 'utf8'));
console.log(`\ngold 2015 outcomes = ${gold.counts.outcomes}`);
for (const a of gold.articles) {
  console.log(`  ${a.article_id}  ${a.outcomes.length} 行：${a.outcomes.map((o) => `${o.literature_code?.raw}:${String(o.outcome?.name?.raw).slice(0, 20)}`).join(' | ')}`);
}
