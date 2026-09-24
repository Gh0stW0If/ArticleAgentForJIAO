/**
 * 一次性探针：gold `column_map.sheet1` 的 col 是索引还是列号？与 legend 的 col 字母是否一致？
 * 用法：node tools/_goldmap_crosscheck.mjs [year]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Y = process.argv[2] ?? '2020';
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${Y}.json`), 'utf8'));
const lg = JSON.parse(readFileSync(join(ROOT, 'build', 'legend', `${Y}.json`), 'utf8'));
const s1 = j.column_map.sheet1;
console.log('sheet1 段：', Object.keys(s1).join(', '));
for (const lvl of ['article', 'comparison']) {
  const m = s1[lvl] ?? {};
  const keys = Object.keys(m);
  console.log(`\n[${lvl}] ${keys.length} 项；前 5：`);
  for (const k of keys.slice(0, 5)) console.log('   ', k, '=>', JSON.stringify(m[k]).slice(0, 220));
  console.log('   末 3：');
  for (const k of keys.slice(-3)) console.log('   ', k, '=>', JSON.stringify(m[k]).slice(0, 220));
}
console.log('\nlegend Sheet1 前 6 项：');
for (const f of lg.sheets.Sheet1.fields.slice(0, 6)) console.log('   ', f.col, f.field, '| hdr=', (f.headerLabels ?? []).map((h) => h.text).join(' / ').slice(0, 80));
console.log('\nlegend Sheet1 中 治疗总次数/分类 三项：');
for (const f of lg.sheets.Sheet1.fields.filter((x) => /治疗总次数|留针时间|随访时间/.test(x.field))) console.log('   ', f.col, f.field, '| hdr=', (f.headerLabels ?? []).map((h) => h.text).join(' / ').slice(0, 90), '| codes=', JSON.stringify(f.codes));
