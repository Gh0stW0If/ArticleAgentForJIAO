/**
 * 一次性探针：① 被排除的对齐条目（excludedMisaligned）有多少、都是什么；
 *              ② 用 byField + 顶层 judged 算"逐字段全口径准确率"（含严格桶）。
 * 用法：node tools/_field_full_acc.mjs [字段片段...]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAGS = process.argv.slice(2);
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const acc = new Map();
let excluded = 0, excludedSamples = [], alignedNoKey = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  excluded += (rep.excludedMisaligned ?? []).length;
  for (const s of (rep.excludedMisaligned ?? []).slice(0, 3)) excludedSamples.push(`${y}: ${s}`);
  for (const [field, st] of Object.entries(rep.byField ?? {})) {
    /* `judged.<field>` 是同一批语义判定结果的镜像计数，会与顶层 judged 重复，跳过 */
    if (field.startsWith('judged.')) continue;
    const s = acc.get(field) ?? { field, n: 0, w: 0, strictN: 0, strictW: 0, jN: 0, jW: 0 };
    const n = st.hit + (st['code-hit'] ?? 0) + st.wrong + st.missed;
    const w = st.hit + 0.5 * (st['code-hit'] ?? 0);
    s.strictN += n; s.strictW += w; s.n += n; s.w += w;
    acc.set(field, s);
  }
  for (const j of rep.judged ?? []) {
    if (!j.key) alignedNoKey++;
    const field = String(j.field).replace(/^judged\./, '');
    const s = acc.get(field) ?? { field, n: 0, w: 0, strictN: 0, strictW: 0, jN: 0, jW: 0 };
    const w = VERDICT_WEIGHT[j.verdict] ?? 0;
    s.jN++; s.jW += w; s.n++; s.w += w;
    acc.set(field, s);
  }
}
console.log(`被排除的对齐条目（excludedMisaligned）合计 = ${excluded}`);
for (const s of excludedSamples.slice(0, 8)) console.log('   ' + s);
console.log(`顶层 judged 无 key 的条目 = ${alignedNoKey}`);

const MIN = Number(process.env.MIN_N ?? 0);
const rows = [...acc.values()].filter((r) => r.n >= MIN).filter((r) => !FRAGS.length || FRAGS.some((x) => r.field.includes(x)));
const tt = (r) => (r.n ? ((r.w / r.n) * 100).toFixed(1) + '%' : '—');
const gN = [...acc.values()].reduce((a, r) => a + r.n, 0);
const gW = [...acc.values()].reduce((a, r) => a + r.w, 0);
console.log(`\n逐字段合计 = ${gN} 个字段、加权 ${gW.toFixed(1)} = ${((gW / gN) * 100).toFixed(1)}%（应与 accuracy_overview 的 52,975 / 48.9% 一致）`);
rows.sort((a, b) => a.w / (a.n || 1) - b.w / (b.n || 1));
console.log('\n字段（全口径：严格桶 + 语义判定）           字段数   严格(n/率)          语义(n/率)          合计率');
for (const r of rows) {
  console.log(`${r.field.padEnd(38)}${String(r.n).padStart(6)}  ${String(r.strictN).padStart(5)}/${((r.strictW / (r.strictN || 1)) * 100).toFixed(0).padStart(3)}%   ${String(r.jN).padStart(5)}/${((r.jW / (r.jN || 1)) * 100).toFixed(0).padStart(3)}%   ${tt(r).padStart(6)}`);
}
