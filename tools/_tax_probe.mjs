/**
 * 一次性探针：核对 problem_taxonomy 的 A/B 分桶与直接统计是否一致。
 * 用法：node tools/_tax_probe.mjs [字段名...]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const isSent = (s) => SENT.test(String(s ?? '')) || String(s ?? '').trim() === '';

const TARGETS = process.argv.slice(2);
const want = (f) => !TARGETS.length || TARGETS.some((t) => String(f).includes(t));

/* 逐 sheet 逐字段统计 */
const per = new Map(); // `${sheetKey}|${field}` -> stats
const seen = new Map(); // 去重指纹
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const field = String(j.field).replace(/^judged\./, '');
      if (!want(field)) continue;
      const k = `${key}|${field}`;
      const r = per.get(k) ?? { sheetKey: key, field, n: 0, ok: 0, A漏抽: 0, B值不同: 0, C多填: 0, D无语义: 0, goldHas: 0, predSent: 0, emptyPred: 0, nullPred: 0 };
      const g = String(j.gold ?? ''); const p = String(j.pred ?? '');
      const gS = isSent(g), pS = isSent(p);
      r.n++;
      if (gS === false) r.goldHas++;
      if (pS) r.predSent++;
      if (String(j.pred ?? '').trim() === '') r.emptyPred++;
      if (j.pred === null || j.pred === undefined) r.nullPred++;
      const w = VERDICT_WEIGHT[j.verdict] ?? 0;
      if (w >= 1) r.ok++;
      else if (gS && !pS) r.C多填++;
      else if (!gS && pS) r.A漏抽++;
      else if (!gS && !pS) r.B值不同++;
      else r.D无语义++;
      per.set(k, r);
      /* 跨 sheet 去重指纹（同一年同字段同 gold 同 pred） */
      const fp = `${y}|${field}|${g}|${p}`;
      seen.set(fp, (seen.get(fp) ?? 0) + 1);
    }
  }
}

console.log('\n字段                                sheet  n   ok    A漏抽  B值不同  C多填  D   gold有值  pred哨兵  空串  null');
for (const r of [...per.values()].sort((a, b) => (b.A漏抽 + b.B值不同) - (a.A漏抽 + a.B值不同)).slice(0, 25)) {
  console.log(`${r.field.padEnd(34)}${r.sheetKey.padEnd(7)}${String(r.n).padStart(4)}${String(r.ok).padStart(5)}`
    + `${String(r.A漏抽).padStart(7)}${String(r.B值不同).padStart(9)}${String(r.C多填).padStart(7)}${String(r.D无语义).padStart(4)}`
    + `${String(r.goldHas).padStart(9)}${String(r.predSent).padStart(9)}${String(r.emptyPred).padStart(7)}${String(r.nullPred).padStart(6)}`);
}
const dup = [...seen.entries()].filter(([, c]) => c > 1);
console.log(`\n跨 sheet 重复出现的 (year|field|gold|pred) 指纹数：${dup.length}`);
for (const [k, c] of dup.slice(0, 10)) console.log(`  ×${c}  ${k.slice(0, 120)}`);
