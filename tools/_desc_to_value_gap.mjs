/**
 * 决定性一测：模型填了 `*_desc`（原文），**但 `*_value`/`*_unit` 没填或填错**的情况有多少？
 *
 * 这是在验证用户提议里最有价值的那一半：
 *   "原文证据 + 输出值两个子字段" —— 金标准本来就是三列分工
 *   （`_desc` 原文 / `_value` 数 / `_unit` 单位编码）。
 * 若"desc 有、value/unit 没有"很常见，说明**该把 value/unit 做成从 desc 的确定性派生**，
 * 而不是继续指望模型在一条提示里同时干两件事。
 *
 * 用法：node tools/_desc_to_value_gap.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^(NR|NA|NE)\.?$/i;
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const has = (s) => !!String(s ?? '').trim() && !SENT.test(String(s).trim());

const TRIPLETS = [
  { zh: '留针时间', desc: 'needleRetentionDesc', value: 'needleRetentionValue', unit: 'needleRetentionUnit' },
  { zh: '疗程', desc: 'courseDesc', value: 'courseValue', unit: 'courseUnit' },
  { zh: '治疗频次', desc: 'frequencyDesc', value: 'frequencyValue', unit: 'frequencyUnit' },
  { zh: '最长随访', desc: 'maxFollowupDesc', value: 'maxFollowupValue', unit: 'maxFollowupUnit' },
];

const stat = new Map();
const samples = new Map();
for (const t of TRIPLETS) { stat.set(t.zh, { descOnly: 0, descPlus: 0, neither: 0, valueOnly: 0 }); samples.set(t.zh, []); }

for (const y of YEARS) {
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let p;
    try { p = JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { continue; }
    for (const c of p.comparisons ?? []) {
      for (const t of TRIPLETS) {
        const dv = raw(c[t.desc]); const vv = raw(c[t.value]); const uv = raw(c[t.unit]);
        const dOk = has(dv); const vOk = has(vv) || has(uv);
        const s = stat.get(t.zh);
        if (dOk && vOk) s.descPlus++;
        else if (dOk && !vOk) {
          s.descOnly++;
          const arr = samples.get(t.zh);
          if (arr.length < 6) arr.push(`${f.replace('.json', '')}  desc=${JSON.stringify(dv.slice(0, 40))}  value=${JSON.stringify(vv)}  unit=${JSON.stringify(uv)}`);
        } else if (!dOk && vOk) s.valueOnly++;
        else s.neither++;
      }
    }
  }
}

console.log('\n══ "填了原文 desc、但 value/unit 没填" 的比例 ══\n');
console.log('  组          两者都有   **只有 desc**   只有 value/unit   两者都无');
let totDescOnly = 0; let tot = 0;
for (const t of TRIPLETS) {
  const s = stat.get(t.zh);
  const n = s.descOnly + s.descPlus + s.valueOnly + s.neither;
  tot += n; totDescOnly += s.descOnly;
  console.log(`  ${t.zh.padEnd(8)}${String(s.descPlus).padStart(7)}   ${String(s.descOnly).padStart(11)}（${((s.descOnly / n) * 100).toFixed(0)}%）   ${String(s.valueOnly).padStart(12)}   ${String(s.neither).padStart(9)}`);
}
console.log(`\n  合计：${tot} 条里 **${totDescOnly} 条（${((totDescOnly / tot) * 100).toFixed(1)}%）填了原文却没填归一化数值**`);

for (const t of TRIPLETS) {
  const arr = samples.get(t.zh);
  if (!arr.length) continue;
  console.log(`\n  ── ${t.zh} 的样例（这些正是"从 desc 确定性派生 value/unit"的输入）──`);
  for (const s of arr) console.log(`   ${s}`);
}
