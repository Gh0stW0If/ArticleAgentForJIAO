/**
 * 问题分类：把**所有未命中**按性质分桶，并把"金标准漏填（机器有值、金标准 NR/NA/空）"单独隔离。
 *
 * 用户口径：金标准漏填问题**暂时忽略**。所以这里要回答的是：
 * **排除它之后，剩下的问题是什么、各占多少。**
 *
 * 数据来源：
 *   · 严格比对部分 → `build/eval/<year>.json` 的 `sheets.*.strict`（hit/code-hit/wrong/missed/extra）
 *   · 语义判定部分 → `sheets.*.judged`（含 gold/pred 原文，可自行分桶）
 *
 * 分桶：
 *   A. 机器漏抽       金标准有值、机器空/NR/NA       → 可修（召回）
 *   B. 值不同         两边都有值但不等               → 可修（准确）
 *   C. 机器多填       金标准空、机器有值             → **用户要求暂时忽略**
 *   D. 语义不符       两边都是自由文本、判为完全不同 → 多为措辞/口径
 *
 * 用法：node tools/problem_taxonomy.mjs [--sheet 1|2|3] [--json]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_SHEET = arg('sheet', null);
const AS_JSON = argv.includes('--json');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const isSent = (s) => SENT.test(String(s ?? '')) || String(s ?? '').trim() === '';
const sheetOf = (field) => {
  const f = String(field).replace(/^judged\./, '');
  if (/^(article|comparison)\./.test(f)) return 1;
  if (/^study\./.test(f)) return 2;
  return 3;
};

const blank = () => ({ correct: 0, A漏抽: 0, B值不同: 0, C多填: 0, D无语义: 0, total: 0 });
const S = { 1: blank(), 2: blank(), 3: blank() };
/** 按字段聚合，用于找"问题最集中的字段" */
const byField = new Map();

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));

  /* ① 严格比对部分：missed = 漏抽；wrong = 值不同；extra = 多填 */
  for (const [key, idx] of [['sheet1', 1], ['sheet2', 2], ['sheet3', 3]]) {
    const st = rep.sheets?.[key]?.strict;
    if (!st) continue;
    const s = S[idx];
    s.correct += st.hit + (st['code-hit'] ?? 0);
    s.A漏抽 += st.missed;
    s.B值不同 += st.wrong;
    s.C多填 += st.extra ?? 0;
    s.total += st.hit + (st['code-hit'] ?? 0) + st.wrong + st.missed + (st.extra ?? 0);
  }

  /* ② 语义判定部分：按 gold/pred 的哨兵状态自行分桶 */
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const idx = sheetOf(j.field);
      const s = S[idx];
      const g = String(j.gold ?? ''); const p = String(j.pred ?? '');
      const gSent = isSent(g); const pSent = isSent(p);
      const w = VERDICT_WEIGHT[j.verdict] ?? 0;
      s.total++;
      if (w >= 1) { s.correct++; continue; }
      let bucket;
      if (gSent && !pSent) bucket = 'C多填';          // 金标准空、机器有值（用户要求忽略）
      else if (!gSent && pSent) bucket = 'A漏抽';     // 金标准有值、机器空
      else if (!gSent && !pSent) bucket = 'B值不同';  // 两边都有值
      else bucket = 'C多填';                          // 两边都空却判错 → 归入多填类（罕见）
      s[bucket]++;
      const fk = `${idx}|${String(j.field).replace(/^judged\./, '')}`;
      const rec = byField.get(fk) ?? { sheet: idx, field: String(j.field).replace(/^judged\./, ''), A: 0, B: 0, C: 0, n: 0 };
      rec[bucket[0]]++; rec.n++;
      byField.set(fk, rec);
    }
  }
  /* 严格部分也进字段聚合（只有计数，无 gold 文本，按 bucket 名归位） */
  void y;
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const tot = blank();
for (const idx of [1, 2, 3]) for (const k of Object.keys(tot)) tot[k] += S[idx][k];

const rows = [];
for (const idx of [1, 2, 3]) {
  const s = S[idx];
  const wrongTotal = s.A漏抽 + s.B值不同 + s.C多填 + s.D无语义;
  rows.push({
    sheet: idx,
    label: ['', 'Sheet1（文章级+比较组）', 'Sheet2（结局分类）', 'Sheet3（结局×时点）'][idx],
    total: s.total, correct: s.correct,
    rate: s.total ? (s.correct / s.total) * 100 : 0,
    A: s.A漏抽, B: s.B值不同, C: s.C多填, D: s.D无语义, wrongTotal,
  });
}

if (AS_JSON) {
  writeFileSync(join(ROOT, 'build', 'problem_taxonomy.json'), JSON.stringify({ rows, byField: [...byField.values()] }, null, 1), 'utf8');
  console.log('已写入 build/problem_taxonomy.json');
  process.exit(0);
}

console.log('\n══ 问题分类（已隔离"金标准漏填"）══\n');
console.log('  工作表                    字段数   正确率     未命中   A机器漏抽   B值不同   C机器多填*   其余');
for (const r of rows) {
  if (ONLY_SHEET && String(r.sheet) !== ONLY_SHEET) continue;
  console.log(`  ${r.label.padEnd(22)}${String(r.total).padStart(6)}  ${pc(r.correct, r.total).padStart(7)}  ${String(r.wrongTotal).padStart(7)}`
    + `  ${String(r.A).padStart(9)}  ${String(r.B).padStart(8)}  ${String(r.C).padStart(10)}  ${String(r.D).padStart(6)}`);
}
console.log(`  ${'合计'.padEnd(22)}${String(tot.total).padStart(6)}  ${pc(tot.correct, tot.total).padStart(7)}  ${String(tot.A漏抽 + tot.B值不同 + tot.C多填 + tot.D无语义).padStart(7)}`
  + `  ${String(tot.A漏抽).padStart(9)}  ${String(tot.B值不同).padStart(8)}  ${String(tot.C多填).padStart(10)}  ${String(tot.D无语义).padStart(6)}`);

const excl = tot.A漏抽 + tot.B值不同 + tot.D无语义;
console.log(`\n  * C（机器多填 / 金标准漏填）= ${tot.C多填}，按用户口径**暂时忽略**。`);
console.log(`  排除 C 之后仍需处理：**${excl}** 条 = A 机器漏抽 ${tot.A漏抽} + B 值不同 ${tot.B值不同} + D 其余 ${tot.D无语义}`);
console.log(`  以"排除 C 后"为分母，正确率 = ${((tot.correct / (tot.total - tot.C多填)) * 100).toFixed(1)}%`);

/* 问题最集中的字段（按 A+B+D 降序） */
const worst = [...byField.values()]
  .map((r) => ({ ...r, bad: r.A + r.B + r.C }))
  .sort((a, b) => b.bad - a.bad)
  .slice(0, 20);
console.log('\n  ── 问题最集中的字段（语义判定部分，前 20）──');
console.log('     sheet 字段                              A漏抽   B值不同   C多填');
for (const r of worst) console.log(`     ${r.sheet}     ${r.field.padEnd(34)}${String(r.A).padStart(5)}   ${String(r.B).padStart(7)}   ${String(r.C).padStart(6)}`);
console.log('');
