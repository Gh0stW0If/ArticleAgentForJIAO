/**
 * 金标准的**时点归属**可疑检测 → 记入 `build/gold_anomalies.json`。
 *
 * 起因（2024-12 之后的第二个"整列抽不出来"之谜）：
 * 报告 §2.1.1 一直挂着三列"基线组间差值"（BDEST/BDLVAR/BDUVAR）抽不出来。
 * 逐篇核对发现**不是我们没抽**，而是金标准把差值记错了时点：
 *
 *   2023-27：论文只在 week 12（疗程结束）报告 ACR20/50/70 的组间差值
 *   （`difference vs. sham, −1.9; 95% CI, −18.8, 14.9`），
 *   而金标准把 6 行 × 3 个差值全填进了 **baseline** 块，`end_of_treatment` / `follow_up_end` 全空。
 *
 * 判据（严格，只在有把握时记）：
 *   某一行**只有基线块里有组间差值**，而该行的疗程结束/随访块里**一个数值都没有**
 *   （没有 events、没有差值）——即"这篇论文的差值只可能属于基线之外的时点，却被记在基线"。
 *
 * 用法：
 *   node tools/gold_timepoint_anomalies.mjs           # 检测并合并写入（不参与评分）
 *   node tools/gold_timepoint_anomalies.mjs --dry     # 只看不写
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REASON = '金标准把组间差值记在基线时点，但该行的疗程结束/随访块为空（时点归属可疑）';
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const filled = (v) => Boolean(v && typeof v === 'object' && 'raw' in v && String(v.raw).trim() && !/^(NR|NA|NE)$/i.test(String(v.raw).trim()));
/** 一个时点块里有多少个"有值的数值"。 */
const valueCount = (block) => {
  let n = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if ('raw' in o) { if (filled(o)) n++; return; }
    Object.values(o).forEach(walk);
  };
  walk(block);
  return n;
};

const findings = [];
const stat = { rows: 0, laterEmpty: 0, kept: 0 };
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    for (const [i, o] of (a.outcomes ?? []).entries()) {
      const tps = o.timepoints ?? {};
      const baseBin = tps.baseline?.binary;
      if (!baseBin) continue;
      stat.rows++;
      const baseDiffKeys = ['difference_estimate', 'difference_ci_lower', 'difference_ci_upper']
        .filter((k) => filled(baseBin[k]));
      if (!baseDiffKeys.length) continue;
      /* 该行的其它时点必须**完全没有数值**，否则基线有差值也说得通（论文确实做了基线比较） */
      const laterFilled = ['end_of_treatment', 'follow_up_end']
        .reduce((n, tp) => n + valueCount(tps[tp]), 0);
      if (laterFilled > 0) { stat.kept++; continue; }
      stat.laterEmpty++;
      for (const k of baseDiffKeys) {
        findings.push({
          year: y,
          articleId: a.article_id,
          scope: 'outcome',
          field: `timepoints.${k === 'difference_estimate' ? 'difference' : k}`,
          value: String(baseBin[k].raw),
          reason: `${REASON}：第 ${i + 1} 行「${o.outcome?.name?.raw ?? '?'}」只有基线块有组间差值，`
            + '疗程结束与随访块一个数值都没有——请确认该差值是否本应记在别的时点',
        });
      }
    }
  }
}

console.log(`\n时点归属核对（${stat.rows} 个含基线二分类块的行）：`);
console.log(`  基线有差值且后续时点**也**有数值（合理，保留）：${stat.kept}`);
console.log(`  基线有差值但后续时点全空（可疑）：${stat.laterEmpty} 行 → 记录 ${findings.length} 个值`);
for (const f of findings.slice(0, 8)) console.log(`    ${f.articleId} ${f.reason.split('：').slice(1).join('：').slice(0, 90)}`);

if (process.argv.includes('--dry')) {
  console.log('\n（--dry：未写入）');
  process.exit(0);
}

const file = join(ROOT, 'build', 'gold_anomalies.json');
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { at: null, years: [], total: 0, byReason: {}, anomalies: [] };
/* 合并语义：只替换本工具这一种 reason，其他工具的发现原样保留 */
const kept = (prev.anomalies ?? []).filter((a) => !String(a.reason ?? '').startsWith(REASON));
const merged = [...kept, ...findings];
const byReason = {};
for (const a of merged) byReason[a.reason] = (byReason[a.reason] ?? 0) + 1;
writeFileSync(file, JSON.stringify({ ...prev, at: new Date().toISOString(), total: merged.length, byReason, anomalies: merged }, null, 2), 'utf8');
console.log(`\n已合并进 build/gold_anomalies.json（总 ${merged.length} 条）\n`);
