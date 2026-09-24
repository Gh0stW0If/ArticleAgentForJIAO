/**
 * 定标：金标准的**单位换算约定**是什么？（1 个月 = 几周？）
 *
 * 为什么必须先查：写归一化器时用"物理换算"（1 月 = 4.345 周）会与金标准对不上，
 * 必须用**标注者的约定**。实测线索：`course_desc="3 months"` 对应的
 * `course_value="12"`、`course_unit="2"`（周）→ 疑似 1 月 = 4 周。
 *
 * 用法：node tools/_unit_convention_scale.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const code = (o) => (o && typeof o === 'object' && 'code' in o ? String(o.code ?? '') : '');

/** 单位编码表（来自 tools/canonical-field-map.mjs） */
const LEGEND = {
  course_unit: { 1: '天', 2: '周' },
  needle_retention_unit: { 1: '分钟', 2: '小时' },
  frequency_unit: { 1: '天', 2: '周', 3: '1小时' },
  max_followup_unit: { 1: '天', 2: '月', 3: '年', 4: '周', 5: '小时' },
};

const TRIPLETS = [
  { zh: '疗程', desc: 'course_desc', value: 'course_value', unit: 'course_unit' },
  { zh: '留针时间', desc: 'needle_retention_desc', value: 'needle_retention_value', unit: 'needle_retention_unit' },
  { zh: '治疗频次', desc: 'frequency_desc', value: 'frequency_value', unit: 'frequency_unit' },
  { zh: '最长随访', desc: 'max_followup_desc', value: 'max_followup_value', unit: 'max_followup_unit' },
];

/** 从 desc 里抠出 (数, 原文单位)。 */
const UNIT_WORDS = [
  [/^seconds?|secs?|秒/i, '秒'], [/^minutes?|mins?|分钟/i, '分钟'], [/^hours?|hrs?|小时/i, '小时'],
  [/^days?|天/i, '天'], [/^weeks?|wks?|周/i, '周'], [/^months?|月/i, '月'], [/^years?|yrs?|年/i, '年'],
];
const parse = (s) => {
  const t = String(s ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fa5]+)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  for (const [re, zh] of UNIT_WORDS) if (re.test(m[2])) return { n, unit: zh };
  return null;
};

const cases = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of gold.articles ?? []) {
    for (const c of a.comparisons ?? []) {
      for (const t of TRIPLETS) {
        const d = raw(c[t.desc]); const v = raw(c[t.value]); const u = code(c[t.unit]);
        if (!d || !v || !u) continue;
        const p = parse(d);
        if (!p) continue;
        cases.push({ zh: t.zh, desc: d, n: p.n, unit: p.unit, value: Number(v), unitCode: u, legend: LEGEND[t.unit]?.[u] ?? '?' });
      }
    }
  }
}

console.log(`\n══ 金标准的换算约定（可解析的三列对照 ${cases.length} 条）══\n`);
const byConv = new Map();
for (const c of cases) {
  if (c.unit === c.legend) continue;                       // 没换算，跳过
  const key = `${c.unit}→${c.legend}`;
  const arr = byConv.get(key) ?? [];
  arr.push(c);
  byConv.set(key, arr);
}
for (const [conv, arr] of [...byConv].sort((a, b) => b[1].length - a[1].length)) {
  const factors = arr.map((c) => c.value / c.n).filter((x) => Number.isFinite(x) && x > 0);
  const uniq = [...new Set(factors.map((x) => x.toFixed(4)))].sort();
  console.log(`■ ${conv}　${arr.length} 条｜换算系数（value/原数）取值：${uniq.slice(0, 8).join(', ')}`);
  for (const c of arr.slice(0, 5)) console.log(`    desc=${JSON.stringify(c.desc.slice(0, 22))} → value=${c.value} unit=${c.legend}（系数 ${(c.value / c.n).toFixed(3)}）`);
}

/* 专看 月→周 */
const m2w = cases.filter((c) => c.unit === '月' && c.legend === '周');
console.log(`\n★ 月 → 周 的样本 ${m2w.length} 条：`);
for (const c of m2w.slice(0, 14)) console.log(`   ${JSON.stringify(c.desc.slice(0, 24))} → ${c.value} 周（${c.n} 月 → 系数 ${(c.value / c.n).toFixed(2)}）`);

/* 专看 小时→分钟（留针时间规范单位是分钟） */
const h2m = cases.filter((c) => c.unit === '小时' && c.legend === '分钟');
console.log(`\n★ 小时 → 分钟 的样本 ${h2m.length} 条：`);
for (const c of h2m.slice(0, 10)) console.log(`   ${JSON.stringify(c.desc.slice(0, 24))} → ${c.value} 分钟（系数 ${(c.value / c.n).toFixed(2)}）`);

/* 未换算的比例 */
const same = cases.filter((c) => c.unit === c.legend).length;
console.log(`\n  未换算（desc 单位 == unit 编码单位）：${same} / ${cases.length}（${((same / cases.length) * 100).toFixed(0)}%）`);
