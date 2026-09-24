/**
 * 一次性探针：为两个"整列没抽"的字段提供修复依据。
 *   ① total_sessions_class_b —— gold 取值分布 + 同族 class_a（有编码表）的得分做对照
 *   ② analyzed_n_experimental/_control —— gold 是否恒等于"脱落人数"、0/NR/NA 的占比
 * 用法：node tools/_classb_analyzed_fix.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const v = (o) => (o && typeof o === 'object' ? (o.raw ?? o.code ?? '') : (o ?? ''));
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;

/* ── ① gold 侧统计 ── */
const gold = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of j.articles ?? []) {
    for (const g of a.comparisons ?? []) {
      const rec = { y, id: a.article_id };
      for (const k of ['total_sessions_class_a','total_sessions_class_b','analyzed_n_experimental','analyzed_n_control','dropout_total','randomized_n_experimental','randomized_n_control']) rec[k] = String(v(g[k])).trim();
      gold.set(`${y}|${a.article_id}|${gold.size}`, rec);
    }
  }
}
const rows = [...gold.values()];
const hist = (key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key] === '' ? '(空)' : r[key]; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log(`比较组总数 = ${rows.length}`);
for (const k of ['total_sessions_class_a','total_sessions_class_b']) {
  const h = hist(k);
  console.log(`\n${k} 分布（前 12）:`, h.slice(0, 12).map(([a, b]) => `${a}=${b}`).join('  '));
  console.log(`   有值(非空非哨兵)=${rows.filter((r) => r[k] !== '' && !SENT.test(r[k])).length}  哨兵=${rows.filter((r) => SENT.test(r[k])).length}  空=${rows.filter((r) => r[k] === '').length}`);
}
console.log('\nanalyzed_n_experimental 分布（前 12）:', hist('analyzed_n_experimental').slice(0, 12).map(([a, b]) => `${a}=${b}`).join('  '));
console.log('analyzed_n_control 分布（前 12）:', hist('analyzed_n_control').slice(0, 12).map(([a, b]) => `${a}=${b}`).join('  '));

/* 是否为"脱落人数"：anlzExp + anlzCtl == dropout_total */
let eq = 0, ne = 0, skip = 0, ex = [];
for (const r of rows) {
  const a = Number(r.analyzed_n_experimental), b = Number(r.analyzed_n_control), d = Number(r.dropout_total);
  if (![a, b, d].every(Number.isFinite)) { skip++; continue; }
  if (a + b === d) eq++; else { ne++; if (ex.length < 8) ex.push(`${r.y} ${r.id}: ${a}+${b}≠${d}`); }
}
console.log(`\n"analyzed_n_exp + analyzed_n_ctl == dropout_total" 成立 ${eq} 组，不成立 ${ne} 组，无法比较 ${skip} 组`);
if (ex.length) console.log('  反例：' + ex.join(' | '));

/* ── ② 评测侧：两族的得分对照 ── */
const acc = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    const st = rep.sheets?.[key]?.strict;
    if (st) {
      /* 严格桶没有字段名，只有总数；记在 _strict 上 */
      const s = acc.get('_strict') ?? { n: 0, w: 0 }; s.n += st.hit + (st['code-hit'] ?? 0) + st.wrong + st.missed; s.w += st.hit + (st['code-hit'] ?? 0); acc.set('_strict', s);
    }
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const field = String(j.field).replace(/^judged\./, '');
      const s = acc.get(field) ?? { n: 0, w: 0 }; s.n++; s.w += VERDICT_WEIGHT[j.verdict] ?? 0; acc.set(field, s);
    }
  }
}
console.log('\n── 评测得分对照（仅 LLM 语义判定部分）──');
for (const k of ['total_sessions_class_a','total_sessions_class_b','analyzed_n_experimental','analyzed_n_control']) {
  const s = acc.get(`comparison.${k}`);
  console.log(`  ${k}: n=${s?.n ?? 0}  加权=${(s?.w ?? 0).toFixed(1)}  = ${s?.n ? ((s.w / s.n) * 100).toFixed(1) : '—'}%`);
}
