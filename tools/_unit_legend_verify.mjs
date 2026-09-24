/**
 * 核实：`max_followup_unit` / `course_unit` / `frequency_unit` 的编码含义，
 * 到底是金标准里的哪一套？（提示词里的编码表若与金标准不一致，模型会被系统性地带错）
 *
 * 三个独立来源交叉验证：
 *   ① `build/gold/<year>.json` 里的图例/列定义；
 *   ② `tools/canonical-field-map.mjs`（生成提示词用的那份）；
 *   ③ **数据自证**：把 `_desc` 的原文单位与 `_unit` 的编码做交叉表——
 *      编码含义正确时，交叉表应该近似对角。
 *
 * 用法：node tools/_unit_legend_verify.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const code = (o) => (o && typeof o === 'object' && 'code' in o ? String(o.code ?? '') : '');

/* ---------- ① 金标准里的图例 ---------- */
console.log('\n══ ① 金标准 JSON 里的图例定义 ══\n');
let found = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  const defs = gold.field_definitions ?? gold.column_map ?? {};
  const flat = JSON.stringify(defs);
  for (const key of ['max_followup_unit', 'course_unit', 'frequency_unit', 'needle_retention_unit']) {
    if (!flat.includes(key)) continue;
    /* 从 JSON 结构里找该列的定义对象 */
    const stack = [defs];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      for (const [k, v] of Object.entries(o)) {
        if (k === key && v && typeof v === 'object') {
          console.log(`  ${y} ${key}: ${JSON.stringify(v).slice(0, 260)}`);
          found++;
        } else if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  if (found) break;   // 各年结构相同，看一年就够
}
if (!found) console.log('  （金标准 JSON 里没有直接的列图例对象，见 ② ③）');

/* ---------- ② 生成提示词用的那份 ---------- */
console.log('\n══ ② tools/canonical-field-map.mjs（提示词来源）══\n');
const m = await import('./canonical-field-map.mjs');
for (const k of ['maxFollowupUnit', 'courseUnit', 'frequencyUnit', 'needleRetentionUnit']) {
  const f = [...m.COMPARISON_FIELDS].find((x) => x.key === k);
  console.log(`  ${k}: ${JSON.stringify(f?.codes ?? null)}`);
}

/* ---------- ③ 数据自证：desc 单位 × unit 编码 的交叉表 ---------- */
console.log('\n══ ③ 数据自证：`_desc` 原文单位 × `_unit` 编码 ══\n');
const UNIT_WORDS = [
  [/^(seconds?|secs?|秒)/i, '秒'], [/^(minutes?|mins?|分钟)/i, '分钟'], [/^(hours?|hrs?|小时)/i, '小时'],
  [/^(days?|天)/i, '天'], [/^(weeks?|wks?|周)/i, '周'], [/^(months?|月)/i, '月'], [/^(years?|yrs?|年)/i, '年'],
];
const wordOf = (s) => {
  const t = String(s ?? '').trim().replace(/^\d+(?:\.\d+)?(?:[-–~]\d+(?:\.\d+)?)?\s*/, '');
  for (const [re, zh] of UNIT_WORDS) if (re.test(t)) return zh;
  return null;
};

for (const [group, descK, unitK] of [['最长随访', 'max_followup_desc', 'max_followup_unit'], ['疗程', 'course_desc', 'course_unit'], ['留针时间', 'needle_retention_desc', 'needle_retention_unit']]) {
  const table = new Map();
  for (const y of YEARS) {
    const f = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(f)) continue;
    const gold = JSON.parse(readFileSync(f, 'utf8'));
    for (const a of gold.articles ?? []) {
      for (const c of a.comparisons ?? []) {
        const w = wordOf(raw(c[descK])); const u = code(c[unitK]);
        if (!w || !u) continue;
        const k = `${w}|${u}`;
        table.set(k, (table.get(k) ?? 0) + 1);
      }
    }
  }
  const codes = [...new Set([...table.keys()].map((k) => k.split('|')[1]))].sort();
  const words = [...new Set([...table.keys()].map((k) => k.split('|')[0]))];
  console.log(`■ ${group}（${descK} × ${unitK}）`);
  console.log('   原文单位'.padEnd(10) + codes.map((c) => `code ${c}`.padStart(9)).join(''));
  for (const w of words) {
    const cells = codes.map((c) => String(table.get(`${w}|${c}`) ?? 0).padStart(9));
    console.log(`   ${w.padEnd(11)}${cells.join('')}`);
  }
  /* 每列取最大者 → 推断该 code 的含义 */
  const infer = {};
  for (const c of codes) {
    let best = null; let bestN = 0;
    for (const w of words) { const n = table.get(`${w}|${c}`) ?? 0; if (n > bestN) { bestN = n; best = w; } }
    infer[c] = `${best}(${bestN})`;
  }
  console.log(`   → 按多数推断：${JSON.stringify(infer)}`);
  console.log();
}
