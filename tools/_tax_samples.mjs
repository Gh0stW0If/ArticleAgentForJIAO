/**
 * 一次性探针：看某字段的 gold/pred/quote 原文样例。
 * 用法：node tools/_tax_samples.mjs <字段名> [条数] [年]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 12);
const YEAR = process.argv[4] ?? null;
const YEARS = YEAR ? [YEAR] : ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const isSent = (s) => SENT.test(String(s ?? '')) || String(s ?? '').trim() === '';

let shown = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const field = String(j.field).replace(/^judged\./, '');
      if (field !== FIELD) continue;
      if (shown >= LIMIT) break;
      const g = String(j.gold ?? ''); const p = String(j.pred ?? '');
      console.log(`\n[${y} ${key}] verdict=${j.verdict}  gold哨兵=${isSent(g)} pred哨兵=${isSent(p)}`);
      console.log(`  gold: ${JSON.stringify(g).slice(0, 200)}`);
      console.log(`  pred: ${JSON.stringify(p).slice(0, 200)}`);
      if (j.quote) console.log(`  quote: ${JSON.stringify(String(j.quote)).slice(0, 260)}`);
      if (j.reason) console.log(`  reason: ${JSON.stringify(String(j.reason)).slice(0, 200)}`);
      shown++;
    }
  }
}
console.log(`\n共显示 ${shown} 条`);
