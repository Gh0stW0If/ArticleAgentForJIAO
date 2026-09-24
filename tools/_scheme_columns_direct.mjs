/**
 * 干净口径：**逐比较组直接比对**预测与金标准（不经过评测报告的 judged 子集）。
 *
 * 为什么必须这样：`sheets.*.judged` 只包含"无法严格比对"的条目——
 * 对 `*_value`/`*_unit` 这类编码列，它**恰好就是失败子集**，
 * 在里面统计"漏抽率"会得到"96% 漏抽"这种同义反复的假结论。
 *
 * 四类互斥结论（每列各自统计）：
 *   ① 两边都是哨兵值 → 正确（一致地报"没报告"）
 *   ② 金标准有值、模型也有值 → 比对数值/编码
 *   ③ 金标准有值、模型答哨兵 → **漏抽**
 *   ④ 金标准是哨兵、模型有值 → **过度填充**
 *
 * 用法：node tools/_scheme_columns_direct.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const codeOf = (o) => (o && typeof o === 'object' && 'code' in o && o.code ? String(o.code) : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';

const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const COLS = [
  ['needle_retention_desc', '留针时间-描述'], ['needle_retention_value', '留针时间-数值'], ['needle_retention_unit', '留针时间-单位'],
  ['course_desc', '疗程-描述'], ['course_value', '疗程-数值'], ['course_unit', '疗程-单位'],
  ['frequency_desc', '治疗频次-描述'], ['frequency_value', '治疗频次-数值'], ['frequency_unit', '治疗频次-单位'],
  ['max_followup_desc', '最长随访-描述'], ['max_followup_value', '最长随访-数值'], ['max_followup_unit', '最长随访-单位'],
];

const stats = new Map();
const bump = (col, kind) => {
  const s = stats.get(col) ?? { both: 0, sentBoth: 0, miss: 0, over: 0, diff: 0, other: 0, n: 0 };
  s[kind]++; s.n++;
  stats.set(col, s);
};

for (const y of YEARS) {
  const d = join(ROOT, 'build', 'extraction', y);
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(d) || !existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    const pf = join(d, `${a.article_id}.json`);
    if (!existsSync(pf)) continue;
    let pred;
    try { pred = JSON.parse(readFileSync(pf, 'utf8')); } catch { continue; }
    const gcs = a.comparisons ?? [];
    const pcs = pred.comparisons ?? [];
    for (let i = 0; i < gcs.length; i++) {
      const g = gcs[i]; const p = pcs[i];
      if (!p) continue;
      for (const [key] of COLS) {
        const gLeaf = g[key]; const pLeaf = p[CAMEL(key)];
        if (gLeaf === undefined && pLeaf === undefined) continue;
        const gv = raw(gLeaf); const pv = raw(pLeaf);
        const gc = codeOf(gLeaf); const pc = codeOf(pLeaf);
        const gSent = isSent(gv); const pSent = isSent(pv);
        /* 编码列：金标准有 code 才算"有值"（`raw` 可能是中文含义） */
        const gHas = key.endsWith('_unit') ? !!gc : !gSent;
        const pHas = key.endsWith('_unit') ? !!pc : !pSent;
        if (gSent && pSent) { bump(key, 'sentBoth'); continue; }
        if (gHas && pHas) {
          const same = key.endsWith('_unit') ? gc === pc : gv.replace(/\s+/g, '') === pv.replace(/\s+/g, '');
          bump(key, same ? 'both' : 'diff');
          continue;
        }
        if (gHas && !pHas) { bump(key, 'miss'); continue; }
        if (!gHas && pHas) { bump(key, 'over'); continue; }
        bump(key, 'other');
      }
    }
  }
}

console.log('\n══ 逐比较组直接比对（全部语料，不经 judged 子集）══\n');
console.log('  列名                 样本   一致报NR   值一致   值不同   **漏抽**   **过度填充**');
const agg = { both: 0, sentBoth: 0, miss: 0, over: 0, diff: 0, other: 0, n: 0 };
for (const [key, label] of COLS) {
  const s = stats.get(key);
  if (!s) continue;
  for (const k of Object.keys(agg)) agg[k] += s[k];
  console.log(`  ${label.padEnd(18)}${String(s.n).padStart(6)}${String(s.sentBoth).padStart(10)}${String(s.both).padStart(9)}${String(s.diff).padStart(8)}${String(s.miss).padStart(10)}${String(s.over).padStart(12)}`);
}
console.log(`  ${'合计'.padEnd(18)}${String(agg.n).padStart(6)}${String(agg.sentBoth).padStart(10)}${String(agg.both).padStart(9)}${String(agg.diff).padStart(8)}${String(agg.miss).padStart(10)}${String(agg.over).padStart(12)}`);

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n  占比：一致报NR ${pc(agg.sentBoth, agg.n)}｜值一致 ${pc(agg.both, agg.n)}｜值不同 ${pc(agg.diff, agg.n)}`
  + `｜**漏抽 ${pc(agg.miss, agg.n)}**｜**过度填充 ${pc(agg.over, agg.n)}**`);
console.log('\n  → 12 列合起来的直观准确率（值一致 + 一致报NR）'
  + `：${pc(agg.both + agg.sentBoth, agg.n)}`);
