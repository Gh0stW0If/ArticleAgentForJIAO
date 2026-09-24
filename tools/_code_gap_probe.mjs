/**
 * 诊断：把「金标准里那些不符合列取值表的填写」逐列列出来，并判断到底是
 * **金标准列错位**还是**我们的列映射错了**。
 *
 * 为什么必须搞清楚：这类问题在报告里占了一大类（上百条），
 * 如果把"我们自己的映射错误"写成"金标准有错"，会让医生白费工夫、也让报告失去可信度。
 *
 * 判据：拿该列的**表头与单元格批注**（来自 build/legend，直接从 xlsx 抽的）
 * 跟金标准实际填的内容比对——
 *   · 内容与批注描述的含义吻合、只是没填编码 → 金标准"填了文字"，属填写规范问题；
 *   · 内容明显是**另一列**的含义（如 deqi 列里写着进针深度） → 列错位；
 *   · 内容与表头完全无关 → 我们的映射可能错了。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLegend } from './sheet_layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold_anomalies.json'), 'utf8'));

/** 只保留"编码不在允许取值内"这一类。 */
const rows = (gold.anomalies ?? []).filter((a) => /编码超出该列取值表/.test(a.reason ?? ''));
console.log(`\n=== 「编码不在允许取值内」共 ${rows.length} 条，按 (字段, 值) 去重 ===\n`);

const byField = new Map();
for (const a of rows) {
  const key = `${a.field}`;
  if (!byField.has(key)) byField.set(key, new Map());
  const m = byField.get(key);
  const v = String(a.value ?? '').trim();
  if (!m.has(v)) m.set(v, { count: 0, samples: [] });
  const rec = m.get(v);
  rec.count++;
  if (rec.samples.length < 3) rec.samples.push(`${a.year}/${a.articleId}`);
}

/** 找回该字段在规范清单里的中文名与允许取值，便于判断"填的是不是别的东西"。 */
const canon = await import('./canonical-field-map.mjs');
const labelOf = new Map();
for (const list of [canon.ARTICLE_FIELDS, canon.COMPARISON_FIELDS, canon.STUDY_OUTCOME_FIELDS, canon.OUTCOME_TOP_FIELDS, canon.TIMEPOINT_FIELDS]) {
  for (const f of list) labelOf.set(f.key, f);
}
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

for (const [field, values] of [...byField.entries()].sort((a, b) => b[1].size - a[1].size)) {
  const snake = field.includes('_') ? field : camelToSnake(field);
  const f = labelOf.get(camel(snake)) ?? labelOf.get(snake);
  console.log(`■ ${field}${f ? `（${f.label ?? ''}）` : ''}`);
  if (f?.codes) console.log(`   该列允许：${Object.entries(f.codes).map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 150)}`);
  for (const [v, rec] of [...values.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`   · 填「${v.slice(0, 60)}」（${rec.count} 处，如 ${rec.samples.slice(0, 2).join('、')}）`);
  }
  console.log();
}
