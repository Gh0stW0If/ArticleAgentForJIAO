/**
 * 一次性探针：全局判定分布 + "contains_correct 半分" 对总分的量化影响。
 * 用法：node tools/_verdict_impact.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const sheetOf = (f0) => {
  const f = String(f0).replace(/^judged\./, '');
  if (/^(article|comparison)\./.test(f)) return 1;
  if (/^study\./.test(f)) return 2;
  return 3;
};
const blank = () => ({ n: 0, w: 0, v: new Map(), contains: 0, containsW: 0, strict: 0, strictHit: 0 });
const S = { 1: blank(), 2: blank(), 3: blank() };

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    const st = rep.sheets?.[key]?.strict;
    if (st) {
      const idx = Number(key.slice(-1));
      S[idx].strict += st.hit + (st['code-hit'] ?? 0) + st.wrong + st.missed + (st.extra ?? 0);
      S[idx].strictHit += st.hit + (st['code-hit'] ?? 0);
    }
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const idx = sheetOf(j.field);
      const s = S[idx];
      const w = VERDICT_WEIGHT[j.verdict] ?? 0;
      s.n++; s.w += w;
      s.v.set(j.verdict, (s.v.get(j.verdict) ?? 0) + 1);
      if (j.verdict === 'contains_correct') { s.contains++; s.containsW += w; }
    }
  }
}
console.log('\n工作簿  字段数   加权分   加权率   strict(未判定)  strict命中');
let totN = 0, totW = 0, totC = 0, totCW = 0, totS = 0, totSH = 0;
for (const idx of [1, 2, 3]) {
  const s = S[idx];
  const N = s.n + s.strict, W = s.w + s.strictHit;
  totN += N; totW += W; totC += s.contains; totCW += s.containsW; totS += s.strict; totSH += s.strictHit;
  console.log(`Sheet${idx}  ${String(N).padStart(7)}  ${W.toFixed(1).padStart(8)}  ${((W / N) * 100).toFixed(1).padStart(6)}%  ${String(s.strict).padStart(9)}  ${String(s.strictHit).padStart(9)}`);
}
console.log(`合计    ${String(totN).padStart(7)}  ${totW.toFixed(1).padStart(8)}  ${((totW / totN) * 100).toFixed(1).padStart(6)}%  ${String(totS).padStart(9)}  ${String(totSH).padStart(9)}`);
console.log(`\n若把 contains_correct 从 0.5 提到 1.0：总分 +${((totC * 0.5) / totN * 100).toFixed(2)} 点 → ${(((totW + totC * 0.5) / totN) * 100).toFixed(1)}%`);
console.log(`若提到 0.75：+${((totC * 0.25) / totN * 100).toFixed(2)} 点 → ${(((totW + totC * 0.25) / totN) * 100).toFixed(1)}%`);
console.log('\n各表判定分布（仅 LLM 语义判定部分）：');
for (const idx of [1, 2, 3]) {
  const s = S[idx];
  const dist = [...s.v.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}(${((v / s.n) * 100).toFixed(0)}%)`).join('  ');
  console.log(`  Sheet${idx}: n=${s.n}  ${dist}`);
}
console.log('\n"两边都有值但判不同"（B 桶）里 contains_correct 占比：');
for (const idx of [1, 2, 3]) {
  const s = S[idx];
  const b = (s.v.get('contains_correct') ?? 0) + (s.v.get('has_error') ?? 0) + (s.v.get('completely_different') ?? 0);
  console.log(`  Sheet${idx}: 判错总数=${b}  其中 contains_correct=${s.contains}（${((s.contains / b) * 100).toFixed(0)}%）`);
}
