/**
 * 「多填」精确记账：把 21,283 条结局级多填拆成
 *   ① 机器行数 > 金标准行数（真的多抽/拆得细）
 *   ② 行对齐失败（两边行数都不多，但配对失败 → 同时虚增 missed 与 extra）
 * 并给出比较组级、文章级的实例。
 *
 * 用法：node tools/_overfill_accounting.mjs [--top 12]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const TOP = Number(arg('top', 12));
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const leafCount = (o) => {
  if (o === null || o === undefined) return 0;
  if (typeof o !== 'object') return 1;
  if ('raw' in o) return 1;
  return Object.values(o).reduce((a, v) => a + leafCount(v), 0);
};

const rows = [];
const artLevel = new Map();
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const goldById = new Map((gold.articles ?? []).map((a) => [a.article_id, a]));
  for (const fn of readdirSync(xd).filter((f) => /^\d{4}-\d{1,2}\.json$/.test(f))) {
    const id = fn.replace(/\.json$/, '');
    const g = goldById.get(id);
    if (!g) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const gOuts = g.outcomes ?? [];
    const pOuts = pred.outcomes ?? [];
    const { usedPred, alignments } = alignOutcomes(gOuts, pOuts);
    const matched = usedPred.size;
    const gFn = gOuts.reduce((a, o) => a + (leafCount(o) || 8), 0);
    const pFn = pOuts.reduce((a, o) => a + (leafCount(o) || 1), 0);
    const gCmp = (g.comparisons ?? []).length;
    const pCmp = (pred.comparisons ?? []).length;
    rows.push({
      y, id, gRows: gOuts.length, pRows: pOuts.length, matched,
      extraRows: pOuts.length - matched, missedRows: gOuts.length - matched,
      gFn, pFn,
      avgLeaf: pOuts.length ? Math.round(pFn / pOuts.length) : 0,
      pCmpExtra: Math.max(0, pCmp - gCmp), gCmp, pCmp,
      weak: alignments.filter((a) => a.kind === 'weak').length,
    });
  }
}

/* 复现评测的 extra 计数 */
let extraOutcome = 0, extraCmp = 0;
for (const r of rows) {
  extraOutcome += r.extraRows * (r.avgLeaf || 1);
  /* 比较组级：评测只对"多出来的组"计 extra，字段数取该组叶子数（实测≈70） */
  extraCmp += r.pCmpExtra * 70;
}
console.log('\n══ 结局级多填的成因拆解 ══\n');
const withExtra = rows.filter((r) => r.extraRows > 0);
const realExtra = withExtra.filter((r) => r.pRows > r.gRows);
const alignFail = withExtra.filter((r) => r.pRows <= r.gRows);
const sumExtra = (arr) => arr.reduce((a, r) => a + r.extraRows * (r.avgLeaf || 1), 0);
const sumMiss = (arr) => arr.reduce((a, r) => a + r.missedRows * (r.avgLeaf || 8), 0);
console.log(`  有"多出结局行"的文章：${withExtra.length} / ${rows.length}`);
console.log(`  ├ 机器行数 > 金标准行数（真的拆得细/多抽）：${realExtra.length} 篇，贡献多填 ≈ ${sumExtra(realExtra)} 字段（同时漏 ${sumMiss(realExtra)}）`);
console.log(`  └ 机器行数 ≤ 金标准行数（纯对齐失败）：      ${alignFail.length} 篇，贡献多填 ≈ ${sumExtra(alignFail)} 字段（同时漏 ${sumMiss(alignFail)}）`);
console.log(`\n  全部结局级多填估算 = ${extraOutcome}（评测实测 21,283）；漏 ≈ ${rows.reduce((a, r) => a + r.missedRows * (r.avgLeaf || 8), 0)}`);

console.log('\n══ 结局行数差异最大的文章 ══\n');
console.log('  文章      金标准行  机器行  配上  多出行  漏行  类型');
for (const r of [...rows].sort((a, b) => b.extraRows - a.extraRows).slice(0, TOP)) {
  const kind = r.pRows > r.gRows ? '机器多抽' : '对齐失败';
  console.log(`  ${r.id.padEnd(10)}${String(r.gRows).padStart(7)}${String(r.pRows).padStart(7)}${String(r.matched).padStart(6)}${String(r.extraRows).padStart(7)}${String(r.missedRows).padStart(6)}  ${kind}`);
}

console.log('\n══ 比较组多出的文章（多出组 × ≈70 字段）══\n');
console.log('  文章      金标准组  机器组  多出组  多填估算');
let csum = 0;
for (const r of [...rows].filter((r) => r.pCmpExtra > 0).sort((a, b) => b.pCmpExtra - a.pCmpExtra).slice(0, TOP)) {
  csum += r.pCmpExtra * 70;
  console.log(`  ${r.id.padEnd(10)}${String(r.gCmp).padStart(8)}${String(r.pCmp).padStart(8)}${String(r.pCmpExtra).padStart(7)}${String(r.pCmpExtra * 70).padStart(9)}`);
}
console.log(`\n  比较组级多填合计估算 = ${rows.reduce((a, r) => a + r.pCmpExtra * 70, 0)}（评测实测 3,735）`);

/* ── 文章级多填：到底是哪 2 个键 ── */
console.log('\n══ 文章级多填：机器输出里"金标准没有的列" ══\n');
for (const y of ['2020', '2023']) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const g0 = gold.articles[0];
  const goldKeys = new Set([...Object.keys(g0.article ?? {}), ...Object.keys(g0.study ?? {})].map((k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())));
  const fn = readdirSync(xd).filter((f) => /^\d{4}-\d{1,2}\.json$/.test(f))[0];
  const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
  const extraKeys = Object.keys(pred.article ?? {}).filter((k) => !goldKeys.has(k) && k !== 'articleId');
  const extraStudy = Object.keys(pred.studyOutcomes ?? {}).filter((k) => !goldKeys.has(k));
  console.log(`  ${y}/${fn}: article 段多出 ${JSON.stringify(extraKeys)}；studyOutcomes 多出 ${JSON.stringify(extraStudy)}`);
  console.log(`     该篇金标准 article 键（前 12）：${Object.keys(g0.article ?? {}).slice(0, 12).join(', ')}`);
  console.log(`     该篇机器 article 键（前 12）：  ${Object.keys(pred.article ?? {}).slice(0, 12).join(', ')}`);
}
void artLevel;
