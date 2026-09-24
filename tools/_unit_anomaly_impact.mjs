/**
 * 这 56 条"单位编码与原文不符"的记录，**对当前评分影响多大**？
 *
 * 做法：把异常记录（年+文章+比较组）与评测报告里 `comparison.max_followup_unit` 的判定对齐，
 * 看我们答了什么、被判成什么。若模型答的是"按表头图例的正确值"却被判错，
 * 那这部分失分是**金标准问题**，不是抽取问题——按项目口径应当记录、不计分。
 *
 * 用法：node tools/_unit_anomaly_impact.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const anomaly = JSON.parse(readFileSync(join(ROOT, 'build', 'unit_legend_anomaly.json'), 'utf8'));
const bad = new Set(anomaly.rows.map((r) => `${r.year}|${r.articleId}|${r.cmp}`));

/** 收集评测报告里该字段的全部条目（严格 + 语义） */
const entries = [];
for (const y of ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025']) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  const bf = rep.byField?.['comparison.max_followup_unit'];
  if (bf) entries.push({ year: y, id: '(byField 汇总)', verdict: null, agg: bf });
  for (const sheet of Object.values(rep.sheets ?? {})) {
    for (const j of sheet.judged ?? []) {
      if (String(j.field) !== 'comparison.max_followup_unit') continue;
      entries.push({ year: y, id: String(j.key).split('/')[0], verdict: j.verdict, gold: j.gold, pred: j.pred });
    }
  }
}

const judged = entries.filter((e) => e.verdict);
const w = judged.reduce((a, e) => a + (VERDICT_WEIGHT[e.verdict] ?? 0), 0);
console.log(`\n══ 最长随访时间单位：异常记录对评分的影响 ══\n`);
console.log(`  金标准异常记录：${anomaly.mismatched} / ${anomaly.total}（${((anomaly.mismatched / anomaly.total) * 100).toFixed(0)}%）`);
console.log(`  评测报告里的判定条目：${judged.length}，加权 ${((w / judged.length) * 100).toFixed(1)}%`);

/* 语义判定条目里，文章落在异常清单上的 */
const hit = judged.filter((e) => [...bad].some((k) => k.startsWith(`${e.year}|${e.id}|`)));
console.log(`\n  能对上异常清单的语义判定条目：${hit.length}`);
const hw = hit.reduce((a, e) => a + (VERDICT_WEIGHT[e.verdict] ?? 0), 0);
console.log(`  这些条目加权：${((hw / hit.length) * 100).toFixed(1)}%`);
const rest = judged.filter((e) => !hit.includes(e));
const rw = rest.reduce((a, e) => a + (VERDICT_WEIGHT[e.verdict] ?? 0), 0);
console.log(`  其余条目加权：${((rw / rest.length) * 100).toFixed(1)}%（${rest.length} 条）`);

console.log('\n  ── 对得上的条目明细（前 20）──');
for (const e of hit.slice(0, 20)) {
  const key = [...bad].find((k) => k.startsWith(`${e.year}|${e.id}|`));
  const a = anomaly.rows.find((r) => `${r.year}|${r.articleId}|${r.cmp}` === key);
  console.log(`   ${e.year} ${e.id} [${e.verdict}]`);
  console.log(`     金标准 unit=${JSON.stringify(e.gold)}（原文 ${JSON.stringify(String(a?.desc ?? '').slice(0, 24))} → 图例应为 ${a?.descUnit}）`);
  console.log(`     机器   unit=${JSON.stringify(e.pred)}`);
}

/* 若把这些条目剔除，该字段的加权正确率会变成多少？ */
const keep = rest;
console.log(`\n  ★ 若把能对上的 ${hit.length} 条按"疑似金标准问题"剔除：该字段加权 `
  + `${((rw / keep.length) * 100).toFixed(1)}%（原 ${((w / judged.length) * 100).toFixed(1)}%）`);
