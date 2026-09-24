/**
 * 多出行的集中度：多出行到底集中在少数几篇，还是普遍存在。
 * 用法：node tools/_overfill_spread.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const rows = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const m = new Map((gold.articles ?? []).map((a) => [a.article_id, a]));
  for (const fn of readdirSync(xd)) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const g = m.get(id);
    if (!g) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const gO = g.outcomes ?? []; const pO = pred.outcomes ?? [];
    const { usedPred } = alignOutcomes(gO, pO);
    rows.push({ y, id, g: gO.length, p: pO.length, matched: usedPred.size, extra: pO.length - usedPred.size, missed: gO.length - usedPred.size });
  }
}
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const ex = rows.map((r) => r.extra).sort((a, b) => a - b);
console.log(`文章数 ${rows.length}`);
console.log(`每篇多出行数：中位 ${q(ex, 0.5)}  p75 ${q(ex, 0.75)}  p90 ${q(ex, 0.9)}  max ${ex[ex.length - 1]}  合计 ${ex.reduce((a, b) => a + b, 0)}`);
const top = [...rows].sort((a, b) => b.extra - a.extra);
const sum = (n) => top.slice(0, n).reduce((a, r) => a + r.extra, 0);
for (const n of [5, 10, 20, 40]) console.log(`  前 ${String(n).padStart(2)} 篇贡献多出行 ${String(sum(n)).padStart(4)} / ${ex.reduce((a, b) => a + b, 0)}（${((sum(n) / ex.reduce((a, b) => a + b, 0)) * 100).toFixed(0)}%）`);

console.log('\n多出行数 = 0 的文章：', rows.filter((r) => r.extra === 0).length);
console.log('金标准 0 行、机器有行：', rows.filter((r) => r.g === 0 && r.p > 0).length, '篇，共', rows.filter((r) => r.g === 0).reduce((a, r) => a + r.p, 0), '行');
console.log('机器行数 < 金标准行数：', rows.filter((r) => r.p < r.g).length, '篇，共少', rows.filter((r) => r.p < r.g).reduce((a, r) => a + (r.g - r.p), 0), '行');

/* 每篇金标准行数 & 机器行数分布 */
const gd = rows.map((r) => r.g).sort((a, b) => a - b);
console.log(`\n金标准每篇结局行数：中位 ${q(gd, 0.5)}  p90 ${q(gd, 0.9)}  max ${gd[gd.length - 1]}`);
const pd = rows.map((r) => r.p).sort((a, b) => a - b);
console.log(`机器每篇结局行数：  中位 ${q(pd, 0.5)}  p90 ${q(pd, 0.9)}  max ${pd[pd.length - 1]}`);
