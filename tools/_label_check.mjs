/**
 * 检查 `field_labels.mjs` 修好后的列字母是否正确（对照 legend 真实列）。
 * 用法：node tools/_label_check.mjs
 */
import { createFieldLabels } from './lib/field_labels.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB = createFieldLabels(ROOT);
const KEYS = [
  'article.trial_center_count', 'article.author_contact', 'article.journal_class', 'article.impact_factor_2019',
  'comparison.intervention', 'comparison.total_sessions', 'comparison.total_sessions_class_a', 'comparison.total_sessions_class_b',
  'comparison.frequency_desc', 'comparison.frequency_value', 'comparison.frequency_unit',
  'comparison.course_desc', 'comparison.course_value', 'comparison.course_unit',
  'comparison.needle_retention_desc', 'comparison.needle_retention_value', 'comparison.needle_retention_unit', 'comparison.needle_retention_class',
  'comparison.max_followup_desc', 'comparison.max_followup_value', 'comparison.max_followup_unit',
  'comparison.analyzed_n_experimental', 'comparison.analyzed_n_control', 'comparison.dropout_total',
  'outcome.construct_code', 'outcome.subconstruct_code', 'outcome.p_value_range', 'outcome.p_value',
  'outcome.name', 'outcome.instrument', 'outcome.measurement_range', 'outcome.measurement_type',
  'follow_up.description', 'follow_up.value', 'follow_up.unit',
  'end_of_treatment.continuous.n', 'end_of_treatment.continuous.estimate', 'end_of_treatment.binary.difference_estimate',
  'baseline.continuous.estimate_type', 'follow_up_end.binary.rr',
  'study.primary_outcome', 'study.remarks',
];
for (const k of KEYS) {
  const d = LAB.describe(k);
  console.log(`${k.padEnd(46)} ${d.where.padEnd(18)} ${d.names.join(' / ')}`);
}
