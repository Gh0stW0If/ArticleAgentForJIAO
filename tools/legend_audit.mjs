#!/usr/bin/env node
/**
 * tools/legend_audit.mjs — 图例「自动提取结果」与「人工规范清单」的一致性校验
 *
 * 为什么需要它：
 *   提示词与 SKILL 的真源是 `tools/canonical-field-map.mjs`（人工维护），
 *   而 `tools/legend_extract.mjs` 从 xlsx 自动提取另一份图例。
 *   两者**会随金标准演进各自漂移**——人工清单漏改、提取器改坏，都不会有任何报错。
 *   本校验器把差异显式暴露出来。
 *
 * 匹配方式：
 *   两边都没有稳定的共同键（一边是 JSON 键、一边是中文表头/编码名），
 *   因此按【标签规范化后相等】匹配，并要求 **kind 一致**（article/comparison/outcome）。
 *   匹配不上的进入"仅在自动提取中"/"仅人工清单"两组，供人工确认。
 *
 * 输出：
 *   - 控制台报告
 *   - build/legend/_audit.json（机读）
 * 退出码：有 conflict 时返回 1（可接入 CI）
 *
 * 调用：node tools/legend_audit.mjs [--year 2015] [--strict]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_OUTCOME_FIELDS,
  OUTCOME_TOP_FIELDS, TIMEPOINT_FIELDS,
} from './canonical-field-map.mjs';

const ROOT = resolve(process.cwd());
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const YEAR = argOf('--year') ?? '2015';
const STRICT = argv.includes('--strict');

const MERGED = join(ROOT, 'build', 'legend', '_merged.json');
if (!existsSync(MERGED)) {
  console.error(`未找到 ${MERGED}\n请先运行：node tools/legend_extract.mjs`);
  process.exit(2);
}

/* ------------------------------ 规范化 ------------------------------ */

/** 标签规范化：去掉编号前缀/空白/标点，用于跨来源匹配。 */
const normLabel = (s) =>
  String(s ?? '')
    .replace(/^\s*\d+[.、)]\s*/, '')      // 去 "1." 前缀
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[)）]/g, '')          // 去括号补充说明
    .replace(/[：:、。，,.\-_/]/g, '')
    .toLowerCase()
    .trim();

/** 编码值规范化：去空白与全角标点，便于比较含义是否一致。 */
const normMeaning = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').replace(/[。；;，,]+$/, '').trim();

/* --------------------------- 人工清单展开 --------------------------- */

/** canonical-field-map 的四个数组 → 带 kind 的统一列表。 */
const canonical = [
  ...ARTICLE_FIELDS.map((f) => ({ ...f, kind: 'article' })),
  ...COMPARISON_FIELDS.map((f) => ({ ...f, kind: 'comparison' })),
  ...STUDY_OUTCOME_FIELDS.map((f) => ({ ...f, kind: 'article' })),
  ...OUTCOME_TOP_FIELDS.map((f) => ({ ...f, kind: 'outcome' })),
  // 时点块字段（B/E/F 三套同构），按 outcome 参与比对；标签由 code 提供
  ...TIMEPOINT_FIELDS.map((f) => ({ ...f, kind: 'outcome', label: f.code })),
];

/** 自动提取结果的 kind 命名与人工清单的对应关系。 */
const KIND_ALIAS = { article: 'article', study: 'article', outcome: 'outcome', comparison: 'comparison' };

const merged = JSON.parse(readFileSync(MERGED, 'utf8'));

/**
 * 自动提取侧建索引。
 *
 * ⚠️ kind 的粒度两边不同：提取器只按 **sheet** 分类（article=Sheet1、study=Sheet2、
 * outcome=Sheet3），而人工清单按**语义层级**分类（article/comparison 都在 Sheet1）。
 * 因此建两套索引：先按 (kind, label) 精确匹配；不中再退回按 label 全局匹配。
 */
const extractedByKindLabel = new Map();
const extractedByLabelOnly = new Map();

for (const f of merged.fields) {
  const kind = KIND_ALIAS[f.kind] ?? f.kind;
  for (const raw of [f.field, f.code]) {
    if (!raw) continue;
    const label = normLabel(raw);
    const score = f.codes ? Object.keys(f.codes).length : 0;

    const kk = `${kind}::${label}`;
    const prev = extractedByKindLabel.get(kk);
    if (!prev || score > (prev.codes ? Object.keys(prev.codes).length : 0)) {
      extractedByKindLabel.set(kk, { ...f, kind, matchedVia: raw });
    }
    const gl = extractedByLabelOnly.get(label);
    if (!gl || score > (gl.codes ? Object.keys(gl.codes).length : 0)) {
      extractedByLabelOnly.set(label, { ...f, kind, matchedVia: raw });
    }
  }
}

/** 查找：先同 kind，再全局。 */
const lookup = (kind, label) => {
  const n = normLabel(label);
  return extractedByKindLabel.get(`${kind}::${n}`) ?? extractedByLabelOnly.get(n) ?? null;
};

/* ------------------------------ 比对 ------------------------------ */

const findings = [];
const matchedKeys = new Set();

for (const c of canonical) {
  const key = `${c.kind}::${normLabel(c.label)}`;
  const e = lookup(c.kind, c.label);
  if (!e) {
    findings.push({
      severity: 'info',
      kind: 'not_in_extract',
      field: c.key,
      label: c.label,
      level: c.kind,
      detail: '人工清单有此字段，但自动提取结果里找不到同标签项（可能标签写法不同）',
    });
    continue;
  }
  matchedKeys.add(key);

  // 编码含义比对
  const cc = c.codes ?? null;
  const ec = e.codes ?? null;
  if (cc && ec) {
    const conflicts = [];
    for (const [code, meaning] of Object.entries(cc)) {
      if (!(code in ec)) continue;
      if (normMeaning(ec[code]) !== normMeaning(meaning)) {
        // 允许"自动提取更完整"：自动值包含人工值时不算冲突
        const a = normMeaning(ec[code]);
        const b = normMeaning(meaning);
        if (!a.includes(b) && !b.includes(a)) {
          conflicts.push({ code, canonical: meaning, extracted: ec[code] });
        }
      }
    }
    if (conflicts.length) {
      findings.push({
        severity: 'conflict',
        kind: 'code_meaning_conflict',
        field: c.key,
        label: c.label,
        level: c.kind,
        detail: `${conflicts.length} 个编码的含义在两边不一致`,
        conflicts,
      });
    }
    const onlyCanonical = Object.keys(cc).filter((x) => !(x in ec));
    const onlyExtracted = Object.keys(ec).filter((x) => !(x in cc));
    if (onlyCanonical.length || onlyExtracted.length) {
      findings.push({
        severity: 'info',
        kind: 'code_set_diff',
        field: c.key,
        label: c.label,
        level: c.kind,
        detail: `编码集合有差异：仅人工清单 [${onlyCanonical.join(',')}]；仅自动提取 [${onlyExtracted.join(',')}]`,
      });
    }
  } else if (cc && !ec) {
    findings.push({
      severity: 'info',
      kind: 'codes_missing_in_extract',
      field: c.key,
      label: c.label,
      level: c.kind,
      detail: `人工清单有 ${Object.keys(cc).length} 个编码，自动提取未得到编码（可能是短编码表被质量门槛过滤）`,
    });
  }

  // 批注要求比对
  const canonReq = c.requirement ? normMeaning(c.requirement) : '';
  const extrReq = (e.requirements ?? []).map(normMeaning).join('');
  if (canonReq && extrReq && !extrReq.includes(canonReq.slice(0, 12))) {
    findings.push({
      severity: 'info',
      kind: 'requirement_text_diff',
      field: c.key,
      label: c.label,
      level: c.kind,
      detail: '填写要求的措辞在两边不同（人工清单为概括版，自动提取为原文），需人工确认语义一致',
    });
  }
}

/* 仅在自动提取中出现、但人工清单未收录 */
const canonicalLabels = new Set(canonical.map((c) => `${c.kind}::${normLabel(c.label)}`));
const onlyExtracted = [];
const seenGlobal = new Set();
for (const [label, e] of extractedByLabelOnly) {
  if (seenGlobal.has(label)) continue;
  seenGlobal.add(label);
  if (canonicalLabels.has(label) || matchedKeys.has(label)) continue;
  // 只报告"有实际内容"的项（有编码或有批注），避免噪声
  const meaningful = (e.codes && Object.keys(e.codes).length) || (e.comments ?? []).length;
  if (!meaningful) continue;
  onlyExtracted.push({
    severity: 'info',
    kind: 'not_in_canonical',
    label: e.field ?? e.code,
    level: e.kind,
    col: e.col,
    detail: `自动提取有实际内容（编码 ${e.codes ? Object.keys(e.codes).length : 0} 个、批注 ${(e.comments ?? []).length} 条），但人工清单未收录`,
  });
}
findings.push(...onlyExtracted);

/* ---------------------- 解码器覆盖检查（第三份图例来源） ---------------------- */

/**
 * 检查 `packages/skills/src/legend.ts` 的 LEGENDS 是否覆盖所有需要编码推导的字段。
 *
 * 为什么必须有这一项：解码器注册表是**第三份**图例来源（另两份是自动提取与人工清单）。
 * 实测教训：`estimateType` / `varianceType` / `measurementDirection` 在人工清单与提示词里
 * 都有，但**漏登记到解码器**，导致 decode() 返回 none、编码推导静默失效——
 * 而当时的校验器只比对"自动提取 vs 人工清单"，完全没发现这个问题。
 */
const legendSrcPath = resolve(ROOT, 'packages/skills/src/legend.ts');
const decoderFindings = [];
let decoderRegisteredCount = 0;
let needCodeCount = 0;

if (existsSync(legendSrcPath)) {
  const src = readFileSync(legendSrcPath, 'utf8');
  const registered = new Set([...src.matchAll(/field:\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]));
  decoderRegisteredCount = registered.size;

  const needCode = canonical.filter((c) => c.codes && Object.keys(c.codes).length > 0);
  needCodeCount = needCode.length;

  // ⚠️ 解码器的有效来源 = legend.ts 的 LEGENDS **∪ canonical 清单**：
  // legend.ts 的 legendFor() 在 LEGENDS 未命中时会回退到 canonical，
  // 因此 canonical 里带 codes 的字段同样是"已登记"，不应报缺失。
  // （曾因只扫 legend.ts 而误报 48 个字段缺失。）
  const effectiveRegistered = new Set([...registered, ...needCode.map((c) => c.key)]);

  for (const c of needCode) {
    if (effectiveRegistered.has(c.key)) continue;
    decoderFindings.push({
      severity: 'conflict',
      kind: 'decoder_missing_field',
      field: c.key,
      label: c.label,
      level: c.kind,
      detail:
        '人工清单与提示词都有该字段的编码表，但解码器（packages/skills/src/legend.ts）未登记 → ' +
        'decode() 会返回 none，编码推导静默失效。请把编码补进 LEGENDS。',
    });
  }

  const canonicalKeys = new Set(canonical.map((c) => c.key));
  for (const f of registered) {
    if (canonicalKeys.has(f)) continue;
    decoderFindings.push({
      severity: 'info',
      kind: 'decoder_extra_field',
      field: f,
      label: f,
      level: 'unknown',
      detail: '解码器登记了该字段，但人工清单未收录（可能是命名差异或历史遗留）',
    });
  }
} else {
  decoderFindings.push({
    severity: 'info', kind: 'decoder_not_found', field: '-', label: '-', level: '-',
    detail: `未找到 ${legendSrcPath}，跳过解码器覆盖检查`,
  });
}
findings.push(...decoderFindings);

/* ------------------------------ 汇总 ------------------------------ */

const conflicts = findings.filter((f) => f.severity === 'conflict');
const infos = findings.filter((f) => f.severity === 'info');

const report = {
  schemaVersion: 'AA_LEGEND_AUDIT/1.0',
  year: YEAR,
  stats: {
    canonicalFields: canonical.length,
    extractedFields: merged.fields.length,
    matched: matchedKeys.size,
    conflicts: conflicts.length,
    infos: infos.length,
    extractedWithCodes: merged.fields.filter((f) => f.codes).length,
    extractedWithComments: merged.fields.filter((f) => (f.comments ?? []).length).length,
    decoderRegistered: decoderRegisteredCount,
    decoderNeeded: needCodeCount,
  },
  findings,
};
mkdirSync(join(ROOT, 'build', 'legend'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'legend', '_audit.json'), JSON.stringify(report, null, 2), 'utf8');

/* 控制台 */
console.log(`图例一致性校验（基准年份 ${YEAR}）\n`);
console.log(`  人工清单字段: ${report.stats.canonicalFields}`);
console.log(`  自动提取字段: ${report.stats.extractedFields}`);
console.log(`  成功匹配:     ${report.stats.matched}`);
console.log(`  编码冲突:     ${report.stats.conflicts}`);
console.log(`  提示项:       ${report.stats.infos}\n`);

if (conflicts.length) {
  console.log('❌ 冲突（必须人工裁决）：');
  for (const f of conflicts) {
    console.log(`  [${f.level}] ${f.field}（${f.label}）— ${f.kind}`);
    if (Array.isArray(f.conflicts)) {
      for (const c of f.conflicts) {
        console.log(`      编码 ${c.code}:`);
        console.log(`        人工清单: ${JSON.stringify(c.canonical)}`);
        console.log(`        自动提取: ${JSON.stringify(c.extracted)}`);
      }
    } else {
      console.log(`      ${f.detail}`);
    }
  }
  console.log('');
}

const byKind = {};
for (const f of infos) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
if (infos.length) {
  console.log('ℹ️  提示项（按类型统计）：');
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${n}`);
  console.log('\n  明细（前 20 条）：');
  for (const f of infos.slice(0, 20)) {
    console.log(`    [${f.level}] ${f.field ?? f.label} — ${f.detail}`);
  }
  if (infos.length > 20) console.log(`    … 另有 ${infos.length - 20} 条，见 _audit.json`);
}

console.log(`\n报告: ${join(ROOT, 'build', 'legend', '_audit.json')}`);
if (!conflicts.length) console.log('✅ 无编码含义冲突');

process.exit(conflicts.length && STRICT ? 1 : 0);
