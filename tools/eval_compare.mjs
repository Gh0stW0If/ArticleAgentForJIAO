/**
 * 评测结果 A/B 对照：同一批文章，改材料/改提示词前后，准确率差在哪里。
 *
 * 为什么单独写：`build/eval/<year>.json` 每次评测都会覆盖，改完马上就看不出差别了。
 * 这个工具只做一件事——读两份 eval JSON，逐作用域、逐 sheet、逐字段给出前后差值，
 * 让"改动到底有没有用"有据可查，而不是凭印象。
 *
 * 用法：
 *   node tools/eval_compare.mjs --before build/_backup_prelatex/eval/2015.json --after build/eval/2015.json
 *   加 --detail 打印字段级 Top 涨跌与逐篇差值
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const DETAIL = argv.includes('--detail');
const beforeFile = arg('before', null);
const afterFile = arg('after', null);
if (!beforeFile || !afterFile) {
  console.error('用法：node tools/eval_compare.mjs --before <旧 eval.json> --after <新 eval.json> [--detail]');
  process.exit(2);
}
for (const f of [beforeFile, afterFile]) {
  if (!existsSync(resolve(ROOT, f))) { console.error(`文件不存在：${f}`); process.exit(2); }
}
const B = JSON.parse(readFileSync(resolve(ROOT, beforeFile), 'utf8'));
const A = JSON.parse(readFileSync(resolve(ROOT, afterFile), 'utf8'));

const pct = (v) => `${v.toFixed(1)}%`;
const rate = (s) => { const d = s.hit + s['code-hit'] + s.wrong + s.missed; return d ? ((s.hit + s['code-hit']) / d) * 100 : 0; };
const delta = (a, b) => { const d = a - b; return `${d >= 0 ? '+' : ''}${d.toFixed(2)}`; };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\n══ 评测 A/B 对照 ══`);
console.log(`  旧：${beforeFile}`);
console.log(`  新：${afterFile}`);
if (B.articles?.length !== A.articles?.length) {
  console.log(`  ⚠ 篇数不同（旧 ${B.articles?.length} / 新 ${A.articles?.length}），差值不可直接解释`);
}

console.log('\n【作用域】命中率');
console.log(`  ${pad('作用域', 14)}${padL('旧', 9)}${padL('新', 9)}${padL('差', 9)}   ${padL('旧错', 7)}${padL('新错', 7)}${padL('旧漏', 7)}${padL('新漏', 7)}`);
for (const scope of ['article', 'study', 'comparison', 'outcome']) {
  const b = B.total?.[scope]; const a = A.total?.[scope];
  if (!b || !a) continue;
  console.log(`  ${pad(scope, 14)}${padL(pct(rate(b)), 9)}${padL(pct(rate(a)), 9)}${padL(delta(rate(a), rate(b)), 9)}   `
    + `${padL(b.wrong, 7)}${padL(a.wrong, 7)}${padL(b.missed, 7)}${padL(a.missed, 7)}`);
}

console.log('\n【Sheet】');
for (const key of Object.keys(A.sheets ?? {})) {
  const b = B.sheets?.[key]; const a = A.sheets[key];
  if (!b) { console.log(`  ${pad(a.label ?? key, 26)}（旧结果里没有，无法比较）新 ${pct(a.rate)}`); continue; }
  console.log(`  ${pad(a.label ?? key, 26)}旧 ${pct(b.rate).padStart(7)} → 新 ${pct(a.rate).padStart(7)}  （${delta(a.rate, b.rate)} 点）`
    + `  分母 ${b.den} → ${a.den}`);
}

if (DETAIL) {
  const fields = new Set([...Object.keys(B.byField ?? {}), ...Object.keys(A.byField ?? {})]);
  const rows = [];
  for (const f of fields) {
    const b = B.byField[f]; const a = A.byField[f];
    if (!b || !a) continue;
    const d = rate(a) - rate(b);
    const n = (a.hit + a.wrong + a.missed);
    if (n < 5) continue;                     // 样本太小的字段不列，避免噪声
    rows.push({ f, b: rate(b), a: rate(a), d, n });
  }
  console.log('\n【字段】变化最大的 12 个（样本 ≥5）：');
  console.log(`  ${pad('字段', 40)}${padL('旧', 8)}${padL('新', 8)}${padL('差', 9)}${padL('样本', 7)}`);
  for (const r of [...rows].sort((x, y) => y.d - x.d).slice(0, 12)) {
    console.log(`  ${pad(r.f, 40)}${padL(pct(r.b), 8)}${padL(pct(r.a), 8)}${padL(delta(r.a, r.b), 9)}${padL(r.n, 7)}`);
  }
  console.log('\n  …退步最大的 12 个：');
  for (const r of [...rows].sort((x, y) => x.d - y.d).slice(0, 12)) {
    console.log(`  ${pad(r.f, 40)}${padL(pct(r.b), 8)}${padL(pct(r.a), 8)}${padL(delta(r.a, r.b), 9)}${padL(r.n, 7)}`);
  }

  const byId = new Map((A.articles ?? []).map((x) => [x.id, x]));
  console.log('\n【逐篇】');
  for (const b of B.articles ?? []) {
    const a = byId.get(b.id);
    if (!a) continue;
    const agg = (x) => ['article', 'study', 'comparison', 'outcome'].reduce((s, k) => {
      const t = x[k] ?? { hit: 0, 'code-hit': 0, wrong: 0, missed: 0 };
      s.h += t.hit + t['code-hit']; s.n += t.hit + t['code-hit'] + t.wrong + t.missed; return s;
    }, { h: 0, n: 0 });
    const ab = agg(b); const aa = agg(a);
    const rb = ab.n ? (ab.h / ab.n) * 100 : 0; const ra = aa.n ? (aa.h / aa.n) * 100 : 0;
    console.log(`  ${pad(b.id, 12)}旧 ${padL(pct(rb), 7)} → 新 ${padL(pct(ra), 7)}  （${delta(ra, rb)} 点）`);
  }
}

const aggAll = (x) => {
  let h = 0; let n = 0;
  for (const k of ['article', 'study', 'comparison', 'outcome']) {
    const t = x.total?.[k]; if (!t) continue;
    h += t.hit + t['code-hit']; n += t.hit + t['code-hit'] + t.wrong + t.missed;
  }
  return n ? (h / n) * 100 : 0;
};
console.log(`\n  合计命中率：旧 ${pct(aggAll(B))} → 新 ${pct(aggAll(A))}（${delta(aggAll(A), aggAll(B))} 点）\n`);
