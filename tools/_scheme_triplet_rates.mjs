/**
 * 关键对照：同一批方案的 **`_desc`（原文） / `_value`（数） / `_unit`（单位编码）** 三列，各自的准确率。
 *
 * 背景：金标准本来就是**三列分工**的设计——
 *   `needle_retention_desc` = 原文/数值、`needle_retention_value` = 数、`needle_retention_unit` = 单位编码。
 * 所以问题不是"要不要拆成两个子字段"（金标准已经拆好了），
 * 而是"**我们抽 `_value`/`_unit` 这两列抽得怎么样**"。
 * 若 `_desc` 高、`_value`/`_unit` 低，说明"照抄原文"这条指令把模型框在了 desc 上、没去做归一化；
 * 若三者都低，说明瓶颈在召回。
 *
 * 用法：node tools/_scheme_triplet_rates.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

/** 每组：原始表格列名 + 三列 */
const TRIPLETS = [
  { zh: '留针时间', cols: ['needle_retention_desc', 'needle_retention_value', 'needle_retention_unit'], header: '留针时间 (单位：分钟, min)' },
  { zh: '疗程', cols: ['course_desc', 'course_value', 'course_unit'], header: '疗程（单位：天）' },
  { zh: '治疗频次', cols: ['frequency_desc', 'frequency_value', 'frequency_unit'], header: '治疗频次描述（标明单位）' },
  { zh: '最长随访', cols: ['max_followup_desc', 'max_followup_value', 'max_followup_unit'], header: '最长随访时间' },
];

/* 从 byField 取全部统计（含严格与语义两条路），与 tools/sheet1_fields.mjs 同源 */
const per = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const [rawKey, s] of Object.entries(rep.byField ?? {})) {
    const key = rawKey.replace(/^judged\./, '');
    if (!/^comparison\./.test(key)) continue;
    const field = key.slice('comparison.'.length);
    const c = per.get(field) ?? { hit: 0, half: 0, wrong: 0, missed: 0, judged: 0, strict: 0 };
    const n = s.hit + (s['code-hit'] ?? 0) + s.wrong + s.missed;
    c.hit += s.hit; c.half += s['code-hit'] ?? 0; c.wrong += s.wrong; c.missed += s.missed;
    if (rawKey.startsWith('judged.')) c.judged += n; else c.strict += n;
    per.set(field, c);
  }
}
const rateOf = (f) => {
  const c = per.get(f);
  if (!c) return null;
  const n = c.hit + c.half + c.wrong + c.missed;
  if (!n) return null;
  return { n, rate: ((c.hit + 0.5 * c.half) / n) * 100, missed: c.missed, wrong: c.wrong, half: c.half, judged: c.judged };
};

console.log('\n══ 同组三列的准确率对照（加权口径：半分=0.5）══\n');
for (const t of TRIPLETS) {
  console.log(`■ ${t.zh}　原始表头：${t.header}`);
  console.log('   列名                              样本   加权正确率   其中"没抽到"   语义判定  严格比对');
  for (const c of t.cols) {
    const r = rateOf(c);
    if (!r) { console.log(`   ${c.padEnd(34)}（无数据）`); continue; }
    console.log(`   ${c.padEnd(34)}${String(r.n).padStart(4)}   ${r.rate.toFixed(1).padStart(8)}%   ${String(r.missed).padStart(9)}   ${String(r.judged).padStart(7)}   ${String(r.strict).padStart(7)}`);
  }
  console.log();
}

/* 汇总：desc 三列 vs value/unit 六列 */
const descCols = TRIPLETS.flatMap((t) => [t.cols[0]]);
const valCols = TRIPLETS.flatMap((t) => [t.cols[1], t.cols[2]]);
const agg = (cols) => {
  let w = 0; let n = 0; let missed = 0;
  for (const c of cols) {
    const r = rateOf(c);
    if (!r) continue;
    w += (r.rate / 100) * r.n; n += r.n; missed += r.missed;
  }
  return n ? { n, rate: (w / n) * 100, missed } : null;
};
const a = agg(descCols); const b = agg(valCols);
console.log('══ 汇总 ══');
console.log(`  \`*_desc\`（原文列）   ${a.n} 条 → ${a.rate.toFixed(1)}%（没抽到 ${a.missed}）`);
console.log(`  \`*_value\` + \`*_unit\`（归一化列）  ${b.n} 条 → ${b.rate.toFixed(1)}%（没抽到 ${b.missed}）`);
console.log(`  → 差 ${(a.rate - b.rate).toFixed(1)} 个点`);
