/**
 * 金标准修正后的**结构完整性校验**：确认只动了该动的值，没有丢字段/改结构。
 *
 * 比对 `build/_backup_gold_pre_units/`（修正前）与 `build/gold/`（修正后）：
 *   · 文章数、比较组数、每篇的键集合必须完全一致；
 *   · 只允许这三组的 desc/value/unit 的 `raw`/`code` 发生变化；
 *   · 列出所有"非预期变更"（任何其他字段被改动都会被抓出来）。
 *
 * 用法：node tools/gold_fix_units_verify.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = join(ROOT, 'build', '_backup_gold_pre_units');
const NEW = join(ROOT, 'build', 'gold');
const ALLOWED = new Set([
  'max_followup_desc', 'max_followup_value', 'max_followup_unit',
  'frequency_desc', 'frequency_value', 'frequency_unit',
  'needle_retention_desc', 'needle_retention_value', 'needle_retention_unit',
]);

const problems = [];
let files = 0; let articles = 0; let comps = 0; let leafChanges = 0;

for (const f of readdirSync(OLD)) {
  if (!f.endsWith('.json')) continue;
  if (!existsSync(join(NEW, f))) { problems.push(`${f}: 新目录缺失`); continue; }
  files++;
  const a = JSON.parse(readFileSync(join(OLD, f), 'utf8'));
  const b = JSON.parse(readFileSync(join(NEW, f), 'utf8'));

  /* 顶层键必须一致 */
  const ka = Object.keys(a).sort().join(',');
  const kb = Object.keys(b).sort().join(',');
  if (ka !== kb) problems.push(`${f}: 顶层键变化\n   旧 ${ka}\n   新 ${kb}`);

  const byId = new Map((b.articles ?? []).map((x) => [x.article_id, x]));
  if ((a.articles ?? []).length !== (b.articles ?? []).length) problems.push(`${f}: 文章数变化 ${(a.articles ?? []).length} → ${(b.articles ?? []).length}`);

  for (const ga of a.articles ?? []) {
    articles++;
    const gb = byId.get(ga.article_id);
    if (!gb) { problems.push(`${f}: 文章 ${ga.article_id} 丢失`); continue; }
    /* 文章级字段：不应有任何变化 */
    for (const k of new Set([...Object.keys(ga), ...Object.keys(gb)])) {
      if (k === 'comparisons') continue;
      if (JSON.stringify(ga[k]) !== JSON.stringify(gb[k])) problems.push(`${f} ${ga.article_id}: 文章级字段 ${k} 被改动`);
    }
    const ca = ga.comparisons ?? []; const cb = gb.comparisons ?? [];
    if (ca.length !== cb.length) problems.push(`${f} ${ga.article_id}: 比较组数变化 ${ca.length} → ${cb.length}`);
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      comps++;
      const keys = new Set([...Object.keys(ca[i]), ...Object.keys(cb[i])]);
      if ([...keys].some((k) => !(k in ca[i]) || !(k in cb[i]))) problems.push(`${f} ${ga.article_id} 比较组${i + 1}: 键集合变化`);
      for (const k of keys) {
        if (JSON.stringify(ca[i][k]) === JSON.stringify(cb[i][k])) continue;
        if (!ALLOWED.has(k)) { problems.push(`${f} ${ga.article_id} 比较组${i + 1}: **非预期改动** ${k}`); continue; }
        leafChanges++;
      }
    }
  }
}

console.log('\n══ 金标准修正：结构完整性校验 ══\n');
console.log(`  比对文件：${files}　文章：${articles}　比较组：${comps}`);
console.log(`  三组字段的叶子改动：${leafChanges}`);
console.log(problems.length ? `\n  ⚠ 发现 ${problems.length} 个问题：` : '\n  ✅ 无结构问题：文章数/比较组数/键集合完全一致，且**只有**这三组的叶子被改动');
for (const p of problems.slice(0, 30)) console.log(`   · ${p}`);

/* 打印剩余未修正的图例异常（供人工） */
const anom = join(ROOT, 'build', 'unit_legend_anomaly.json');
if (existsSync(anom)) {
  const j = JSON.parse(readFileSync(anom, 'utf8'));
  console.log(`\n  ── 仍有 ${j.mismatched} 条与表头图例不符（保留待人工）──`);
  for (const r of j.rows.slice(0, 12)) console.log(`   ${r.year} ${r.articleId} 比较组${r.cmp}  desc=${JSON.stringify(String(r.desc).slice(0, 40))}  unit=${r.unitCode}(${r.legendUnit})`);
}
