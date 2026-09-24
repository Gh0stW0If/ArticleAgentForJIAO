/**
 * Europe PMC 题名补全的**效果预测**（确定性路径，可直接算，不必等 LLM 重跑）。
 *
 * 原理：`verifyWithEuropePmc` 的补全判据只看两个字符串（我们抽到的题名、EPMC 题名），
 * 一旦成立就用 EPMC 题名替换——**结果与模型输出无关**。
 * 因此可以用已有数据（金标准题名、当前题名、EPMC 题名）把效果直接算出来，
 * 再用小批实测确认端到端接线正确。
 *
 * 用法：node tools/_epmc_title_forecast.mjs
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titlePrefixGain, normalizeForCompare } from '../packages/europepmc/dist/index.js';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(ROOT, 'build', 'europepmc_meta.json'), 'utf8'));
const rows = meta.rows.filter((r) => r.epmc);

/** 评测里的语义判定口径：完全一致 / 一方包含另一方 → 记 1（题名场景下"含副标题"视为一致）。 */
const titleEquivalent = (a, b) => {
  const x = normalizeForCompare(a); const y = normalizeForCompare(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

let willFire = 0; let goldAfter = 0; let gainSum = 0;
const fired = [];
for (const r of rows) {
  if (!titlePrefixGain(r.predTitle, r.epmc.title)) continue;
  willFire++;
  const before = VERDICT_WEIGHT[r.vTitle] ?? 0;
  const afterGold = titleEquivalent(r.epmc.title, r.goldTitle);
  const after = afterGold ? 1 : before;      // 只有补全后与金标准一致才算提升；否则至少不降级
  goldAfter += afterGold ? 1 : 0;
  gainSum += after - before;
  fired.push({ id: r.id, vTitle: r.vTitle, before, after, afterGold, ours: r.predTitle, epmc: r.epmc.title, gold: r.goldTitle });
}

console.log(`\n══ Europe PMC 题名补全：效果预测 ══\n`);
console.log(`  EPMC 取回：${rows.length} 篇`);
console.log(`  满足补全判据（我们的是 EPMC 的真前缀且短 ≥8 字符）：**${willFire} 篇**`);
console.log(`  补全后与金标准一致：**${goldAfter} 篇**`);
console.log(`  加权分变化：+${gainSum.toFixed(1)} 分（题名字段分母约 ${meta.rows.filter((r) => r.vTitle).length}）`);
console.log(`  当前 title 字段加权分：${meta.rows.filter((r) => r.vTitle).reduce((a, r) => a + (VERDICT_WEIGHT[r.vTitle] ?? 0), 0).toFixed(1)}`);

console.log('\n  逐条（前 20）：');
for (const f of fired.slice(0, 20)) {
  console.log(`   ${f.id}  [${f.vTitle}] → ${f.afterGold ? '✅ 补全后=金标准' : '⚠️ 补全后仍与金标准不符'}`);
  console.log(`     原值: ${String(f.ours).slice(0, 84)}`);
  console.log(`     EPMC: ${String(f.epmc).slice(0, 84)}`);
  if (!f.afterGold) console.log(`     金标准: ${String(f.gold).slice(0, 84)}`);
}
