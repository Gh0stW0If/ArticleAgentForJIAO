/**
 * 一次性核算：`article.author_contact` 在"金标准确实有邮箱"的那批里，正确率是多少？
 *
 * ⚠️ 权重口径必须用 `tools/lib/judge.mjs` 的 `VERDICT_WEIGHT`：
 *   identical / same_meaning = 1，**contains_correct = 0.5**，has_error / completely_different = 0。
 *   把"半分"当满分算会系统性高估。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

/* ── ① 评测报告里的权威分桶（含全部判定条目，不止"有邮箱"的那些） ── */
console.log('=== 评测报告 byField（全部判定条目） ===');
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  const key = Object.keys(rep.byField ?? {}).find((k) => k.includes('author_contact'));
  if (!key) continue;
  const s = rep.byField[key];
  const den = s.hit + (s['code-hit'] ?? 0) + s.wrong + s.missed;
  const w = s.hit + 0.5 * (s['code-hit'] ?? 0);
  console.log(`  ${y}  ${key}  hit=${s.hit} 半=${s['code-hit'] ?? 0} wrong=${s.wrong} missed=${s.missed}`
    + `  → 加权 ${w}/${den} = ${((w / den) * 100).toFixed(1)}%`);
}

/* ── ② 只看"金标准含邮箱"的那批（来自 _author_contact_probe 的逐条明细） ── */
const rowsFile = join(ROOT, 'build', '_ac_rows.json');
if (!existsSync(rowsFile)) { console.log('\n（缺 build/_ac_rows.json，先跑 tools/_author_contact_probe.mjs）'); process.exit(0); }
const rows = JSON.parse(readFileSync(rowsFile, 'utf8'));

console.log('\n=== 只看"金标准含邮箱"：加权口径（半分 = 0.5） ===');
console.log('  年份   含邮箱   满分   半分    错    加权正确率    全对率');
let TH = 0; let TN = 0;
for (const y of YEARS) {
  const rs = rows.filter((r) => r.year === y);
  if (!rs.length) continue;
  const full = rs.filter((r) => VERDICT_WEIGHT[r.verdict] === 1).length;
  const half = rs.filter((r) => VERDICT_WEIGHT[r.verdict] === 0.5).length;
  const bad = rs.length - full - half;
  const w = rs.reduce((a, r) => a + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
  TH += w; TN += rs.length;
  console.log(`  ${y}     ${String(rs.length).padStart(3)}    ${String(full).padStart(3)}    ${String(half).padStart(3)}`
    + `    ${String(bad).padStart(3)}      ${((w / rs.length) * 100).toFixed(1)}%`.padEnd(11)
    + `      ${((full / rs.length) * 100).toFixed(1)}%`);
}
console.log(`\n  合计 ${TN} 条 → 加权 ${TH.toFixed(1)}/${TN} = ${((TH / TN) * 100).toFixed(1)}%`);

const y2020 = rows.filter((r) => r.year === '2020');
const full20 = y2020.filter((r) => VERDICT_WEIGHT[r.verdict] === 1).length;
const half20 = y2020.filter((r) => VERDICT_WEIGHT[r.verdict] === 0.5).length;
const w20 = y2020.reduce((a, r) => a + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
console.log(`\n── 2020 单年 ──`);
console.log(`  金标准含邮箱：${y2020.length} 条`);
console.log(`  满分 ${full20} 条｜半分 ${half20} 条｜错 ${y2020.length - full20 - half20} 条`);
console.log(`  **加权正确率 ${w20}/${y2020.length} = ${((w20 / y2020.length) * 100).toFixed(1)}%**｜全对率 ${((full20 / y2020.length) * 100).toFixed(1)}%`);
