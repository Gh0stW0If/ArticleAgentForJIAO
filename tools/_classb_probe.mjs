/**
 * 一次性探针：gold `total_sessions_class_b` 到底是什么？与 total_sessions / frequency_class 交叉。
 * 用法：node tools/_classb_probe.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const val = (o) => (o && typeof o === 'object' ? (o.raw ?? o.code ?? '') : (o ?? ''));
const rows = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of j.articles ?? []) {
    for (const g of a.comparisons ?? []) {
      rows.push({
        y, id: a.article_id,
        cs: String(val(g.total_sessions)).trim(),
        ca: String(val(g.total_sessions_class_a)).trim(),
        cb: String(val(g.total_sessions_class_b)).trim(),
        fc: String(val(g.frequency_class)).trim(),
        fv: String(val(g.frequency_value)).trim(),
        fu: String(val(g.frequency_unit)).trim(),
        cv: String(val(g.course_value)).trim(),
        cu: String(val(g.course_unit)).trim(),
      });
    }
  }
}
console.log(`comparison 组总数 = ${rows.length}`);

const hist = (key) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log('\ncb（治疗总次数分类）分布:', JSON.stringify(hist('cb').slice(0, 12)));
console.log('ca（治疗总次数治疗分类）分布:', JSON.stringify(hist('ca').slice(0, 12)));
console.log('fc（治疗频次分类）分布:', JSON.stringify(hist('fc').slice(0, 8)));

/* cb × fc */
const xt = new Map();
for (const r of rows) {
  if (!/^[0-9]+$/.test(r.cb)) continue;
  const k = `cb=${r.cb} fc=${r.fc}`;
  xt.set(k, (xt.get(k) ?? 0) + 1);
}
console.log('\n── cb × fc ──');
for (const [k, v] of [...xt.entries()].sort()) console.log(`  ${k}  ×${v}`);

/* cb × total_sessions（数值化） */
console.log('\n── cb 与 total_sessions 数值的关系 ──');
const byCb = new Map();
for (const r of rows) {
  if (!/^[0-9]+$/.test(r.cb)) continue;
  const n = Number((r.cs.match(/-?\d+(?:\.\d+)?/) ?? [NaN])[0]);
  if (!Number.isFinite(n)) continue;
  if (!byCb.has(r.cb)) byCb.set(r.cb, []);
  byCb.get(r.cb).push(n);
}
for (const [cb, arr] of [...byCb.entries()].sort()) {
  arr.sort((a, b) => a - b);
  const q = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  console.log(`  cb=${cb}  n=${arr.length}  min=${arr[0]}  p25=${q(0.25)}  中位=${q(0.5)}  p75=${q(0.75)}  max=${arr[arr.length - 1]}`);
}

/* cb 与 次数/疗程（总次数 = fv × 周数） */
console.log('\n── cb 样例（前 25 条，含频次/疗程/总次数）──');
let shown = 0;
for (const r of rows) {
  if (!/^[0-9]+$/.test(r.cb)) continue;
  console.log(`  cb=${r.cb} 总次数=${r.cs} 频次=${r.fv}/${r.fu} 疗程=${r.cv}/${r.cu} fc=${r.fc}  ${r.y} ${r.id}`);
  if (++shown >= 25) break;
}
