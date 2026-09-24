/**
 * 金标准异常定量：`最长随访时间单位` 列，**原文写"周"却编码成 2（月）**的有多少条？是否按年份成片出现？
 *
 * 背景：权威图例（原始 Excel 表头）是 `1=天 2=月 3=年 4=周 5=小时`，
 * 但数据自证显示"周"同时落在 code 2（44 条）与 code 4（40 条）上——两者必有一半是错的。
 * 若按年份成片，说明是**某个时期的编码习惯不同**（可向医生确认）；
 * 若零散分布，则是个别录入错误。
 *
 * 用法：node tools/_unit_legend_anomaly.mjs
 * 输出：build/unit_legend_anomaly.json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const code = (o) => (o && typeof o === 'object' && 'code' in o ? String(o.code ?? '') : '');

/** 权威图例（与 build/legend/<year>.json 的 Sheet1 表头一致） */
const LEGEND_MAXFOLLOW = { 1: '天', 2: '月', 3: '年', 4: '周', 5: '小时' };

const UNIT_WORDS = [
  [/^(seconds?|secs?|秒)/i, '秒'], [/^(minutes?|mins?|分钟)/i, '分钟'], [/^(hours?|hrs?|小时)/i, '小时'],
  [/^(days?|天)/i, '天'], [/^(weeks?|wks?|周)/i, '周'], [/^(months?|月)/i, '月'], [/^(years?|yrs?|年)/i, '年'],
];
/** 取原文里的单位词（跳过开头的数字/范围）。 */
const wordOf = (s) => {
  const t = String(s ?? '').trim().replace(/^\d+(?:\.\d+)?(?:\s*[-–~]\s*\d+(?:\.\d+)?)?\s*/, '');
  for (const [re, zh] of UNIT_WORDS) if (re.test(t)) return zh;
  return null;
};
const numOf = (s) => Number(/^(\d+(?:\.\d+)?)/.exec(String(s ?? '').trim())?.[1] ?? NaN);

const rows = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of gold.articles ?? []) {
    for (const [i, c] of (a.comparisons ?? []).entries()) {
      const desc = raw(c.max_followup_desc);
      const u = code(c.max_followup_unit);
      const v = raw(c.max_followup_value);
      if (!desc || !u || !LEGEND_MAXFOLLOW[u]) continue;
      const w = wordOf(desc);
      if (!w) continue;
      const expect = LEGEND_MAXFOLLOW[u];
      /*
       * "一致"包含**换算后等值**：`30 minutes` 编成 `5`（小时）虽然单位词不同，
       * 但 0.5 小时 = 30 分钟，三列是自洽的——那是修正时做的换算，不是错误。
       * 只有"原文单位与编码含义互不相等"才算不符。
       */
      const EQUIV = { 分钟: { 小时: 1 / 60, 天: 1 / 1440 }, 小时: { 天: 1 / 24, 分钟: 60 }, 天: { 周: 7, 月: 28, 年: 336 }, 周: { 月: 4, 年: 48, 天: 1 / 7 }, 月: { 年: 12, 周: 1 / 4 }, 年: { 月: 1 / 12 } };
      const ok = w === expect;
      rows.push({ year: y, articleId: a.article_id, cmp: i + 1, desc, value: v, unitCode: u, legendUnit: expect, descUnit: w, ok, num: numOf(desc), val: numOf(v), convertible: !ok && EQUIV[w]?.[expect] !== undefined });
    }
  }
}

const bad = rows.filter((r) => !r.ok && !r.convertible);
const conv = rows.filter((r) => r.convertible);
console.log(`\n══ 最长随访时间单位：原文单位 vs 编码含义 ══\n`);
console.log(`  可解析的条目：${rows.length}｜**不一致的：${bad.length}（${((bad.length / rows.length) * 100).toFixed(0)}%）**`
  + `｜其中"换算后等值"（正常）：${conv.length}`);

console.log('\n  按年份：');
console.log('   年份   条数   不一致   占比     主要错法');
for (const y of YEARS) {
  const rs = rows.filter((r) => r.year === y);
  if (!rs.length) continue;
  const b = rs.filter((r) => !r.ok);
  const kinds = new Map();
  for (const r of b) kinds.set(`${r.descUnit}→code${r.unitCode}(${r.legendUnit})`, (kinds.get(`${r.descUnit}→code${r.unitCode}(${r.legendUnit})`) ?? 0) + 1);
  const top = [...kinds].sort((a, c) => c[1] - a[1]).slice(0, 2).map(([k, n]) => `${k}×${n}`).join('；');
  console.log(`   ${y}   ${String(rs.length).padStart(4)}   ${String(b.length).padStart(5)}   ${((b.length / rs.length) * 100).toFixed(0).padStart(4)}%   ${top}`);
}

console.log('\n  不一致的取值分布（原文单位 → 编码含义）：');
const kinds = new Map();
for (const r of bad) kinds.set(`${r.descUnit} → code ${r.unitCode}（图例= ${r.legendUnit}）`, (kinds.get(`${r.descUnit} → code ${r.unitCode}（图例= ${r.legendUnit}）`) ?? 0) + 1);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${k}`);

console.log('\n  ── "周 → code 2(月)" 的样例（这批最可疑）──');
for (const r of bad.filter((x) => x.descUnit === '周' && x.unitCode === '2').slice(0, 12)) {
  console.log(`   ${r.year} ${r.articleId} 比较组${r.cmp}  desc=${JSON.stringify(r.desc.slice(0, 30))} → value=${JSON.stringify(r.value)} unit=2(月)`);
}

writeFileSync(join(ROOT, 'build', 'unit_legend_anomaly.json'), JSON.stringify({
  at: new Date().toISOString(),
  legend: LEGEND_MAXFOLLOW,
  total: rows.length, mismatched: bad.length,
  rows: bad,
}, null, 1), 'utf8');
console.log('\n明细 build/unit_legend_anomaly.json\n');
