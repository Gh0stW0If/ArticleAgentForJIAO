/**
 * 量化"过度填充"：金标准说 `NR`（没报告），模型却填了具体编码/数值。
 *
 * 这是 `*_value` / `*_unit` 这类**编码列**的失分主因猜想。若成立，
 * 那么"鼓励模型输出归一化值"的改动会**加剧**问题——必须同时给一条硬约束：
 * **只有原文给出明确数值+单位时才填编码；只有定性描述时三列都填 NR。**
 *
 * 用法：node tools/_overfill_audit.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';

/** 关注这 8 列（4 组 × value/unit） */
const TARGETS = [
  'comparison.needle_retention_value', 'comparison.needle_retention_unit',
  'comparison.course_value', 'comparison.course_unit',
  'comparison.frequency_value', 'comparison.frequency_unit',
  'comparison.max_followup_value', 'comparison.max_followup_unit',
];

const per = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const sheet of Object.values(rep.sheets ?? {})) {
    for (const j of sheet.judged ?? []) {
      const field = String(j.field);
      if (!TARGETS.includes(field)) continue;
      const arr = per.get(field) ?? [];
      arr.push({ id: String(j.key).split('/')[0], verdict: j.verdict, gold: String(j.gold ?? ''), pred: String(j.pred ?? '') });
      per.set(field, arr);
    }
  }
}

console.log('\n══ 过度填充审计：金标准=NR 而模型给了值 ══\n');
console.log('  列名                                  语义条目   金标准NR的   其中被填了值   该组加权正确率');
let totOver = 0; let totN = 0;
const overRows = [];
for (const t of TARGETS) {
  const rows = per.get(t) ?? [];
  if (!rows.length) continue;
  const goldSent = rows.filter((r) => isSent(r.gold));
  const over = goldSent.filter((r) => !isSent(r.pred));
  const w = rows.reduce((a, r) => a + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
  totOver += over.length; totN += rows.length;
  console.log(`  ${t.replace('comparison.', '').padEnd(30)}${String(rows.length).padStart(6)}${String(goldSent.length).padStart(11)}${String(over.length).padStart(14)}   ${((w / rows.length) * 100).toFixed(1).padStart(8)}%`);
  for (const r of over.slice(0, 3)) overRows.push({ t, ...r });
}

console.log(`\n  合计：${totN} 条语义条目里 **${totOver} 条（${((totOver / totN) * 100).toFixed(1)}%）是"金标准说没报告、模型却填了值"**`);

/* 反方向：金标准有值、模型答 NR（漏抽） */
console.log('\n══ 反向审计：金标准有值、模型答 NR/NA（漏抽）══\n');
let totMiss = 0;
for (const t of TARGETS) {
  const rows = per.get(t) ?? [];
  if (!rows.length) continue;
  const goldHas = rows.filter((r) => !isSent(r.gold));
  const miss = goldHas.filter((r) => isSent(r.pred));
  totMiss += miss.length;
  console.log(`  ${t.replace('comparison.', '').padEnd(30)}金标准有值 ${String(goldHas.length).padStart(4)}｜其中模型答 NR ${String(miss.length).padStart(4)}（${((miss.length / (goldHas.length || 1)) * 100).toFixed(0)}%）`);
}
console.log(`\n  合计漏抽：${totMiss} 条`);

console.log('\n  过度填充样例：');
for (const r of overRows.slice(0, 12)) console.log(`   ${r.id}  ${r.t.replace('comparison.', '')}  金标准=${JSON.stringify(r.gold)}  机器=${JSON.stringify(r.pred)}  [${r.verdict}]`);
