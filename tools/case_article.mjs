/**
 * 逐个字段对照某篇：金标准 vs 机器（用于给医生的"典型文章"章节）。
 * 用法：node tools/case_article.mjs 2020-02
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = process.argv[2] ?? '2020-02';
const y = ID.split('-')[0];
const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
const art = (gold.articles ?? []).find((a) => a.article_id === ID);
const pred = JSON.parse(readFileSync(join(ROOT, 'build', 'extraction', y, `${ID}.json`), 'utf8'));
const v = (o) => (o && typeof o === 'object' ? (o.raw ?? '') : (o ?? ''));
const SENT = /^\s*(NR|NA|NE)?\s*$/i;

console.log(`──────────────── ${ID} ────────────────`);
console.log('题目：', v(art.article?.title));
console.log(`金标准：比较组 ${(art.comparisons ?? []).length} 个、结局行 ${(art.outcomes ?? []).length} 条`);
console.log(`机器　：比较组 ${(pred.comparisons ?? []).length} 个、结局行 ${(pred.outcomes ?? []).length} 条`);

const KEYS = [
  ['干预方法名称', 'intervention'], ['对照组名称', 'control'], ['对照组类型', 'control_type'],
  ['比较类型', 'comparison_type'], ['随机序列产生方法', 'randomization_method'], ['随机方法分类', 'randomization_class'],
  ['分配隐藏方法', 'allocation_concealment'], ['盲研究对象', 'blinding_participants'], ['盲结局评价者', 'blinding_outcome_assessor'],
  ['治疗频次描述', 'frequency_desc'], ['治疗频次数值', 'frequency_value'], ['治疗频次单位', 'frequency_unit'], ['治疗频次分类', 'frequency_class'],
  ['疗程', 'course_desc'], ['疗程数值', 'course_value'], ['疗程单位', 'course_unit'],
  ['治疗总次数', 'total_sessions'], ['治疗总次数治疗分类', 'total_sessions_class_a'], ['治疗总次数分类', 'total_sessions_class_b'],
  ['留针时间', 'needle_retention_desc'], ['留针时间数值', 'needle_retention_value'], ['留针时间单位', 'needle_retention_unit'], ['留针时间分类', 'needle_retention_class'],
  ['最长随访时间', 'max_followup_desc'], ['最长随访时间数值', 'max_followup_value'], ['最长随访时间单位', 'max_followup_unit'],
  ['随机样本量', 'randomized_n'], ['试验组', 'analyzed_n_experimental'], ['对照组', 'analyzed_n_control'], ['主要结局脱落总人数', 'dropout_total'],
];
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const n = Math.max((art.comparisons ?? []).length, (pred.comparisons ?? []).length);
for (let i = 0; i < n; i++) {
  const g = art.comparisons?.[i] ?? {}; const p = pred.comparisons?.[i] ?? {};
  console.log(`\n【比较组 ${i + 1}】`);
  console.log('  原始列名'.padEnd(30) + '金标准'.padEnd(34) + '机器');
  for (const [zh, k] of KEYS) {
    const gv = String(v(g[k])).trim();
    const pv = String(v(p[camel(k)])).trim();
    if (SENT.test(gv) && SENT.test(pv)) continue;
    const mark = gv === pv ? ' ' : '≠';
    console.log(`${mark} ${zh.padEnd(28)}${JSON.stringify(gv).slice(0, 32).padEnd(34)}${JSON.stringify(pv).slice(0, 36)}`);
  }
}

console.log('\n【结局行】');
const nm = (o) => `${v(o?.outcome?.name)}｜${v(o?.outcome?.instrument)}`;
console.log('  金标准：');
(art.outcomes ?? []).forEach((o, i) => console.log(`    g${i + 1}  code=${v(o.literature_code)}  ${nm(o)}   p=${v(o.outcome?.p_value)}  量程=${v(o.outcome?.measurement_range)}`));
console.log('  机器：');
(pred.outcomes ?? []).forEach((o, i) => console.log(`    p${i + 1}  ${nm(o)}   p=${v(o.outcome?.pValue)}  量程=${v(o.outcome?.measurementRange)}`));

/* 时点数值对比（第一条结局） */
const g0 = art.outcomes?.[0]; const p0 = pred.outcomes?.[0];
console.log('\n【结局 1 的时点数值】金标准 vs 机器');
const walk = (o, pre = '', out = []) => {
  if (!o || typeof o !== 'object') return out;
  if (typeof o.raw === 'string') { if (!SENT.test(o.raw)) out.push([pre, o.raw]); return out; }
  for (const [k, v2] of Object.entries(o)) if (!['evidence', 'confidence', 'provenance', 'legend', 'quote', 'missing'].includes(k)) walk(v2, pre ? `${pre}.${k}` : k, out);
  return out;
};
const gm = new Map(walk(g0?.timepoints ?? {}));
const pm = new Map(walk(p0?.timepoints ?? {}));
const keys = [...new Set([...gm.keys(), ...pm.keys()])].sort();
for (const k of keys) {
  const a = gm.get(k) ?? '—'; const b = pm.get(k) ?? '—';
  console.log(`   ${a === b ? ' ' : '≠'} ${k.padEnd(52)}${String(a).padEnd(14)}${b}`);
}
void existsSync;
