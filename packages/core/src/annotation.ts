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
 *
 *  5. **一份覆盖层 = 一位核对人**（202609 需求）。多位核对人各存一份
 *     （`build/annotations/<year>/<study>.<reviewer>.json`），互不覆盖；
 *     再由 `buildConsensus` 汇总成「一致 / 有分歧 / 仅一人核对 / 无人核对」四态。
 *     这是「人机核对、共同参与」的最小落地：**先各自独立留痕，再由机器比对**。
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

/** 覆盖层 schema 版本。v2 起「一位核对人一份文件」。 */
export type AnnotationSchemaVersion = 'AA_ANNOTATION/1.0' | 'AA_ANNOTATION/2.0';

/**
 * v1 遗留覆盖层（没有 `reviewer` 字段）归一化后归属的核对人。
 *
 * 为什么要归一化而不是拒绝读取：`build/annotations/` 下已有的单机记录必须继续可用，
 * 否则升级一次就把用户之前的核对工作弄丢了。
 */
export const LEGACY_REVIEWER = 'legacy';

/** 一位核对人对一篇研究的人工标注覆盖层。 */
export interface AnnotationOverlay {
  schemaVersion: AnnotationSchemaVersion;
  year: string;
  /** 主键 = (year, articleId, reviewer)——实测存在跨年份重名 ID，所以年份必须参与 */
  articleId: string;
  /** 对应的 PDF */
  sourcePdf: string;
  /**
   * 核对人标识（v2 起必填）。旧文件缺省时由 `reviewerOf()` 归一化为 `LEGACY_REVIEWER`。
   *
   * ⚠️ 与 `AnnotationEntry.author` 的分工：**这里是权威来源**，`author` 只是单条记录的冗余快照
   * （便于单文件自解释，也兼容 v1）。
   */
  reviewer?: string;
  entries: AnnotationEntry[];
  updatedAt: string;
}

/** 取覆盖层归属的核对人（兼容没有该字段的 v1 文件）。 */
export function reviewerOf(overlay: AnnotationOverlay): string {
  const r = overlay.reviewer?.trim();
  return r ? r : LEGACY_REVIEWER;
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
  /** 多人核对状态（仅 `mergeConsensus` 产出时存在） */
  reviewStatus?: ReviewStatus;
  /** 各核对人的意见（仅 `mergeConsensus` 产出时存在） */
  opinions?: ReviewOpinion[];
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

/* ==========================================================================
 * 多人机核对（202609 需求）
 *
 * 需求原文（`Datas/design/文章计划 整理 202609/`）：
 *   · 07 说明：「希望能在小程序上补充『人机核对』的功能，因为后续需要建立一个人机核对、
 *     共同参与的模型」
 *   · 02 三篇文章计划：「需 3 位专家（2 个确认，不一致第三方确认）确认提取是否正确 / 给予评分」
 *
 * 设计取舍：**不做投票权重、不做置信度加权**。先把「各自独立留痕」与「机器比对」做出来，
 * 因为模型的训练目标正是这两步产生的数据：
 *   · 每位核对人一份独立覆盖层，互不覆盖、互不可见（盲评）
 *   · 逐字段给出 agreed / disputed / single / machine-only 四态
 *   · **有分歧时不替人做决定**：保留机器原值并标记 disputed，等第三方仲裁
 *   · 另给「两两一致率」，用于衡量核对人之间的一致性（专家间信度）
 * ========================================================================== */

/** 逐字段的核对状态。 */
export type ReviewStatus =
  /** ≥2 位核对人有意见，且结论完全一致 */
  | 'agreed'
  /** ≥2 位核对人有意见，但结论不一致 → 需要第三方仲裁 */
  | 'disputed'
  /** 只有 1 位核对人表过态（还差第二人） */
  | 'single'
  /** 没有任何核对人表态 */
  | 'machine-only';

/** 一位核对人对某个字段的意见。 */
export interface ReviewOpinion {
  reviewer: string;
  action: AnnotationEntry['action'];
  /** 归一化前的人工原值（便于展示核对人到底写了什么） */
  raw: string;
  value: FieldValue;
  note?: string;
  updatedAt: string;
}

/** 单个字段的核对汇总。 */
export interface FieldConsensus {
  fieldPath: string;
  /** 流水线/LLM 原值（人工补录的字段可能没有） */
  machineValue?: FieldValue;
  /** 各核对人的意见（按 reviewer 排序，保证输出稳定） */
  opinions: ReviewOpinion[];
  status: ReviewStatus;
  /** 一致（或仅一人）时采用的最终值；有分歧时为 undefined */
  agreedValue?: FieldValue;
  /** 最终值与机器原值是否相同（用于判定「人工是否真的改动了」） */
  agreedWithMachine: boolean;
}

/** 把字段值归一化成可比字符串（大小写、空白不敏感）。 */
const normRaw = (v: FieldValue | undefined): string =>
  String(v?.raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 汇总多位核对人的覆盖层 → 逐字段状态。
 *
 * 注意：**只做比对，不做仲裁**。`disputed` 的字段不会自动挑一个值，
 * 必须由第三方（或需求方）显式再标一次。
 */
export function buildConsensus(
  pipelineFields: Readonly<Record<string, FieldValue>>,
  overlays: readonly AnnotationOverlay[],
): FieldConsensus[] {
  const slots = new Map<string, { machineValue?: FieldValue; opinions: ReviewOpinion[] }>();

  for (const [fieldPath, value] of Object.entries(pipelineFields)) {
    slots.set(fieldPath, { machineValue: value, opinions: [] });
  }

  for (const overlay of overlays) {
    const reviewer = reviewerOf(overlay);
    for (const entry of overlay.entries) {
      const slot = slots.get(entry.fieldPath) ?? { opinions: [] };
      slot.opinions.push({
        reviewer,
        action: entry.action,
        raw: String(entry.value?.raw ?? ''),
        value: entry.value,
        ...(entry.note ? { note: entry.note } : {}),
        updatedAt: entry.updatedAt,
      });
      slots.set(entry.fieldPath, slot);
    }
  }

  const rows: FieldConsensus[] = [];
  for (const [fieldPath, slot] of slots) {
    const opinions = [...slot.opinions].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
    const distinct = new Set(opinions.map((o) => normRaw(o.value)));

    let status: ReviewStatus;
    if (!opinions.length) status = 'machine-only';
    else if (opinions.length === 1) status = 'single';
    else status = distinct.size === 1 ? 'agreed' : 'disputed';

    const applied = status === 'agreed' || status === 'single' ? opinions[0]?.value : undefined;

    rows.push({
      fieldPath,
      ...(slot.machineValue ? { machineValue: slot.machineValue } : {}),
      opinions,
      status,
      ...(applied ? { agreedValue: applied } : {}),
      agreedWithMachine: Boolean(applied) && Boolean(slot.machineValue)
        && normRaw(applied) === normRaw(slot.machineValue),
    });
  }

  return rows.sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
}

/** 核对进度与分歧统计。 */
export interface ConsensusStats {
  /** 参与统计的字段总数（= 机器抽出的 + 人工补录的） */
  total: number;
  agreed: number;
  disputed: number;
  single: number;
  machineOnly: number;
  /** 至少一位核对人表过态的字段数 */
  reviewed: number;
  /** 已达成一致、且与机器原值不同的字段数（= 人工确实改掉的） */
  changed: number;
}

/** 汇总核对统计。 */
export function consensusStats(rows: readonly FieldConsensus[]): ConsensusStats {
  const count = (s: ReviewStatus) => rows.filter((r) => r.status === s).length;
  const agreed = count('agreed');
  const single = count('single');
  return {
    total: rows.length,
    agreed,
    disputed: count('disputed'),
    single,
    machineOnly: count('machine-only'),
    reviewed: agreed + single + count('disputed'),
    changed: rows.filter((r) => (r.status === 'agreed' || r.status === 'single') && !r.agreedWithMachine).length,
  };
}

/** 两位核对人之间的一致性。 */
export interface PairwiseAgreement {
  reviewerA: string;
  reviewerB: string;
  /** 两人都表过态的字段数（分母） */
  common: number;
  /** 结论相同的字段数 */
  same: number;
  /** 结论不同的字段数 */
  disputed: number;
  /** same / common；common = 0 时为 null（不报 0%，避免误读成"完全不一致"） */
  rate: number | null;
}

/**
 * 两两一致率。
 *
 * 只用「两人都表过态」的字段做分母——否则一个人多标了几个字段就会拉低一致率，
 * 那是覆盖率差异，不是判断差异。
 */
export function pairwiseAgreement(overlays: readonly AnnotationOverlay[]): PairwiseAgreement[] {
  const byReviewer = new Map<string, Map<string, string>>();
  for (const ov of overlays) {
    const r = reviewerOf(ov);
    const m = byReviewer.get(r) ?? new Map<string, string>();
    for (const e of ov.entries) m.set(e.fieldPath, normRaw(e.value));
    byReviewer.set(r, m);
  }

  const names = [...byReviewer.keys()].sort();
  const out: PairwiseAgreement[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = byReviewer.get(names[i]!)!;
      const b = byReviewer.get(names[j]!)!;
      let common = 0;
      let same = 0;
      for (const [path, v] of a) {
        if (!b.has(path)) continue;
        common += 1;
        if (b.get(path) === v) same += 1;
      }
      out.push({
        reviewerA: names[i]!,
        reviewerB: names[j]!,
        common,
        same,
        disputed: common - same,
        rate: common ? same / common : null,
      });
    }
  }
  return out;
}

/** 单个核对人的工作量与改动情况。 */
export interface ReviewerSummary {
  reviewer: string;
  total: number;
  added: number;
  overridden: number;
  confirmed: number;
  /** 该核对人最后一次提交时间（ISO） */
  updatedAt: string | null;
}

/** 逐个核对人的统计（用于界面上的核对进度面板）。 */
export function reviewerSummaries(overlays: readonly AnnotationOverlay[]): ReviewerSummary[] {
  return overlays
    .map((ov) => {
      const s = annotationStats(ov);
      return { reviewer: reviewerOf(ov), ...s, updatedAt: ov.updatedAt ?? null };
    })
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

/**
 * 合并多人核对结果（`mergeOverlay` 的多人版本）。
 *
 * 采用规则（与 `mergeOverlay` 保持同一套优先级，避免两套语义）：
 *   - `agreed` / `single` → 采用人工值（decidedBy = human）
 *   - `disputed`         → **保留机器原值**，仅标记 disputed，不替人裁决
 *   - `machine-only`     → 采用机器值
 *
 * `overridden` 由「最终值是否与机器原值不同」判定，而不是看 `action` ——
 * 因为两位核对人可能一个标 `add`、一个标 `override`，但值相同，那仍应算作"人工改动"。
 */
export function mergeConsensus(
  pipelineFields: Readonly<Record<string, FieldValue>>,
  overlays: readonly AnnotationOverlay[],
): MergedField[] {
  return buildConsensus(pipelineFields, overlays).map((row) => {
    const applied = row.status === 'disputed' ? undefined : row.agreedValue;
    const first = row.opinions[0];
    /*
     * 取值优先级：人工一致值 > 机器原值 > 第一条人工意见。
     * 最后那个兜底只可能出现在「两位核对人各补录了不同的值、且机器本来没有该字段」时——
     * 此时 status 一定是 disputed，值仅作展示，`overridden` 仍为 false。
     */
    const value = applied ?? row.machineValue ?? first!.value;

    const merged: MergedField = {
      fieldPath: row.fieldPath,
      value,
      decidedBy: applied ? 'human' : (row.machineValue?.provenance ?? 'human'),
      overridden: Boolean(applied) && !row.agreedWithMachine,
      reviewStatus: row.status,
      opinions: row.opinions,
    };
    if (row.machineValue) merged.llmValue = row.machineValue;
    if (applied && first) {
      merged.annotation = {
        fieldPath: row.fieldPath,
        value: first.value,
        action: first.action,
        updatedAt: first.updatedAt,
        author: first.reviewer,
        ...(first.note ? { note: first.note } : {}),
      };
    }
    return merged;
  });
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
