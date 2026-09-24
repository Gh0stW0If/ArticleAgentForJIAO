/**
 * 金标准错位检测：把**疑似错位的单元格**挑出来，供评分时排除并单独记录。
 *
 * 依据（都是实测看到的真实形态，不是猜测）：
 *
 *  1. **编码列里出现自由文本**：如 `deqi` = "23 mm (real), <10 mm (sham)"（这是进针深度的值）、
 *     `stimulation_intensity` = "20min"/"30 minutes"（这是留针时间的值）——
 *     列里的值显然属于别的列。
 *  2. **编码列的取值超出该列批注给出的取值表**：如 `funding_1`（批注只有 1=有 / 2=未报告）
 *     出现 7(×38)，而 7 是 funding_2 的"未报告"码。
 *  3. **数值列里出现散文**：如 `*_value`、`*_min`、`randomized_n*` 里出现整句。
 *  4. **年份列不是 4 位数字**。
 *
 * 用法：
 *   node tools/gold_anomalies.mjs            # 全部年份
 *   node tools/gold_anomalies.mjs --year 2015
 *
 * 输出：build/gold_anomalies.json（评分时按 (year, articleId, scope, field) 排除）
 */

/* ⚠️ `existsSync` 必须导入：第 148 行的"读旧 + 合并"逻辑要用它，
   漏了会在**运行到最后一步**才抛 ReferenceError（前面的检测白跑）。 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_OUTCOME_FIELDS,
  OUTCOME_TOP_FIELDS, TIMEPOINT_FIELDS,
} from './canonical-field-map.mjs';
import { camelToSnake } from './lib/keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const onlyYear = argv.includes('--year') ? argv[argv.indexOf('--year') + 1] : null;

/** 由数据集/流程填写、或本就是自由文本的列，不参与"编码/数值"形态判断。 */
const FREE_TEXT_KEYS = new Set([
  'title', 'journal', 'first_author', 'author_contact', 'condition', 'country',
  'registration_ids', 'doi', 'intervention', 'control', 'randomization_method',
  'allocation_concealment', 'patient_expectation', 'frequency_desc', 'course_desc',
  'insertion_depth_text', 'needle_retention_desc', 'needle_count_text', 'max_followup_desc',
  'outcome_name', 'instrument', 'measurement_range', 'measurement_unit', 'classification_method',
  'follow_up_description', 'name', 'primary_outcome', 'outcome_pain', 'outcome_nonpain',
  'outcome_function', 'outcome_qol', 'outcome_events', 'outcome_mortality', 'remarks',
  'title_sheet2', 'literature_no', 'extractor', 'eligibility_check', 'study_id', 'article_id',
  'row_id', 'literature_code',
]);

/** 数值列（出现散文即视为错位）。 */
const NUMERIC_RE = /(_value|_min|_n$|^randomized_n|^analyzed_n|^dropout_total|^trial_center_count|^impact_factor|_count)/;

/** 编码表：snake 键 → 允许的编码集。 */
const codeSets = new Map();
for (const f of [...ARTICLE_FIELDS, ...STUDY_OUTCOME_FIELDS, ...COMPARISON_FIELDS, ...OUTCOME_TOP_FIELDS, ...TIMEPOINT_FIELDS]) {
  if (f.codes) codeSets.set(camelToSnake(f.key), new Set(Object.keys(f.codes)));
}

const isSentinel = (v) => /^(NR|NA|NE|nr|na|ne)$/.test(String(v).trim());
const looksProse = (v) => {
  const s = String(v);
  return s.length > 12 && /\s/.test(s) && /[a-zA-Z\u4e00-\u9fa5]{3,}/.test(s);
};

const anomalies = [];
const add = (year, articleId, scope, field, value, reason) =>
  anomalies.push({ year, articleId, scope, field, value: String(value).slice(0, 120), reason });

/** 单个字段值的判定。 */
function checkValue(year, articleId, scope, snakeKey, raw) {
  if (raw === undefined || raw === null || raw === '') return;
  const v = String(raw).trim();
  if (isSentinel(v)) return;

  const codes = codeSets.get(snakeKey);
  if (codes && !FREE_TEXT_KEYS.has(snakeKey)) {
    if (codes.has(v)) return;
    // 多选 a/b：每个分量都合法则通过
    const parts = v.split(/\s*[/、,]\s*/).filter(Boolean);
    if (parts.length > 1 && parts.every((x) => codes.has(x))) return;
    if (looksProse(v)) add(year, articleId, scope, snakeKey, v, 'code列写成了自由文本（疑似列错位）');
    else add(year, articleId, scope, snakeKey, v, `编码超出该列取值表（允许 ${[...codes].join(',')}）`);
    return;
  }

  if (NUMERIC_RE.test(snakeKey) && !FREE_TEXT_KEYS.has(snakeKey) && looksProse(v)) {
    add(year, articleId, scope, snakeKey, v, '数值列写成了自由文本（疑似列错位）');
    return;
  }

  if ((snakeKey === 'publication_year' || snakeKey === 'crossref_year' || snakeKey.endsWith('_year')) && !/^\d{4}$/.test(v)) {
    add(year, articleId, scope, snakeKey, v, '年份不是 4 位数字');
  }
}

const goldDir = join(ROOT, 'build', 'gold');
const files = readdirSync(goldDir)
  .filter((f) => /^\d{4}\.json$/.test(f))
  .filter((f) => !onlyYear || f === `${onlyYear}.json`)
  .sort();

for (const f of files) {
  const year = f.replace('.json', '');
  const doc = JSON.parse(readFileSync(join(goldDir, f), 'utf8'));

  // 与评分一致：Sheet3 的结局行跨比较组重复，这里按 (article, 行内字段) 记录即可
  for (const a of doc.articles ?? []) {
    for (const [k, gv] of Object.entries(a.article ?? {})) {
      if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'article', k, gv.raw);
    }
    for (const [k, gv] of Object.entries(a.study ?? {})) {
      if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'study', k, gv.raw);
    }
    for (const c of a.comparisons ?? []) {
      for (const [k, gv] of Object.entries(c)) {
        if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'comparison', k, gv.raw);
      }
    }
    for (const o of a.outcomes ?? []) {
      for (const [k, gv] of Object.entries(o)) {
        if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'outcome', k, gv.raw);
      }
      for (const [k, gv] of Object.entries(o.outcome ?? {})) {
        if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'outcome', k, gv.raw);
      }
      for (const block of Object.values(o.timepoints ?? {})) {
        for (const fields of Object.values(block ?? {})) {
          for (const [k, gv] of Object.entries(fields ?? {})) {
            if (gv && typeof gv === 'object' && 'raw' in gv) checkValue(year, a.article_id, 'outcome', k, gv.raw);
          }
        }
      }
    }
  }
}

mkdirSync(join(ROOT, 'build'), { recursive: true });

/*
 * ⚠️ **合并**写入，不要覆盖。
 *
 * `tools/gold_vs_paper.mjs`（取证式审计：金标准的值在原文里找不到）写的是同一个文件，
 * 且是"读旧 + 合并"。本工具若直接覆盖，会把它的发现**静默冲掉**——实测踩到：
 * 重跑本工具后 2015 年那批取证发现消失，2015 的评测准确率从 73.4% 掉到 70.9%
 * （排除项没了，本该剔除的错位值又回到分母里）。
 *
 * 去重键含 reason：同一处可能被两个工具从不同角度命中，两条都要留。
 */
const outFile = join(ROOT, 'build', 'gold_anomalies.json');
let prevOut = { anomalies: [] };
if (existsSync(outFile)) {
  try { prevOut = JSON.parse(readFileSync(outFile, 'utf8')); } catch { /* 文件损坏则重建 */ }
}
const keyOf = (a) => `${a.year}|${a.articleId}|${a.scope ?? ''}|${a.field ?? ''}|${String(a.value ?? '')}|${a.reason ?? ''}`;
const mergedMap = new Map();
for (const a of prevOut.anomalies ?? []) mergedMap.set(keyOf(a), a);
for (const a of anomalies) mergedMap.set(keyOf(a), a);   // 本次结果覆盖同键旧记录
const mergedList = [...mergedMap.values()];

const out = {
  at: new Date().toISOString(),
  years: [...new Set([...(prevOut.years ?? []), ...files.map((f) => f.replace('.json', ''))])].sort(),
  total: mergedList.length,
  byReason: Object.fromEntries(
    [...new Set(mergedList.map((a) => a.reason))].map((r) => [r, mergedList.filter((a) => a.reason === r).length]),
  ),
  anomalies: mergedList,
};
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

console.log(`\n金标准错位检测：${files.join(', ')}`);
console.log(`  本次新增/更新 ${anomalies.length} 个；文件内累计 ${mergedList.length} 个（含 gold:vs-paper 的取证发现）`);
for (const [r, n] of Object.entries(out.byReason)) console.log(`    ${String(n).padStart(4)}  ${r}`);

const byField = new Map();
for (const a of anomalies) byField.set(`${a.scope}.${a.field}`, (byField.get(`${a.scope}.${a.field}`) ?? 0) + 1);
console.log(`\n  按字段（前 15）：`);
for (const [k, n] of [...byField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(n).padStart(4)}  ${k}`);

const sample = anomalies.slice(0, 6);
if (sample.length) {
  console.log(`\n  样例：`);
  for (const a of sample) console.log(`    ${a.year}/${a.articleId} ${a.scope}.${a.field} = ${JSON.stringify(a.value.slice(0, 60))} — ${a.reason}`);
}
console.log(`\n  → build/gold_anomalies.json\n`);
