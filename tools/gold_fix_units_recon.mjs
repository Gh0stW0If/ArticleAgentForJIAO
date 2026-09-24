/**
 * 金标准修正（一）：**侦察**——三组字段的 desc 到底有哪些形态、哪些能确定性解析？
 *
 * 三组（用户指定）：
 *   · 最长随访时间：max_followup_desc / _value / _unit
 *   · 治疗频次　　：frequency_desc / _value / _unit
 *   · 留针时间　　：needle_retention_desc / _value / _unit
 *
 * 目标形态（用户口径）：
 *   desc  = **原文，但格式归一化**——`30 min`/`30 minutes` 统一成"数字 + 单位全拼"（`30 minutes`）；
 *           无法用数值表示的（`post-gastroscopy`、`until delivery`）保持原样。
 *   value = 由 desc 确定性提取的数（**代码约束，不交给 LLM**）
 *   unit  = 由 desc 确定性提取的单位编码（以表头图例为准）
 *
 * 本脚本只**统计与分类**，不写任何文件。
 *
 * 用法：node tools/gold_fix_units_recon.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const code = (o) => (o && typeof o === 'object' && 'code' in o ? String(o.code ?? '') : '');
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;

/** 表头图例（权威，来自 build/legend/<year>.json 的 headerLabels） */
const CODES = {
  max_followup_unit: { 1: '天', 2: '月', 3: '年', 4: '周', 5: '小时' },
  frequency_unit: { 1: '天', 2: '周', 3: '1小时' },
  needle_retention_unit: { 1: '分钟', 2: '小时' },
};
const GROUPS = [
  { zh: '最长随访时间', desc: 'max_followup_desc', value: 'max_followup_value', unit: 'max_followup_unit' },
  { zh: '治疗频次', desc: 'frequency_desc', value: 'frequency_value', unit: 'frequency_unit' },
  { zh: '留针时间', desc: 'needle_retention_desc', value: 'needle_retention_value', unit: 'needle_retention_unit' },
];

/** 把 desc 分类：能解析成"数+时间单位"的 / 带时间的文字 / 纯文字 / 哨兵 / 空 */
const UNIT_WORDS = [
  [/^(seconds?|secs?|sec|s)\b/i, '秒'], [/^(minutes?|mins?|min|m)\b/i, '分钟'],
  [/^(hours?|hrs?|hr|h)\b/i, '小时'], [/^(days?|d)\b/i, '天'],
  [/^(weeks?|wks?|wk|w)\b/i, '周'], [/^(months?|mos?|mo)\b/i, '月'], [/^(years?|yrs?|yr|y)\b/i, '年'],
  [/^(秒)/, '秒'], [/^(分钟|分)/, '分钟'], [/^(小时|時|时)/, '小时'],
  [/^(天|日)/, '天'], [/^(周|星期)/, '周'], [/^(月)/, '月'], [/^(年)/, '年'],
];
/** 解析开头的"数 + 单位"。返回 { numText, unit, rest } 或 null。 */
function parseLeading(s) {
  const t = String(s ?? '').trim();
  const m = /^(\d+(?:\.\d+)?(?:\s*[-–~]\s*\d+(?:\.\d+)?)?)\s*([A-Za-z\u4e00-\u9fa5]+)?/.exec(t);
  if (!m || !m[1]) return null;
  const rest = t.slice(m[0].length);
  if (!m[2]) return null;                       // 只有数字、没有单位 → 不可解析
  for (const [re, u] of UNIT_WORDS) if (re.test(m[2])) return { numText: m[1], unit: u, unitText: m[2], rest };
  return null;
}

const recon = new Map();
for (const g of GROUPS) recon.set(g.zh, { total: 0, parseable: 0, textWithTime: 0, plainText: 0, sentinel: 0, empty: 0, samples: { parseable: [], textWithTime: [], plainText: [] } });

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of gold.articles ?? []) {
    for (const c of a.comparisons ?? []) {
      for (const g of GROUPS) {
        const d = raw(c[g.desc]);
        const s = recon.get(g.zh);
        s.total++;
        if (!d.trim()) { s.empty++; continue; }
        if (SENT.test(d)) { s.sentinel++; continue; }
        const p = parseLeading(d);
        if (p) {
          s.parseable++;
          if (s.samples.parseable.length < 8) s.samples.parseable.push({ y, id: a.article_id, d, p: `${p.numText} ${p.unit}`, rest: p.rest.slice(0, 20), unitCode: code(c[g.unit]) });
        } else if (/\d/.test(d)) { s.textWithTime++; if (s.samples.textWithTime.length < 8) s.samples.textWithTime.push({ y, id: a.article_id, d: d.slice(0, 60) }); }
        else { s.plainText++; if (s.samples.plainText.length < 6) s.samples.plainText.push({ y, id: a.article_id, d: d.slice(0, 60) }); }
      }
    }
  }
}

console.log('\n══ 三组字段的 desc 形态侦察 ══\n');
for (const g of GROUPS) {
  const s = recon.get(g.zh);
  const pc = (n) => `${((n / s.total) * 100).toFixed(0)}%`;
  console.log(`■ ${g.zh}（${s.total} 个比较组）`);
  console.log(`   可确定性解析（数+时间单位）：**${s.parseable}（${pc(s.parseable)}）**`);
  console.log(`   含数字但解析不出单位　　：${s.textWithTime}（${pc(s.textWithTime)}）`);
  console.log(`   纯文字（无法数值化）　　：${s.plainText}（${pc(s.plainText)}）`);
  console.log(`   哨兵值 NR/NA/NE　　　　：${s.sentinel}（${pc(s.sentinel)}）`);
  console.log(`   空　　　　　　　　　　：${s.empty}`);
  console.log('   ── 可解析样例 ──');
  for (const x of s.samples.parseable) console.log(`     ${x.y} ${x.id}  desc=${JSON.stringify(x.d.slice(0, 28))} → ${JSON.stringify(x.p)}  尾部=${JSON.stringify(x.rest)}  现有 unit=${JSON.stringify(x.unitCode)}`);
  if (s.samples.textWithTime.length) {
    console.log('   ── 含数字但解析不出单位（需人工或放弃）──');
    for (const x of s.samples.textWithTime) console.log(`     ${x.y} ${x.id}  ${JSON.stringify(x.d)}`);
  }
  if (s.samples.plainText.length) {
    console.log('   ── 纯文字（保持原样）──');
    for (const x of s.samples.plainText) console.log(`     ${x.y} ${x.id}  ${JSON.stringify(x.d)}`);
  }
  console.log();
}
