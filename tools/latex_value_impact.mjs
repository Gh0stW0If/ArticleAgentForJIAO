/**
 * LaTeX 污染的**金标准层影响面**：有多少金标准数值，修复前在材料里读不出来？
 *
 * 判据见 `tools/lib/latex_broken.mjs`：
 *   值 `v` 算"受影响" ⟺ 清洗前原文里**找不到** `v`，清洗后**找得到** `v`。
 *
 * ⚠️ 不要退回"多重集差"的做法：那条路会被金标准里的单字符编码值（`1`、`4`、`5`）
 * 大量假匹配，实测把 2018-09 的 12 个真实受影响字段吹成 131 个，结论完全反向。
 *
 * 用法：node tools/latex_value_impact.mjs [--year 2015] [--detail]
 * 输出：build/latex_value_impact.json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialTexts, wasBroken } from './lib/latex_broken.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const DETAIL = argv.includes('--detail');
const YEARS = ONLY_YEAR ? [ONLY_YEAR]
  : ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];

const normNum = (s) => {
  const m = String(s ?? '').replace(/[−–—]/g, '-').replace(/[^\d.\-]/g, '');
  if (!m || !/\d/.test(m)) return null;
  const n = Number(m);
  return Number.isFinite(n) ? String(n) : null;
};

/** 纯编码列不参与：它们的取值是 1 位数字，没有鉴别力。 */
const CODEISH = /(_code|_class|^arm_number$|^row_id$|^literature_code$|^literature_no$|^extractor$)/;

/** 收集金标准的"数值叶子"（值里含数字、且不是编码列）。 */
function goldLeaves(gold, id) {
  const out = [];
  const ga = (gold.articles ?? []).find((a) => a.article_id === id);
  if (!ga) return out;
  const push = (scope, field, leaf) => {
    if (!leaf || typeof leaf !== 'object' || !('raw' in leaf)) return;
    const raw = leaf.raw;
    if (raw === null || raw === undefined || raw === '') return;
    if (CODEISH.test(field)) return;
    const v = normNum(raw);
    if (v === null || v.replace('-', '').length < 2) return;   // 单字符值不算
    out.push({ scope, field, raw: String(raw), value: v });
  };
  const walk = (scope, obj) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      if ('raw' in v) push(scope, k, v);
      else walk(scope, k, v);
    }
  };
  walk('study', ga.study);
  for (const c of ga.comparisons ?? []) walk('comparison', c);
  for (const o of ga.outcomes ?? []) {
    walk('outcome', o.outcome);
    walk('followUp', o.follow_up);
    for (const [tp, kinds] of Object.entries(o.timepoints ?? {})) {
      for (const [kind, fields] of Object.entries(kinds ?? {})) {
        if (fields && typeof fields === 'object') walk(`${tp}.${kind}`, fields);
      }
    }
  }
  return out;
}

const stat = { articles: 0, scanned: 0, affected: 0, articlesAffected: 0 };
const rows = [];
const affectedByField = new Map();
const samples = [];
const byYear = new Map();

for (const year of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${year}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const y = { scanned: 0, affected: 0, arts: 0 };
  for (const ga of gold.articles ?? []) {
    const id = ga.article_id;
    const texts = materialTexts(ROOT, year, id);
    if (!texts) continue;
    stat.articles++;
    const leaves = goldLeaves(gold, id);
    y.scanned += leaves.length;
    stat.scanned += leaves.length;
    let hit = 0;
    for (const leaf of leaves) {
      if (!wasBroken(texts, leaf.value)) continue;
      hit++;
      affectedByField.set(leaf.field, (affectedByField.get(leaf.field) ?? 0) + 1);
      if (DETAIL && samples.length < 80) samples.push({ year, id, ...leaf });
    }
    if (hit) { stat.affected += hit; stat.articlesAffected++; y.arts++; }
    y.affected += hit;
    rows.push({ year, articleId: id, scanned: leaves.length, affected: hit });
  }
  byYear.set(year, y);
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : '—');
console.log(`\n══ LaTeX 污染的**金标准层**影响面 ══\n`);
console.log(`  判据：清洗前原文找不到该数值、清洗后找得到（单字符编码值不计）`);
console.log(`  扫描 ${stat.articles} 篇 / 数值叶子 ${stat.scanned} 个`);
console.log(`  受影响的数值叶子：**${stat.affected} 个（${pc(stat.affected, stat.scanned)}）**，涉及 ${stat.articlesAffected} 篇`);

console.log('\n  分年：');
for (const [year, v] of byYear) {
  console.log(`   ${year}：${String(v.affected).padStart(4)} / ${String(v.scanned).padStart(5)}（${pc(v.affected, v.scanned).padStart(6)}）｜受影响篇 ${v.arts}`);
}

if (affectedByField.size) {
  console.log('\n  受影响最多的字段（Top 25）：');
  for (const [f, n] of [...affectedByField].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`   ${String(n).padStart(4)}  ${f}`);
  }
}

const top = rows.filter((r) => r.affected).sort((a, b) => b.affected - a.affected).slice(0, 12);
if (top.length) {
  console.log('\n  受影响最多的篇：');
  for (const r of top) console.log(`   ${r.articleId}：${r.affected} / ${r.scanned}`);
}

if (DETAIL && samples.length) {
  console.log('\n  明细样例（前 20）：');
  for (const s of samples.slice(0, 20)) console.log(`   ${s.id} ${s.scope}.${s.field} = ${s.raw}`);
}

const out = join(ROOT, 'build', 'latex_value_impact.json');
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stat, rows,
  byYear: [...byYear].map(([year, v]) => ({ year, ...v })),
  affectedByField: [...affectedByField].map(([field, n]) => ({ field, n })), samples }, null, 1), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
