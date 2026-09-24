/**
 * @aa/skills — 受控编码图例（Legend）与确定性解码
 *
 * 背景（见 docs/02-gold-schema.md）：
 * 金标准多数列是【受控编码】，证据是相邻列的原文。例如：
 *   疾病系统  1=肌肉骨骼和结缔组织疾病 2=神经系统 … 18=围生期
 *   国家分类  1=东方 2=西方 3=东西方都有
 *
 * 分工原则：
 *   - 模型负责"读懂原文"（例如 country = "Spain"、control = "sham acupuncture…"）；
 *   - **编码由本地确定性映射得到**，不让模型直接给数字编码。
 *
 * 理由：数字编码是最容易出错、且最难人工发现的一环（"3" 和 "5" 长得太像），
 * 而它恰恰是最容易用规则做对的一环。把可判定的部分交给代码，能显著降低错误率，
 * 也让错误可复现、可回归测试。
 *
 * ===== 图例来源（三份，曾因此漂移）=====
 *   1. `tools/legend_extract.mjs` 从 xlsx 自动提取 → build/legend/_merged.json（审计用）
 *   2. `tools/canonical-field-map.mjs` 人工维护 → 提示词真源
 *   3. 本文件的 `LEGENDS` 注册表 → 解码器
 *
 * ⚠️ 实测教训：`estimateType` / `varianceType` / `measurementDirection` / `stimulationIntensity`
 * 等 18 个字段在 (2) 与提示词里都有编码表，却**漏登记到 (3)**，导致 `decode()` 返回 none、
 * 编码推导静默失效——没有任何报错，测试也只是没覆盖到。
 *
 * **修正方式：`legendFor()` 在 LEGENDS 未命中时自动回退到 (2) 的清单，从根上消除重复维护。**
 * LEGENDS 仅保留少量需要本地化中文说明的条目（如把英文原文译成中文便于阅读）。
 * `tools/legend_audit.mjs` 会持续检查三份来源是否冲突。
 */

import { ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_OUTCOME_FIELDS, OUTCOME_TOP_FIELDS, TIMEPOINT_FIELDS } from '../../../tools/canonical-field-map.mjs';

export interface LegendEntry {
  /** 字段规范名（与 @aa/core 契约一致） */
  field: string;
  /** 层级 */
  level: 'article' | 'comparison' | 'outcome';
  /** 中文表头（便于与人核对） */
  header: string;
  /** 编码 → 含义 */
  codes: Readonly<Record<string, string>>;
  /** 值关键词 → 编码（确定性反查表，键为小写） */
  valueMap?: Readonly<Record<string, string>>;
  /** 是否允许多选（金标准里有 "1/3"、"2/5" 这类复合值） */
  multi?: boolean;
  /** 说明该图例的来源，便于溯源 */
  source?: string;
}

/** 本文件维护的图例（用于覆盖/补充人工清单里的措辞）。 */
export const LEGENDS: readonly LegendEntry[] = [
  {
    field: 'measurementType',
    level: 'outcome',
    header: '测量类型',
    source: '2015 Sheet3 第1行 O 列 / 第2行 S 列连续型变量',
    codes: { '1': '连续型变量', '2': '二分类变量', '3': '等级资料' },
  },
  {
    field: 'constructCode',
    level: 'outcome',
    header: 'construct',
    source: '2015 Sheet1 第1行 D 列 / Sheet3 第1行 C 列',
    codes: { '0': 'no OI', '1': 'overall', '2': 'pain', '3': 'non-pain', '4': 'function' },
  },
  {
    field: 'estimateType',
    level: 'outcome',
    header: '估计值类型（TESTI）',
    source: '2015 Sheet3 批注 S3 / BK3 / DF3',
    codes: { '1': '均数', '2': '中位数', '3': '组内差值' },
  },
];

/**
 * 从人工清单（tools/canonical-field-map.mjs）构造图例，作为解码器的兜底来源。
 * 这是**唯一真源**，避免像过去那样在两个文件里各维护一份编码表。
 */
const CANONICAL_LEGENDS: readonly LegendEntry[] = [
  ...ARTICLE_FIELDS.map((f) => ({ ...f, level: 'article' as const })),
  ...COMPARISON_FIELDS.map((f) => ({ ...f, level: 'comparison' as const })),
  ...STUDY_OUTCOME_FIELDS.map((f) => ({ ...f, level: 'article' as const })),
  ...OUTCOME_TOP_FIELDS.map((f) => ({ ...f, level: 'outcome' as const })),
  // 时点块字段（B/E/F 同构）：字段名即 code，如 estimateType / varianceType
  ...TIMEPOINT_FIELDS.map((f) => ({
    ...f,
    field: f.key,
    level: 'outcome' as const,
    header: f.key,
  })),
]
  .filter((f) => f.codes && Object.keys(f.codes).length > 0)
  .map((f) => ({
    field: f.key,
    level: f.level,
    header: f.label ?? f.key,
    codes: f.codes as Record<string, string>,
    source: `tools/canonical-field-map.mjs${f.comment ? `（单元格批注 ${f.comment}）` : ''}`,
  }));

/** 合并：本文件的条目优先（可覆盖措辞），其余来自人工清单。 */
const BY_FIELD = new Map<string, LegendEntry>();
for (const l of CANONICAL_LEGENDS) BY_FIELD.set(l.field, l);
for (const l of LEGENDS) BY_FIELD.set(l.field, l);   // 本地覆盖

export function legendFor(field: string): LegendEntry | undefined {
  return BY_FIELD.get(field);
}

/** 已登记的字段名（供审计与测试）。 */
export const registeredFields = (): readonly string[] => [...BY_FIELD.keys()];

export interface DecodeResult {
  /** 解出的编码（可能是复合值如 "2/5"） */
  code?: string;
  /** 编码对应的中文含义 */
  meaning?: string;
  /** 解码方式 */
  method: 'raw-code' | 'value-match' | 'none';
  /** 说明（无图例、无法匹配等） */
  note?: string;
}

/** 值的规范化：小写、去标点空白，用于关键词匹配。 */
const normValue = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * 确定性解码：把原始值或编码转成金标准编码。
 *
 * 策略：
 *   1. 若 raw 本身是合法编码（含 "2/5" 这类复合），直接采用；
 *   2. 否则尝试用图例里的 valueMap / codes 含义做关键词匹配；
 *   3. 都失败则返回 method:'none' 并说明原因——**不猜**。
 */
export function decode(field: string, raw: string): DecodeResult {
  const legend = legendFor(field);
  if (!legend) {
    return { method: 'none', note: `字段 ${field} 无图例（人工清单与 LEGENDS 均未登记）` };
  }

  const v = String(raw ?? '').trim();
  if (!v) return { method: 'none', note: '空值' };

  // 1) 本身就是编码（单值或复合）
  const validCodes = new Set(Object.keys(legend.codes));
  const parts = v.split('/').map((p) => p.trim());
  if (parts.length && parts.every((p) => validCodes.has(p))) {
    const meaning = parts.map((p) => legend.codes[p]).filter(Boolean).join(' / ');
    return { code: parts.join('/'), ...(meaning ? { meaning } : {}), method: 'raw-code' };
  }

  // 2) 关键词反查：先看显式 valueMap
  if (legend.valueMap) {
    const hit = legend.valueMap[v.toLowerCase()];
    const meaning = hit !== undefined ? legend.codes[hit] : undefined;
    if (hit !== undefined && meaning !== undefined) {
      return { code: hit, meaning, method: 'value-match' };
    }
  }

  // 2b) 用编码含义做包含匹配（取最长命中，避免 "是" 命中 "是否"）
  const nv = normValue(v);
  if (nv) {
    let best: { code: string; meaning: string; len: number } | null = null;
    for (const [code, meaning] of Object.entries(legend.codes)) {
      const nm = normValue(meaning);
      if (!nm) continue;
      if (nv === nm || nv.includes(nm) || nm.includes(nv)) {
        const len = Math.min(nm.length, nv.length);
        if (!best || len > best.len) best = { code, meaning, len };
      }
    }
    if (best) return { code: best.code, meaning: best.meaning, method: 'value-match' };
  }

  return { method: 'none', note: `无法把 "${v}" 映射到 ${field} 的任何编码（可选：${Object.keys(legend.codes).join(',')}）` };
}

/** 批量解码一组字段，返回新对象与问题列表。 */
export function decodeAll(
  values: Readonly<Record<string, string>>,
): { decoded: Record<string, string>; notes: { field: string; note: string }[] } {
  const decoded: Record<string, string> = {};
  const notes: { field: string; note: string }[] = [];
  for (const [field, raw] of Object.entries(values)) {
    const r = decode(field, raw);
    if (r.code) decoded[field] = r.code;
    if (r.note) notes.push({ field, note: r.note });
  }
  return { decoded, notes };
}

/** 渲染图例为提示词片段，供 LLM 参考（让它知道有哪些取值可选）。 */
export function renderLegendHints(fields: readonly string[]): string {
  const lines: string[] = [];
  for (const f of fields) {
    const l = legendFor(f);
    if (!l) continue;
    const opts = Object.entries(l.codes).map(([c, m]) => `${c}=${m}`).join(' ');
    lines.push(`- ${l.header}（${f}）：${opts}`);
  }
  return lines.length ? lines.join('\n') : '';
}
