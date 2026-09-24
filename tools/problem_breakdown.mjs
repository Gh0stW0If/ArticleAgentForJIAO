/**
 * 问题细分：把"排除金标准漏填"后剩下的两类（A 机器漏抽 / B 值不同）拆到可动作的粒度。
 *
 *   A 漏抽  → ① 整列漏（同一字段在某篇里**全部**为空）② 零散漏
 *             · 其中有多少是"防硬凑"规则造成的（可回滚）
 *   B 值不同 → ① 描述类（措辞差异，靠语义判定/放宽判分）② 编码/数值类（真错）
 *
 * 另外单独看**结构性问题**（不是字段级）：比较组数不一致、结局行对齐。
 *
 * 用法：node tools/problem_breakdown.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const isSent = (s) => SENT.test(String(s ?? '')) || String(s ?? '').trim() === '';
const sheetOf = (f0) => {
  const f = String(f0).replace(/^judged\./, '');
  if (/^(article|comparison)\./.test(f)) return 1;
  if (/^study\./.test(f)) return 2;
  return 3;
};

/** 描述类字段判据：金标准取值多为自由文本（无取值表、非纯数字）。 */
const NUMERICISH = /^[-+]?\d+(?:[.,]\d+)?$/;
const CODEISH = /^\d+(\s*[/;,、]\s*\d+)*$/;

/** 收集全部判错条目（含 gold/pred 原文） */
const wrongs = [];
let strictMissed = 0; let strictWrong = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    const st = rep.sheets?.[key]?.strict;
    if (st) { strictMissed += st.missed; strictWrong += st.wrong; }
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      if ((VERDICT_WEIGHT[j.verdict] ?? 0) >= 1) continue;
      wrongs.push({ year: y, id: String(j.key).split('/')[0], sheet: sheetOf(j.field), field: String(j.field).replace(/^judged\./, ''), gold: String(j.gold ?? ''), pred: String(j.pred ?? '') });
    }
  }
}

const A = wrongs.filter((r) => !isSent(r.gold) && isSent(r.pred));
const B = wrongs.filter((r) => !isSent(r.gold) && !isSent(r.pred));
const C = wrongs.filter((r) => isSent(r.gold) && !isSent(r.pred));

console.log('\n══ 问题细分（语义判定部分）══\n');
console.log(`  语义判定里的未命中：${wrongs.length}｜A 漏抽 ${A.length}｜B 值不同 ${B.length}｜C 多填(忽略) ${C.length}`);
console.log(`  （另有严格比对部分：漏 ${strictMissed}｜错 ${strictWrong}——这部分**没有 gold/pred 原文**，无法再细分）`);

/* ── B 的细分：描述类 vs 编码/数值类 ── */
const bDesc = B.filter((r) => !NUMERICISH.test(r.gold.trim()) && !CODEISH.test(r.gold.trim()));
const bCode = B.filter((r) => CODEISH.test(r.gold.trim()));
const bNum = B.filter((r) => NUMERICISH.test(r.gold.trim()));
console.log('\n  ── B 值不同 的构成 ──');
const bp = (n) => `${n}（${((n / B.length) * 100).toFixed(0)}%）`;
console.log(`    自由文本（措辞差异为主）  ${bp(bDesc.length)}`);
console.log(`    编码取值                  ${bp(bCode.length)}`);
console.log(`    纯数值                    ${bp(bNum.length)}`);

/* ── A 的细分：整列漏 vs 零散漏 ── */
/* 以"篇+字段"为单位：该篇该字段的金标准判定条目全为空 → 整列漏 */
const byArticleField = new Map();
for (const r of A) {
  const k = `${r.id}|${r.field}`;
  const rec = byArticleField.get(k) ?? { n: 0 };
  rec.n++;
  byArticleField.set(k, rec);
}
/* 需要知道该篇该字段的**全部**判定条目数才能判"整列"；这里用金标准的非空条目做近似 */
const goldNonEmptyPerArticleField = new Map();
for (const r of wrongs) {
  const k = `${r.id}|${r.field}`;
  goldNonEmptyPerArticleField.set(k, (goldNonEmptyPerArticleField.get(k) ?? 0) + 1);
}
console.log('\n  ── A 机器漏抽 的集中度 ──');
const topA = [...byArticleField.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
console.log('    漏得最多的「篇×字段」：');
for (const [k, v] of topA) console.log(`      ${k}：漏 ${v.n}`);

/* ── 结构性问题：比较组数、结局行对齐 ── */
console.log('\n  ── 结构性问题（非字段级）──');
let cmpMismatch = 0; let cmpTotal = 0;
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(d)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    const pf = join(d, `${a.article_id}.json`);
    if (!existsSync(pf)) continue;
    let pred;
    try { pred = JSON.parse(readFileSync(pf, 'utf8')); } catch { continue; }
    const gn = (a.comparisons ?? []).length; const pn = (pred.comparisons ?? []).length;
    cmpTotal++;
    if (gn !== pn) cmpMismatch++;
  }
}
console.log(`    比较组数不一致：${cmpMismatch} / ${cmpTotal} 篇（${((cmpMismatch / cmpTotal) * 100).toFixed(0)}%）`
  + ' ← 会让该篇后续所有比较组字段**整体错位**');
const align = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  const oc = rep.outcomeAlignment;
  if (oc) align.push({ y, ...oc });
}
if (align.length) {
  const txt = align.reduce((a, r) => a + (r.textOnly ?? 0), 0);
  const num = align.reduce((a, r) => a + (r.numericCorroborated ?? 0), 0);
  const weak = align.reduce((a, r) => a + (r.weak ?? 0), 0);
  console.log(`    结局行对齐：纯文本配上 ${txt}｜靠数值佐证 ${num}｜弱对齐 ${weak}`);
} else {
  console.log('    结局行对齐：评测报告里没有该字段（见 docs/11 §1.1 的 344/1110 行未配上）');
}

/* ── 归类到"最集中的字段" ── */
const agg = new Map();
for (const r of [...A, ...B]) {
  const k = `${r.sheet}|${r.field}`;
  const rec = agg.get(k) ?? { A: 0, B: 0 };
  if (A.includes(r)) rec.A++; else rec.B++;
  agg.set(k, rec);
}
console.log('\n  ── 问题最集中的「字段」（A+B 降序，前 18）──');
console.log('     sheet 字段                                 A漏抽   B值不同');
for (const [k, v] of [...agg.entries()].sort((a, b) => (b[1].A + b[1].B) - (a[1].A + a[1].B)).slice(0, 18)) {
  const [s, f] = k.split('|');
  console.log(`     ${s}     ${f.padEnd(38)}${String(v.A).padStart(5)}   ${String(v.B).padStart(7)}`);
}
console.log('');
