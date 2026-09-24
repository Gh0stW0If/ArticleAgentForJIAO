/**
 * 核对 `field_labels.mjs` 的 Sheet3 列字母推算，与 legend（真实 xlsx 列）差在哪。
 * 用法：node tools/_label_col_audit.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexToCol } from './lib/xlsx.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const CODES = ['STUDYID','ARMNU','CONST','PVALNUM','OUTCOM','INSTRU','FOLTIM','FOLTIMN','FOLTIMU','BTESTI','BIESTI','BNINTE','BRR','EDEST','ENINTE','FNCONT'];

for (const y of YEARS) {
  const g = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
  const lg = JSON.parse(readFileSync(join(ROOT, 'build', 'legend', `${y}.json`), 'utf8'));
  const cols = g.field_definitions?.outcome_columns ?? [];
  const anchor = g.column_map?.sheet3?.anchorCol ?? 0;
  /* legend：列码 → 真实列字母 */
  const real = new Map();
  for (const f of lg.sheets?.Sheet3?.fields ?? []) {
    const hdrs = (f.headerLabels ?? []).map((h) => h.text);
    const code = hdrs[hdrs.length - 1];
    if (code) real.set(code, f.col);
  }
  const diffs = [];
  for (const c of CODES) {
    const i = cols.indexOf(c);
    if (i < 0) continue;
    const mine = indexToCol(anchor + i);
    const truth = real.get(c);
    if (truth && truth !== mine) diffs.push(`${c}: 推算 ${mine} vs 真实 ${truth}`);
  }
  console.log(`${y}  anchorCol=${anchor} outcome_columns=${cols.length} legend列=${real.size}  差异 ${diffs.length} 处`);
  if (diffs.length) console.log('      ' + diffs.slice(0, 6).join('   '));
  /* 额外：OI 列在不在 outcome_columns 里 */
  console.log(`      outcome_columns 含 OI？${cols.includes('OI')}   legend B 列 = ${[...real.entries()].find(([, l]) => l === 'B')?.[0] ?? '（无）'}`);
}

/* Sheet1：gold column_map 的 col 是真实 0 基索引吗？逐年看 trial_center_count */
console.log('\nSheet1 逐年列（trial_center_count / intervention）：');
for (const y of YEARS) {
  const g = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
  const a = g.column_map?.sheet1?.article?.trial_center_count?.col;
  const c = g.column_map?.sheet1?.comparison?.intervention?.col;
  console.log(`  ${y}  trial_center_count=${indexToCol(a)}  intervention=${indexToCol(c)}`);
}
void existsSync;
