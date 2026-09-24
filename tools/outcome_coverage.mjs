/**
 * 金标准要的结局，机器**到底抽没抽到**？
 *
 * 背景：机器每个比较组都抽"论文报告的全部结局"，所以金标准那几行**理论上应该都在机器列表里**；
 * 现在 1,110 行金标准只配上 775 行，需要区分两种可能：
 *   ① 机器抽到了，只是**对齐没配上** → 改对齐/加字典就能收回
 *   ② 机器列表里根本没有这个结局 → 真·召回缺失
 *
 * 用法：
 *   node tools/outcome_coverage.mjs              # 总体覆盖率
 *   node tools/outcome_coverage.mjs --detail     # 逐篇列出没配上的行及其候选
 *   node tools/outcome_coverage.mjs --miss       # 只看"机器里找不到"的行
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes, dice, normText, tokensOf } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DETAIL = argv.includes('--detail');
const ONLY_MISS = argv.includes('--miss');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const nm = (o) => String(o?.outcome?.name?.raw ?? '');
const ins = (o) => String(o?.outcome?.instrument?.raw ?? '');
const pair = (o) => `${nm(o)}｜${ins(o)}`;

/** 匹配强度：exact > subset > strong(dice≥.5) > weak(dice≥.34) > none */
function matchStrength(a, b) {
  const A = normText(a); const B = normText(b);
  if (!A || !B) return { level: 'none', d: 0 };
  if (A === B) return { level: 'exact', d: 1 };
  const ta = tokensOf(a); const tb = tokensOf(b);
  if (!ta.size || !tb.size) return { level: 'none', d: 0 };
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const subset = inter === Math.min(ta.size, tb.size) && Math.min(ta.size, tb.size) >= 1;
  const d = dice(a, b);
  if (subset) return { level: 'subset', d };
  if (d >= 0.5) return { level: 'strong', d };
  if (d >= 0.34) return { level: 'weak', d };
  return { level: 'none', d };
}
const RANK = { exact: 4, subset: 3, strong: 2, weak: 1, none: 0 };

/* 与评测同口径：`build/gold_row_anomalies.json` 里判为"整行错位"的金标准行不参与 */
const excludedRows = new Map();
{
  const f = join(ROOT, 'build', 'gold_row_anomalies.json');
  if (existsSync(f)) {
    for (const x of JSON.parse(readFileSync(f, 'utf8')).findings ?? []) {
      if (!excludedRows.has(x.articleId)) excludedRows.set(x.articleId, new Set());
      excludedRows.get(x.articleId).add(x.rowIndex);
    }
  }
}
/** 两个字段一起看：取最强的那个组合 */
function bestMatch(g, p) {
  const cands = [
    ['gold名↔机器名', nm(g), nm(p)],
    ['gold名↔机器工具', nm(g), ins(p)],
    ['gold工具↔机器名', ins(g), nm(p)],
    ['gold工具↔机器工具', ins(g), ins(p)],
  ].map(([how, a, b]) => ({ how, ...matchStrength(a, b) }));
  cands.sort((x, y) => RANK[y.level] - RANK[x.level] || y.d - x.d);
  return cands[0];
}

const stat = { gold: 0, aligned: 0, present: 0, miss: 0 };
const byLevel = new Map();
const missedButPresent = [];
const trulyMissing = [];
const perYear = new Map();

for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const byId = new Map((gold.articles ?? []).map((a) => [a.article_id, a]));
  const ys = { gold: 0, aligned: 0, present: 0 };
  for (const fn of readdirSync(xd)) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const g = byId.get(id);
    if (!g) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const skip = excludedRows.get(id);
    const gOAll = g.outcomes ?? [];
    const gO = skip?.size ? gOAll.filter((_, i) => !skip.has(i)) : gOAll;
    const pO = pred.outcomes ?? [];
    const { goldToPred } = alignOutcomes(gO, pO);
    for (const [gi, gr] of gO.entries()) {
      stat.gold++; ys.gold++;
      const aligned = goldToPred.has(gi);
      if (aligned) { stat.aligned++; ys.aligned++; }
      /* 名字层面：机器列表里有没有"这一条"（不要求一对一的唯一性） */
      let best = { level: 'none', d: 0, how: '', cand: null };
      for (const p of pO) {
        const m = bestMatch(gr, p);
        if (RANK[m.level] > RANK[best.level] || (RANK[m.level] === RANK[best.level] && m.d > best.d)) best = { ...m, cand: p };
      }
      const present = RANK[best.level] >= 1;
      if (present) { stat.present++; ys.present++; }
      else stat.miss++;
      byLevel.set(best.level, (byLevel.get(best.level) ?? 0) + 1);
      if (!aligned && present) missedButPresent.push({ y, id, g: pair(gr), level: best.level, how: best.how, cand: pair(best.cand) });
      if (!present) trulyMissing.push({ y, id, g: pair(gr) });
    }
  }
  perYear.set(y, ys);
}

const pc = (a, b) => `${((a / (b || 1)) * 100).toFixed(1)}%`;
console.log('\n══ 金标准结局行 vs 机器结局列表 ══\n');
console.log(`  金标准结局行总数                     ${stat.gold}`);
console.log(`  当前对齐配上                         ${stat.aligned}  (${pc(stat.aligned, stat.gold)})`);
console.log(`  ★ 名字层面"机器列表里存在"           ${stat.present}  (${pc(stat.present, stat.gold)})`);
console.log(`  ★ 机器列表里压根找不到               ${stat.miss}  (${pc(stat.miss, stat.gold)})`);
console.log(`\n  其中"没配上但机器里有"               ${missedButPresent.length} 行 ← 纯对齐问题，加字典可收回`);
console.log(`       "没配上且机器里没有"             ${trulyMissing.length} 行 ← 真·召回缺失`);

console.log('\n  匹配强度分布（金标准每一行取最佳候选）：');
for (const [k, v] of [...byLevel.entries()].sort((a, b) => RANK[b[0]] - RANK[a[0]])) {
  console.log(`     ${k.padEnd(7)} ${String(v).padStart(5)}  ${pc(v, stat.gold)}`);
}

console.log('\n  分年（对上率 / 存在率 / 缺失）：');
for (const [y, s] of perYear) console.log(`     ${y}  配上 ${pc(s.aligned, s.gold).padStart(6)}   存在 ${pc(s.present, s.gold).padStart(6)}   行数 ${s.gold}`);

if (DETAIL) {
  console.log('\n══ 没配上但机器列表里有的行（前 25）══\n');
  for (const r of missedButPresent.slice(0, 25)) {
    console.log(`  ${r.id}  gold: ${r.g}`);
    console.log(`            机器候选(${r.level}/${r.how}): ${r.cand}`);
  }
}
if (ONLY_MISS) {
  console.log('\n══ 机器列表里压根找不到的金标准行（全部）══\n');
  for (const r of trulyMissing) console.log(`  ${r.id}  ${r.g}`);
}
console.log('');
