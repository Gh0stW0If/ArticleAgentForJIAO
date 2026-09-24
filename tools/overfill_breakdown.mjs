/**
 * 「机器多填（extra）」到底多在哪 —— 分作用域 + 分字段 + 逐篇实例。
 *
 * extra 的产生方式（`tools/llm_eval.mjs`）：
 *   ① 文章级：流水线输出了金标准**没有对应列**的字段 → 每个字段 +1（line 386-392）
 *   ② 比较组级：流水线比金标准**多出比较组** → 每个多出的组 +countFieldLeaves(组)（line 428-435）
 *   ③ 结局级：对齐后**没被任何金标准行配上的结局行** → 每行 +countFieldLeaves(行)（line 526-532）
 *
 * 用法：node tools/overfill_breakdown.mjs [--top 15] [--json]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const TOP = Number(arg('top', 15));
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const scopeTotal = { article: 0, comparison: 0, outcome: 0, study: 0 };
const byField = new Map();
const perArticle = [];

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const [field, st] of Object.entries(rep.byField ?? {})) {
    if (field.startsWith('judged.')) continue;
    if (!st.extra) continue;
    const s = byField.get(field) ?? { field, extra: 0, hit: 0, wrong: 0, missed: 0 };
    s.extra += st.extra; s.hit += st.hit; s.wrong += st.wrong; s.missed += st.missed;
    byField.set(field, s);
  }
  for (const a of rep.articles ?? []) {
    const row = { year: y, id: a.id, article: a.article?.extra ?? 0, comparison: a.comparison?.extra ?? 0, outcome: a.outcome?.extra ?? 0, study: a.study?.extra ?? 0, notes: a.notes ?? [] };
    row.total = row.article + row.comparison + row.outcome + row.study;
    if (row.total) perArticle.push(row);
    for (const k of Object.keys(scopeTotal)) scopeTotal[k] += a[k]?.extra ?? 0;
  }
}

const grand = Object.values(scopeTotal).reduce((a, b) => a + b, 0);
const pc = (a) => `${((a / grand) * 100).toFixed(1)}%`;
console.log('\n══ 「多填」按作用域拆解 ══\n');
console.log(`  文章级（多出金标准没有的列）        ${String(scopeTotal.article).padStart(7)}  ${pc(scopeTotal.article)}`);
console.log(`  比较组级（多出比较组 × 该组字段数）  ${String(scopeTotal.comparison).padStart(7)}  ${pc(scopeTotal.comparison)}`);
console.log(`  结局级（多出结局行 × 该行字段数）    ${String(scopeTotal.outcome).padStart(7)}  ${pc(scopeTotal.outcome)}`);
console.log(`  Sheet2 级                          ${String(scopeTotal.study).padStart(7)}  ${pc(scopeTotal.study)}`);
console.log(`  合计                              ${String(grand).padStart(7)}`);

console.log('\n══ 多填最多的字段（byField.extra）══\n');
console.log('  字段                                    多填   命中   错   漏');
for (const r of [...byField.values()].sort((a, b) => b.extra - a.extra).slice(0, TOP)) {
  console.log(`  ${r.field.padEnd(40)}${String(r.extra).padStart(5)}${String(r.hit).padStart(7)}${String(r.wrong).padStart(6)}${String(r.missed).padStart(6)}`);
}

console.log('\n══ 多填最多的文章 ══\n');
console.log('  文章     文章级  比较组级  结局级  合计   备注');
for (const r of perArticle.sort((a, b) => b.total - a.total).slice(0, TOP)) {
  const note = r.notes.filter((n) => /数量不符|多|错位/.test(n)).slice(0, 2).join('；');
  console.log(`  ${r.id.padEnd(9)}${String(r.article).padStart(6)}${String(r.comparison).padStart(9)}${String(r.outcome).padStart(8)}${String(r.total).padStart(7)}   ${note.slice(0, 90)}`);
}

const nr = perArticle.filter((r) => r.total > 0);
console.log(`\n  有"多填"的文章：${nr.length} / 有抽取产物的文章若干；多填中位数 ${nr.length ? [...nr].sort((a, b) => a.total - b.total)[Math.floor(nr.length / 2)].total : 0}`);

if (argv.includes('--json')) {
  writeFileSync(join(ROOT, 'build', 'overfill_breakdown.json'), JSON.stringify({ scopeTotal, grand, byField: [...byField.values()], perArticle }, null, 1), 'utf8');
  console.log('\n已写入 build/overfill_breakdown.json');
}
