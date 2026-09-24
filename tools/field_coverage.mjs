/**
 * 字段覆盖审计：金标准列 × 规范字段清单
 *
 * 为什么需要它：SKILL 只能抽「提示词里要求过的字段」。
 * 凡是金标准里有、而 `tools/canonical-field-map.mjs` 里没有的列，
 * 流水线永远抽不出来 —— 表现为"该字段准确率恒为 0"，而且很难从评测表里看出原因
 * （实测 comparison 层就是这样丢了 sex_experimental / randomized_n_* / baseline_cat_* 等 9 个字段）。
 *
 * 用法：
 *   node tools/field_coverage.mjs                # 全部年份
 *   node tools/field_coverage.mjs --year 2015
 *
 * 输出：
 *   build/coverage.json  + 终端摘要
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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

/**
 * 金标准的嵌套容器键（不是字段，跳过）。
 * 时点块里的 experimental / control / difference_* 是"组"容器，其内部才是字段。
 */
const GOLD_CONTAINERS = new Set([
  'outcome', 'timepoints', 'follow_up',
  'experimental', 'control',
  'difference', 'or', 'rr', 'rd', 'hr', 'difference_estimate',
  'difference_ci_lower', 'difference_ci_upper',
  'or_ci_lower', 'or_ci_upper', 'rr_ci_lower', 'rr_ci_upper',
  'estimate', 'ci_lower', 'ci_upper', 'n',
  'events', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6',
  'classification_method',
]);

/** 由数据集/流程填写、不要求 LLM 抽取的列。 */
const NON_LLM_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check', 'row_id', 'article_id', 'study_id', 'title_sheet2']);

/** 时点块内的字段：gold 的时点是嵌套的，这里只比对"每个时点块内的键"。 */
const TIMEPOINT_KEYS = TIMEPOINT_FIELDS.map((f) => camelToSnake(f.key));

const canonArticle = new Set([...ARTICLE_FIELDS, ...STUDY_OUTCOME_FIELDS].map((f) => camelToSnake(f.key)));
const canonComparison = new Set(COMPARISON_FIELDS.map((f) => camelToSnake(f.key)));
const canonOutcomeTop = new Set(OUTCOME_TOP_FIELDS.map((f) => camelToSnake(f.key)));

const goldDir = join(ROOT, 'build', 'gold');
const files = readdirSync(goldDir)
  .filter((f) => /^\d{4}\.json$/.test(f))
  .filter((f) => !onlyYear || f === `${onlyYear}.json`)
  .sort();

if (!files.length) {
  console.error(`没有找到金标准文件（build/gold/${onlyYear ?? '<year>'}.json）`);
  process.exit(2);
}

/** 收集金标准里实际出现的键及其出现次数。 */
const articleKeys = new Map();
const studyKeys = new Map();
const comparisonKeys = new Map();
const outcomeTopKeys = new Map();
const timepointKeys = new Map();
const outcomeKinds = new Map();

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

for (const f of files) {
  const doc = JSON.parse(readFileSync(join(goldDir, f), 'utf8'));
  for (const a of doc.articles ?? []) {
    for (const k of Object.keys(a.article ?? {})) bump(articleKeys, k);
    for (const k of Object.keys(a.study ?? {})) bump(studyKeys, k);
    for (const c of a.comparisons ?? []) for (const k of Object.keys(c)) bump(comparisonKeys, k);
    for (const o of a.outcomes ?? []) {
      for (const k of Object.keys(o)) bump(outcomeTopKeys, k);
      for (const [tpName, block] of Object.entries(o.timepoints ?? {})) {
        for (const [kind, fields] of Object.entries(block ?? {})) {
          bump(outcomeKinds, kind);
          for (const k of Object.keys(fields ?? {})) bump(timepointKeys, k);
        }
        void tpName;
      }
    }
  }
}

/* ------------------------------ 差异分析 ------------------------------ */

const diff = (goldMap, canonSet) => {
  const missing = [...goldMap.entries()]
    .filter(([k]) => !NON_LLM_GOLD.has(k) && !GOLD_CONTAINERS.has(k) && !canonSet.has(k))
    .sort((a, b) => b[1] - a[1]);
  const unused = [...canonSet].filter((k) => !goldMap.has(k)).sort();
  return { missing, unused };
};

const art = diff(articleKeys, canonArticle);
const cmp = diff(comparisonKeys, canonComparison);
const outTop = diff(outcomeTopKeys, canonOutcomeTop);

// 时点块：金标准的键在嵌套层里，单独比对
const tpMissing = [...timepointKeys.entries()]
  .filter(([k]) => !TIMEPOINT_KEYS.includes(k) && !GOLD_CONTAINERS.has(k))
  .sort((a, b) => b[1] - a[1]);
const tpUnused = TIMEPOINT_KEYS.filter((k) => !timepointKeys.has(k));

const report = {
  at: new Date().toISOString(),
  years: files.map((f) => f.replace('.json', '')),
  article: { missing: art.missing, unused: art.unused },
  comparison: { missing: cmp.missing, unused: cmp.unused },
  outcomeTop: { missing: outTop.missing, unused: outTop.unused },
  timepoint: { missing: tpMissing, unused: tpUnused, kinds: [...outcomeKinds.entries()].sort((a, b) => b[1] - a[1]) },
};

mkdirSync(join(ROOT, 'build'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'coverage.json'), JSON.stringify(report, null, 2), 'utf8');

const show = (title, missing, unused) => {
  console.log(`\n── ${title} ──`);
  if (missing.length) {
    console.log(`  ✗ 金标准有、规范清单没有（**永远抽不出来**）共 ${missing.length} 个：`);
    for (const [k, n] of missing) console.log(`      ${k.padEnd(38)} 出现 ${n} 次`);
  } else console.log('  ✓ 金标准的列都已覆盖');
  if (unused.length) {
    console.log(`  · 规范清单有、金标准没有（额外字段，不计分）：${unused.join(', ')}`);
  }
};

show('文章级（Sheet1 + Sheet2）', art.missing, art.unused);
show('比较组级（Sheet1）', cmp.missing, cmp.unused);
show('结局级（Sheet3 顶层）', outTop.missing, outTop.unused);
console.log(`\n── 时点块 ──`);
if (tpMissing.length) {
  console.log(`  ✗ 金标准时点块里的键未覆盖：`);
  for (const [k, n] of tpMissing) console.log(`      ${k.padEnd(38)} 出现 ${n} 次`);
} else console.log('  ✓ 已覆盖');
console.log(`  时点块类型：${report.timepoint.kinds.map(([k, n]) => `${k}(${n})`).join(', ')}`);

const totalMissing = art.missing.length + cmp.missing.length + outTop.missing.length + tpMissing.length;

/* ------------------------- 编码集审计（值域覆盖） ------------------------- */

/*
 * 为什么还要审编码：字段"存在"不代表"能答对"。
 * 实测踩到的坑：`missing_data_handling` 的真实批注有 **13** 个取值
 * （12=No missing data、13=No explicit statement），而规范清单里只写了 5 个——
 * 金标准里出现最多的恰恰是 13（×119 次），流水线**永远答不出来**；
 * `primary_analysis` 同理缺了 4=No explicit statement（金标准 ×52）。
 * 因此把「金标准里实际出现的编码 ⊆ 规范清单的 codes」也纳入审计。
 */
const CODE_AUDIT = [];
{
  const canonByKey = new Map();
  for (const f of [...ARTICLE_FIELDS, ...STUDY_OUTCOME_FIELDS, ...COMPARISON_FIELDS, ...OUTCOME_TOP_FIELDS, ...TIMEPOINT_FIELDS]) {
    if (f.codes) canonByKey.set(camelToSnake(f.key), new Set(Object.keys(f.codes)));
  }

  /** 收集金标准里每个字段出现过的 code / raw 取值。 */
  const observed = new Map();   // snakeKey → Map(value → count)
  const bumpVal = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (!observed.has(k)) observed.set(k, new Map());
    const m = observed.get(k);
    m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  };

  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(goldDir, f), 'utf8'));
    for (const a of doc.articles ?? []) {
      for (const [k, v] of Object.entries(a.article ?? {})) {
        if (v && typeof v === 'object') { bumpVal(k, v.code); }
      }
      for (const c of a.comparisons ?? []) {
        for (const [k, v] of Object.entries(c)) {
          if (v && typeof v === 'object' && 'raw' in v) { bumpVal(k, v.code ?? v.raw); }
        }
      }
      for (const o of a.outcomes ?? []) {
        for (const [k, v] of Object.entries(o.outcome ?? {})) {
          if (v && typeof v === 'object' && 'raw' in v) bumpVal(k, v.code ?? v.raw);
        }
        for (const block of Object.values(o.timepoints ?? {})) {
          for (const fields of Object.values(block ?? {})) {
            for (const [k, v] of Object.entries(fields ?? {})) {
              if (v && typeof v === 'object' && 'raw' in v) bumpVal(k, v.code ?? v.raw);
            }
          }
        }
      }
    }
  }

  for (const [key, canonCodes] of canonByKey) {
    const seen = observed.get(key);
    if (!seen) continue;
    /** 多选写作 a/b（或 a、b）：拆开后每个分量都必须在编码表里。 */
    const comboOk = (v) => {
      const parts = String(v).split(/\s*[/、,]\s*/).filter(Boolean);
      return parts.length > 1 && parts.every((x) => canonCodes.has(x));
    };
    const unexpected = [...seen.entries()]
      .filter(([v]) => {
        if (canonCodes.has(v)) return false;
        if (/^(NR|NA|NE)$/i.test(v)) return false;
        if (comboOk(v)) return false;
        // 明显是自由文本（含空格且较长）= 该列被写成了描述，不算"缺编码"，单独提示
        if (String(v).length > 12 && /\s/.test(String(v))) return false;
        return true;
      })
      .sort((a, b) => b[1] - a[1]);
    // 顺带记下"该列被写成散文"的情况（多为金标准列错位，评估时应知悉）
    const prose = [...seen.entries()].filter(([v]) => !canonCodes.has(v) && String(v).length > 12 && /\s/.test(String(v)));
    if (prose.length) {
      const sample = prose.slice(0, 2).map(([v, n]) => `${String(v).slice(0, 40)}…(×${n})`);
      report.proseValues = [...(report.proseValues ?? []), { field: key, sample }];
    }
    if (unexpected.length) {
      CODE_AUDIT.push({ field: key, canon: [...canonCodes].sort(), unexpected });
    }
  }
}

console.log(`\n── 编码集审计（金标准出现但规范清单没有的编码）──`);
if (CODE_AUDIT.length === 0) {
  console.log('  ✓ 金标准里出现过的编码都在规范清单内');
} else {
  for (const c of CODE_AUDIT) {
    console.log(`  ✗ ${c.field}`);
    console.log(`      规范清单: ${c.canon.join(',')}`);
    console.log(`      金标准另有: ${c.unexpected.map(([v, n]) => `${v}(×${n})`).join(', ')}`);
  }
}
report.codeAudit = CODE_AUDIT;

const totalMissing2 = totalMissing + CODE_AUDIT.length;
console.log(`\n  合计未覆盖：字段 ${totalMissing} 个 / 编码集 ${CODE_AUDIT.length} 处  →  build/coverage.json\n`);
process.exit(0);
