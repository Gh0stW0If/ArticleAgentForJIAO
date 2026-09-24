/**
 * 整体准确率汇总（**统一口径**）：把各年 `build/eval/<year>.json` 重新聚合。
 *
 * 为什么要"重新聚合"而不是直接读 `sheets`：
 *   1. `llm_eval.mjs` 原来用**二分法**分语义判定结果
 *      （`judgedOutcome = !field.startsWith('study.')`），把 `article.*` / `comparison.*`
 *      的语义条目**并进了 Sheet3**（实测 2015 年 224 条里 158 条本属 Sheet1）。
 *      2015 已修，2016–2025 的旧报告仍是错分组 → 直接读 `sheets.sheet3.rate` 会失真。
 *   2. 加权口径必须统一：`identical`/`same_meaning`=1、**`contains_correct`=0.5**
 *      （`tools/lib/judge.mjs` 的 `VERDICT_WEIGHT`）。
 *
 * 因此这里**按字段前缀重新分组**：
 *   `article.`/`comparison.` → Sheet1；`study.` → Sheet2；其余 → Sheet3。
 *
 * 用法：node tools/accuracy_overview.mjs [--year 2015] [--by-year] [--json]
 */

import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const BY_YEAR = argv.includes('--by-year');
const AS_JSON = argv.includes('--json');
const YEARS = ONLY_YEAR ? [ONLY_YEAR] : ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

/** 字段前缀 → 金标准工作表 */
const sheetOf = (field) => {
  const f = String(field).replace(/^judged\./, '');
  if (/^(article|comparison)\./.test(f)) return 1;
  if (/^study\./.test(f)) return 2;
  return 3;
};

const empty = () => ({ n: 0, w: 0, strictN: 0, strictW: 0, judgeN: 0, judgeW: 0 });
const add = (a, b) => { a.n += b.n; a.w += b.w; a.strictN += b.strictN; a.strictW += b.strictW; a.judgeN += b.judgeN; a.judgeW += b.judgeW; };

const perYear = [];
const cells = { 1: empty(), 2: empty(), 3: empty() };

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  const sheets = { 1: empty(), 2: empty(), 3: empty() };

  /* ① 严格比对部分：各 sheet 的 strict 桶直接归位 */
  for (const [key, idx] of [['sheet1', 1], ['sheet2', 2], ['sheet3', 3]]) {
    const st = rep.sheets?.[key]?.strict;
    if (!st) continue;
    const n = st.hit + (st['code-hit'] ?? 0) + st.wrong + st.missed;
    const w = st.hit + 0.5 * (st['code-hit'] ?? 0);
    sheets[idx].strictN += n; sheets[idx].strictW += w;
    sheets[idx].n += n; sheets[idx].w += w;
  }

  /* ② 语义判定部分：**按字段前缀重新分组**（不信任报告里的 sheet 归属） */
  let regrouped = 0;
  for (const key of ['sheet1', 'sheet2', 'sheet3']) {
    for (const j of rep.sheets?.[key]?.judged ?? []) {
      const idx = sheetOf(j.field);
      const w = VERDICT_WEIGHT[j.verdict] ?? 0;
      sheets[idx].judgeN++; sheets[idx].judgeW += w;
      sheets[idx].n++; sheets[idx].w += w;
      if (idx !== Number(key.slice(-1))) regrouped++;
    }
  }

  for (const idx of [1, 2, 3]) add(cells[idx], sheets[idx]);
  perYear.push({ year: y, sheets, mtime: statSync(f).mtime, regrouped });
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const tot = empty();
for (const idx of [1, 2, 3]) add(tot, cells[idx]);

if (AS_JSON) {
  const payload = JSON.stringify({
    total: { n: tot.n, w: tot.w, rate: tot.n ? (tot.w / tot.n) * 100 : 0 },
    sheets: Object.fromEntries([1, 2, 3].map((i) => [i, { n: cells[i].n, w: cells[i].w, rate: cells[i].n ? (cells[i].w / cells[i].n) * 100 : 0 }])),
    perYear: perYear.map((p) => ({ year: p.year, sheets: Object.fromEntries([1, 2, 3].map((i) => [i, { n: p.sheets[i].n, rate: p.sheets[i].n ? (p.sheets[i].w / p.sheets[i].n) * 100 : 0 }])) })),
  }, null, 1);
  /*
   * ⚠️ 用 `--out` 让**工具自己写文件**。若靠 shell 重定向（`> x.json`），
   * PowerShell 会写成带 BOM 的编码，`require()`/`JSON.parse` 直接报
   * "Unexpected token '\uFFFD'"（实测踩过）。
   */
  const OUT = arg('out', null);
  if (OUT) { writeFileSync(resolve(ROOT, OUT), payload, 'utf8'); console.log(`已写入 ${OUT}`); }
  else console.log(payload);
  process.exit(0);
}

console.log('\n══ 整体准确率（统一口径：按字段前缀重新分组 + 加权，半分=0.5）══\n');
console.log('  工作表                     字段数     加权得分      准确率');
const LABEL = { 1: 'Sheet1（文章级+比较组）', 2: 'Sheet2（结局分类）', 3: 'Sheet3（结局×时点）' };
for (const idx of [1, 2, 3]) {
  const c = cells[idx];
  console.log(`  ${LABEL[idx].padEnd(24)}${String(c.n).padStart(6)}   ${c.w.toFixed(1).padStart(9)}   ${pc(c.w, c.n).padStart(8)}`);
}
console.log(`  ${'合计'.padEnd(24)}${String(tot.n).padStart(6)}   ${tot.w.toFixed(1).padStart(9)}   ${pc(tot.w, tot.n).padStart(8)}`);
console.log(`\n  （严格逐字 ${tot.strictW.toFixed(1)}/${tot.strictN} = ${pc(tot.strictW, tot.strictN)}`
  + `；语义判定 ${tot.judgeW.toFixed(1)}/${tot.judgeN} = ${pc(tot.judgeW, tot.judgeN)}）`);

if (BY_YEAR) {
  console.log('\n  分年：');
  console.log('   年份   Sheet1              Sheet2        Sheet3              合计');
  for (const p of perYear) {
    const t = empty();
    for (const idx of [1, 2, 3]) add(t, p.sheets[idx]);
    const cell = (idx) => `${pc(p.sheets[idx].w, p.sheets[idx].n).padStart(6)}(${p.sheets[idx].n})`.padEnd(13);
    console.log(`   ${p.year}  ${cell(1)}${cell(2)}${cell(3)}${pc(t.w, t.n).padStart(7)}(${t.n})`);
  }
}

console.log('\n  ⚠ 口径成分（务必一起读）：');
const stale = perYear.filter((p) => p.regrouped > 0);
console.log(`     · 重新分组的条目：${stale.reduce((a, p) => a + p.regrouped, 0)} 条（2016–2025 的旧报告按二分法把 Sheet1 的描述字段并进了 Sheet3）`);
const months = [...new Set(perYear.map((p) => p.mtime.toLocaleDateString('zh-CN')))];
console.log(`     · 评测报告生成日期：${months.join('、')}`);
console.log('     · 抽取产物是否为同一版管线：见 `node tools/_pipeline_freshness.mjs`');
console.log('');
