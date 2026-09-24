/**
 * 定标：comparison 里那批"表头写了单位"的字段，**金标准到底存什么**？
 *
 * 关键分歧：
 *   · 若金标准存的是**换算后的规范单位**（如 `留针 0.5 h` → `30`）→ "照抄原文"就是错的，
 *     必须按表头指定的单位归一化；
 *   · 若金标准存的是**原文片段**（`30 min`、`once a week`）→ 照抄是对的，问题在别处。
 *
 * 同时把"同一篇里 _desc / _value / _unit 三列"放在一起看，判断它们的分工。
 *
 * 用法：node tools/_desc_unit_scale.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

/** 这批字段的共同点：表头显式指定了单位（见 docs/15 的原始列名）。 */
const GROUPS = [
  { name: '留针时间', descKey: 'needle_retention_desc', valueKey: 'needle_retention_value', unitKey: 'needle_retention_unit', header: '留针时间 (单位：分钟, min)' },
  { name: '疗程', descKey: 'course_desc', valueKey: 'course_value', unitKey: 'course_unit', header: '疗程（单位：天）' },
  { name: '治疗频次', descKey: 'frequency_desc', valueKey: 'frequency_value', unitKey: 'frequency_unit', header: '治疗频次描述（标明单位）' },
  { name: '最长随访', descKey: 'max_followup_desc', valueKey: 'max_followup_value', unitKey: 'max_followup_unit', header: '最长随访时间' },
  { name: '进针深度', descKey: 'insertion_depth_text', valueKey: null, unitKey: null, header: '进针深度 （单位：毫米, mm）' },
];

const raw = (leaf) => (leaf && typeof leaf === 'object' && 'raw' in leaf ? String(leaf.raw ?? '') : '');
const code = (leaf) => (leaf && typeof leaf === 'object' && 'code' in leaf ? String(leaf.code ?? '') : '');

for (const g of GROUPS) {
  const descs = []; const pairs = []; const units = new Map();
  for (const y of YEARS) {
    const f = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(f)) continue;
    const gold = JSON.parse(readFileSync(f, 'utf8'));
    for (const a of gold.articles ?? []) {
      for (const c of a.comparisons ?? []) {
        const d = raw(c[g.descKey]);
        if (d) descs.push(d);
        if (g.valueKey) {
          const v = raw(c[g.valueKey]);
          if (v || d) pairs.push({ d, v, u: code(c[g.unitKey]), ur: raw(c[g.unitKey]) });
        }
        const u = raw(c[g.unitKey]);
        if (u) units.set(u, (units.get(u) ?? 0) + 1);
      }
    }
  }
  console.log(`\n══ ${g.name} ══  原始表头：${g.header}`);
  console.log(`  ${g.descKey} 非空 ${descs.length} 条，去重 ${new Set(descs).size} 条`);
  const uniq = [...new Set(descs)];
  console.log('  取值样例（前 18）：');
  for (const d of uniq.slice(0, 18)) console.log(`    ${JSON.stringify(d.slice(0, 60))}`);

  /* 关键判据：desc 里是否出现"非表头单位"的写法 */
  if (g.valueKey) {
    console.log(`  ── _desc / _value / _unit 三列并排（前 14）──`);
    for (const p of pairs.filter((x) => x.d || x.v).slice(0, 14)) {
      console.log(`    desc=${JSON.stringify(p.d.slice(0, 30))}  value=${JSON.stringify(p.v)}  unit(code)=${JSON.stringify(p.u)} unit(raw)=${JSON.stringify(p.ur.slice(0, 14))}`);
    }
    console.log(`  unit 原始取值的分布：${JSON.stringify([...units].slice(0, 12))}`);
  }
}
