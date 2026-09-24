/**
 * @aa/core — 人工标注覆盖层（human-in-the-loop）
 *
 * 需求：前端框选 LLM 提取时的证据，并允许人工修改抽取结果。
 *
 * 设计要点：
 *
 *  1. **不改写流水线产物**。人工修改单独存成"覆盖层"（overlay），
 *     与 LLM 产物分离。理由与金标准处理一致（见 docs/02-gold-schema.md）：
 *     自动改写会掩盖问题、且不可审计。分开存可以随时回放"原始 vs 人工"的差异，
 *     也方便计算人工修正率（评估 LLM 质量的关键指标）。
 *
 *  2. **字段路径与流水线一致**（如 `comparisons.0.randomizationClass`、
 *     `outcomes.1.timepoints.endOfTreatment.continuous.experimental.estimate`），
 *     因此合并逻辑可以通用，不需要为不同层级写特例。
 *
 *  3. **人工值也可带证据**。框选的 bbox 与 quote 一并存下——
 *     这正是需求 1「框选提取证据」的落地点。
 *
 *  4. **保留 LLM 原值**（`llmValue`），便于对比与回滚。
 */

import type { Evidence, FieldValue, ValueProvenance } from './contracts.js';

/** 一条人工标注。 */
export interface AnnotationEntry {
  /** 规范字段路径，与流水线一致 */
  fieldPath: string;
  /** 人工设定的值 */
  value: FieldValue;
  /** LLM 原值（若该字段由 LLM 产出），用于对比与回滚 */
  llmValue?: FieldValue;
  /** 人工备注 */
  note?: string;
  /** 标注人 */
  author?: string;
  /** 标注时间（ISO） */
  updatedAt: string;
  /**
   * 修改类型：
   *   confirm  = 确认 LLM 值正确（不改值，仅记录置信）
   *   override = 修改为人工值
   *   add      = LLM 未抽出该字段，人工补录
   */
  action: 'confirm' | 'override' | 'add';
}

/** 一篇研究的人工标注覆盖层。 */
export interface AnnotationOverlay {
  schemaVersion: 'AA_ANNOTATION/1.0';
  year: string;
  /** 以 (year, articleId) 为主键——实测存在跨年份重名 ID */
  articleId: string;
  /** 对应的 PDF */
  sourcePdf: string;
  entries: AnnotationEntry[];
  updatedAt: string;
}

/** 合并后的字段（人工优先）。 */
export interface MergedField {
  fieldPath: string;
  /** 最终采用的值 */
  value: FieldValue;
  /** 值来源：人工覆盖 / LLM / 确定性 */
  decidedBy: ValueProvenance;
  /** 是否被人工改动过 */
  overridden: boolean;
  /** LLM 原值（若被覆盖） */
  llmValue?: FieldValue;
  annotation?: AnnotationEntry;
}

/**
 * 合并人工覆盖层与流水线产物。
 *
 * 规则（简单且可预测，避免隐藏优先级）：
 *   - 覆盖层里有该 fieldPath 的条目 → 采用人工值，decidedBy = 'human'
 *   - 否则若流水线有该字段 → 采用流水线值
 *   - 两者都没有 → 不产出该字段（缺失即缺失，不编造）
 */
export function mergeOverlay(
  pipelineFields: Readonly<Record<string, FieldValue>>,
  overlay: AnnotationOverlay | null,
): MergedField[] {
  const byPath = new Map<string, MergedField>();

  for (const [fieldPath, value] of Object.entries(pipelineFields)) {
    byPath.set(fieldPath, {
      fieldPath,
      value,
      decidedBy: value.provenance,
      overridden: false,
    });
  }

  for (const entry of overlay?.entries ?? []) {
    const prev = byPath.get(entry.fieldPath);
    byPath.set(entry.fieldPath, {
      fieldPath: entry.fieldPath,
      value: entry.value,
      decidedBy: 'human',
      overridden: entry.action !== 'confirm',
      ...(prev ? { llmValue: prev.value } : {}),
      annotation: entry,
    });
  }

  return [...byPath.values()].sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
}

/** 构造人工标注条目。 */
export function makeAnnotation(
  fieldPath: string,
  value: FieldValue,
  opts: {
    action: AnnotationEntry['action'];
    llmValue?: FieldValue;
    note?: string;
    author?: string;
  },
): AnnotationEntry {
  return {
    fieldPath,
    value,
    action: opts.action,
    ...(opts.llmValue ? { llmValue: opts.llmValue } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** 统计人工干预情况（LLM 质量评估用）。 */
export function annotationStats(overlay: AnnotationOverlay | null): {
  total: number; added: number; overridden: number; confirmed: number;
} {
  const entries = overlay?.entries ?? [];
  return {
    total: entries.length,
    added: entries.filter((e) => e.action === 'add').length,
    overridden: entries.filter((e) => e.action === 'override').length,
    confirmed: entries.filter((e) => e.action === 'confirm').length,
  };
}

/** 用框选结果构造证据（前端"框选写入证据"的落地点）。 */
export function evidenceFromSelection(
  page: number,
  bbox: readonly [number, number, number, number],
  quote: string,
  opts: { kind?: Evidence['kind']; blockId?: string } = {},
): Evidence {
  return {
    kind: opts.kind ?? 'text',
    page,
    bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
    quote,
    ...(opts.blockId ? { blockId: opts.blockId } : {}),
  };
}
