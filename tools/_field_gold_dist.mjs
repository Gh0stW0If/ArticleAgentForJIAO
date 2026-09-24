/**
 * 一次性探针：对"问题最集中"的字段，打印其 A/B 桶中 gold 值的分布与判定标签分布。
 * 用法：node tools/_field_gold_dist.mjs [topN]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOPN = Number(process.argv[2] ?? 12);
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const isSent = (s) => SENT.test(String(s ?? '')) || String(s ?? '').trim() === '';

const byField = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const field = String(j.field).replace(/^judged\./, '');
      const r = byField.get(field) ?? { field, n: 0, ok: 0, A: 0, B: 0, C: 0, goldA: new Map(), verdicts: new Map(), sampleA: [] };
      const g = String(j.gold ?? ''); const p = String(j.pred ?? '');
      const gS = isSent(g), pS = isSent(p);
      r.n++;
      const w = VERDICT_WEIGHT[j.verdict] ?? 0;
      r.verdicts.set(j.verdict, (r.verdicts.get(j.verdict) ?? 0) + 1);
      if (w >= 1) r.ok++;
      else if (gS && !pS) r.C++;
      else if (!gS && pS) {
        r.A++;
        r.goldA.set(g, (r.goldA.get(g) ?? 0) + 1);
        if (r.sampleA.length < 3) r.sampleA.push({ gold: g, pred: p, quote: String(j.quote ?? '').slice(0, 150) });
      } else if (!gS && !pS) r.B++;
      byField.set(field, r);
    }
  }
}
const rowsList = [...byField.values()].sort((a, b) => (b.A + b.B) - (a.A + a.B)).slice(0, TOPN);
for (const r of rowsList) {
  const top = [...r.goldA.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`\n── ${r.field}   n=${r.n} ok=${r.ok}(${((r.ok / r.n) * 100).toFixed(1)}%)  A漏抽=${r.A}  B值不同=${r.B}  C多填=${r.C}`);
  console.log(`   判定分布: ${[...r.verdicts.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (top.length) console.log(`   A桶 gold 值分布: ${top.map(([k, v]) => `${JSON.stringify(k)}=${v}`).join('  ')}`);
  for (const s of r.sampleA.slice(0, 2)) console.log(`   样例 gold=${JSON.stringify(s.gold)} pred=${JSON.stringify(s.pred)}\n        quote=${JSON.stringify(s.quote)}`);
}
