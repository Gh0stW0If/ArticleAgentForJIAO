/**
 * 一次性探针：gold 里有没有「等级资料（categorical）」时点块的实际值？
 * 背景：`block_field_map` 的 cat1 键是 `DINFRI`，而真实 Excel 列代码是 `BRDINFRI`
 *       （多一个 R = 等级/Rank），需要确认这个前缀差异是否导致该块从未被填充。
 * 用法：node tools/_cat_block_probe.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
let rows = 0; let cat = 0; let catVal = 0; const samples = [];
const kinds = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of j.articles ?? []) for (const o of a.outcomes ?? []) {
    rows++;
    for (const [bn, bv] of Object.entries(o.timepoints ?? {})) {
      if (!bv || typeof bv !== 'object') continue;
      for (const k of Object.keys(bv)) kinds.set(k, (kinds.get(k) ?? 0) + 1);
      if (!('categorical' in bv)) continue;
      cat++;
      if (JSON.stringify(bv.categorical).includes('"raw"')) {
        catVal++;
        if (samples.length < 6) samples.push(`${y} ${a.article_id} ${bn}`);
      }
    }
  }
}
console.log(`结局行 ${rows}；含 categorical 块的时点 ${cat}；其中有实际值的 ${catVal}`);
console.log('时点块里出现过的结局类型：', [...kinds.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
console.log('有值的样例：', samples.join(' | ') || '（无）');
