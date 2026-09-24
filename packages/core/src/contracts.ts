/**
 * @aa/core — 证据、字段与三层抽取结果的核心契约
 *
 * 设计依据（来自 Datas/ 金标准的实测结构，见 docs/02-gold-schema.md）：
 *
 *   1. 金标准是三层粒度：
 *        article     YYYY-NN      文章级（Sheet1 文章字段 + Sheet2）
 *        comparison  YYYY-NN-K    试验组/对照组配对（Sheet1 每行）
 *        outcome     YYYY-NN-K    结局 × 时点（Sheet3 每行）
 *
 *   2. 金标准的多数列是【受控编码】，证据是相邻列的原文。
 *      因此每个字段必须是三元组 { code, raw, legend }，本包把它提升为 FieldValue。
 *
 *   3. 【核心不变量】任何进入抽取结果的字段都必须能指向原文证据（Evidence）。
 *      没有证据的字段只能进入 unresolved，不得进入 fields。
 *      这条不变量是"前端框选证据"（需求 1）与"可复核"的前提。
 */

/* ------------------------------------------------------------------ *
 * 证据
 * ------------------------------------------------------------------ */

/** 证据来源类型。 */
export type EvidenceKind =
  /** 正文文本块 */
  | 'text'
  /** 表格（含 HTML 结构） */
  | 'table'
  /** 图（含图片切图，供多模态） */
  | 'figure'
  /** 图/表的 caption */
  | 'caption'
  /** 表头/表注 */
  | 'footnote'
  /** 联网来源（Crossref 等），不含 PDF 坐标 */
  | 'external';

/**
 * 一条原文证据。
 *
 * 坐标用于前端在 PDF 上高亮/框选。约定：
 *   - 单位 pt，原点为【页面左上角】（y 向下），与 PDF.js 视口一致；
 *   - 坐标系为【未旋转】的页面坐标系（页面旋转由前端视图负责应用）；
 *   - page 从 1 开始。
 *
 * ⚠️ 实测教训：部分 PDF 页面 `rotate: 90`（横向），此时 PDF 原生坐标空间宽高互换。
 *    ingest 阶段必须统一转换到"左上原点 + 未旋转"的约定，否则高亮会错位 199pt。
 */
export interface Evidence {
  kind: EvidenceKind;
  /** 1-based 页码 */
  page: number;
  /** [x0, y0, x1, y1]，页面左上角为原点。external 证据为 null */
  bbox: readonly [number, number, number, number] | null;
  /** 支撑该字段的原文片段，必须逐字来自来源，不得改写 */
  quote: string;
  /** 来源块 id，用于回溯到解析产物（如 MinerU content_list 下标或 block_id） */
  blockId?: string;
  /** 外部来源时给出标识（如 DOI） */
  externalId?: string;
}

/* ------------------------------------------------------------------ *
 * 字段三元组
 * ------------------------------------------------------------------ */

/** 值来源：确定性推导 / 模型抽取 / 外部查询 / 人工确认 */
export type ValueProvenance = 'deterministic' | 'model' | 'external' | 'human';

/** 缺失语义——直接对应金标准里的 NR / NA / 0 等哨兵值。 */
export type MissingSemantics = 'not_reported' | 'not_applicable' | 'empty';

/**
 * 一个抽取字段。
 *
 * `raw` 永远保真（不做任何改写），`code` 只在能确定受控编码时给出，
 * `legend` 解释 code 的含义（来自金标准的图例行）。
 */
export interface FieldValue<T = string> {
  /** 原始文本，逐字来自证据，绝不改写 */
  raw: string;
  /** 归一化后的值（如编码 "1" / "2/5"）。无法确定时为 undefined */
  code?: string;
  /** code 的含义说明 */
  legend?: string;
  /** 支撑证据，至少一条；空数组视为未解析 */
  evidence: readonly Evidence[];
  provenance: ValueProvenance;
  /** 0~1。确定性推导为 1；模型输出为模型自评或后验分 */
  confidence: number;
  /** 若为哨兵值（NR/NA），说明缺失语义 */
  missing?: MissingSemantics;
  /** 模型提出的其它候选（保留供复核，不参与打分） */
  alternatives?: readonly { raw: string; confidence: number }[];
}

/* ------------------------------------------------------------------ *
 * 三层抽取结果
 * ------------------------------------------------------------------ */

export interface GroupStats {
  estimate?: FieldValue;
  ciLower?: FieldValue;
  ciUpper?: FieldValue;
  n?: FieldValue;
}

export interface EventStats {
  events?: FieldValue;
  n?: FieldValue;
}

export interface EstimateWithCi {
  estimate?: FieldValue;
  ciLower?: FieldValue;
  ciUpper?: FieldValue;
}

export interface CategoryCounts {
  cat1?: FieldValue;
  cat2?: FieldValue;
  cat3?: FieldValue;
  cat4?: FieldValue;
  cat5?: FieldValue;
  cat6?: FieldValue;
  n?: FieldValue;
}

/**
 * 结局级抽取结果。
 * `studyId` 形如 `2015-01` 或 `2015-04-01`（含比较组序号），与金标准一致。
 *
 * ⚠️ 关于时点块的形状：这里的 `continuous` 与 SKILL 提示词模板里的扁平键
 * （`experimentalEstimate` / `experimentalCiLower` …）**不同构**。
 *   - 契约层（本文件）：按「组」分组 → `continuous.experimental.estimate`
 *   - 提示词模板：按「平面键」→ `baseline.experimentalEstimate`
 * 这是因为让模型输出两层嵌套（`experimental.estimate`）容易出错，
 * 而扁平键更稳。两者的转换由 outcome SKILL 的 `TIMEPOINT_FIELD_MAP` 负责。
 */
export interface OutcomeLevel {
  studyId: string;
  /** 文献编号 + 结局序号，如 EN009-1（金标准 Sheet3 的 STUDYID 列实为此意） */
  literatureCode?: FieldValue;
  /** ARMNU：多试验组/多对照组时的组别号 */
  armNumber?: FieldValue;
  outcome?: {
    constructCode?: FieldValue;
    subconstructCode?: FieldValue;
    pValueRange?: FieldValue;
    pValue?: FieldValue;
    name?: FieldValue;
    instrument?: FieldValue;
    measurementRange?: FieldValue;
    measurementDirection?: FieldValue;
    measurementUnit?: FieldValue;
    measurementType?: FieldValue;
    baselineAdjusted?: FieldValue;
    primaryOutcomeTimepoint?: FieldValue;
    specialCategory?: FieldValue;
  };
  followUp?: {
    description?: FieldValue;
    value?: FieldValue;
    unit?: FieldValue;
  };
  /** 时点块：基线 / 疗程结束 / 随访结束 */
  timepoints?: {
    baseline?: OutcomeTimepoint;
    endOfTreatment?: OutcomeTimepoint;
    followUpEnd?: OutcomeTimepoint;
  };
}

/** 单个时点块（三组数值：连续型 / 二分类 / 等级资料）。 */
export interface OutcomeTimepoint {
  continuous?: OutcomeContinuous;
  binary?: OutcomeBinary;
  categorical?: OutcomeCategorical;
}

/** 连续型数值块。 */
export interface OutcomeContinuous {
  estimateType?: FieldValue;
  varianceType?: FieldValue;
  experimental?: GroupStats;
  control?: GroupStats;
  [key: string]: FieldValue | GroupStats | undefined;
}

/** 二分类数值块。 */
export interface OutcomeBinary {
  experimental?: EventStats;
  control?: EventStats;
  difference?: EstimateWithCi;
  or?: EstimateWithCi;
  rr?: EstimateWithCi;
  rd?: EstimateWithCi;
  hr?: EstimateWithCi;
}

/** 等级资料（分类计数）块。 */
export interface OutcomeCategorical {
  classificationMethod?: FieldValue;
  experimental?: CategoryCounts;
  control?: CategoryCounts;
}

/** 比较组级抽取结果。对应金标准 Sheet1 的比较组字段。 */
export interface ComparisonLevel {
  studyId: string;
  intervention?: FieldValue;
  control?: FieldValue;
  controlType?: FieldValue;
  controlTypeConverted?: FieldValue;
  comparisonType?: FieldValue;
  randomizationMethod?: FieldValue;
  randomizationClass?: FieldValue;
  allocationConcealment?: FieldValue;
  allocationClass?: FieldValue;
  stratificationBlocking?: FieldValue;
  blindingParticipants?: FieldValue;
  blindingOutcomeAssessor?: FieldValue;
  patientExpectation?: FieldValue;
  practitionerCommunication?: FieldValue;
  practitionerYears?: FieldValue;
  practitionerEducation?: FieldValue;
  practitionerSpecialty?: FieldValue;
  acupunctureType?: FieldValue;
  stimulationType?: FieldValue;
  pointSelection?: FieldValue;
  pointLocationClass?: FieldValue;
  protocolSource?: FieldValue;
  frequencyDesc?: FieldValue;
  frequencyValue?: FieldValue;
  frequencyUnit?: FieldValue;
  frequencyClass?: FieldValue;
  courseDesc?: FieldValue;
  courseValue?: FieldValue;
  courseUnit?: FieldValue;
  totalSessions?: FieldValue;
  deqi?: FieldValue;
  insertionDepthText?: FieldValue;
  insertionDepthClass?: FieldValue;
  stimulationIntensity?: FieldValue;
  needleRetentionDesc?: FieldValue;
  needleRetentionValue?: FieldValue;
  needleRetentionUnit?: FieldValue;
  needleRetentionClass?: FieldValue;
  needleCountText?: FieldValue;
  needleCountMin?: FieldValue;
  postInsertionManipulation?: FieldValue;
  needleAngleClass?: FieldValue;
  needleDirectionClass?: FieldValue;
  maxFollowupDesc?: FieldValue;
  maxFollowupValue?: FieldValue;
  maxFollowupUnit?: FieldValue;
  /*
   * 分组字段（试验组 / 对照组各一列）。
   *
   * ⚠️ 字段名沿用金标准 Sheet1 的列名，但金标准的列名与它自己的批注对不上
   * （实测：`prior_acupuncture_experimental` 的批注是「随机例数」、
   *  `randomized_n_experimental` 的批注是「主要结局时点样本量」、
   *  `analyzed_n_experimental` 的批注是「脱落人数」）。
   * 抽取以批注语义为准（见 tools/canonical-field-map.mjs 的 desc），
   * 键名保持与金标准一致以便评测对齐。彻底修正需同时改金标准与规范清单。
   */
  /** 试验组随机例数（金标准列名 prior_acupuncture_experimental） */
  priorAcupunctureExperimental?: FieldValue;
  /** 对照组随机例数（金标准列名 prior_acupuncture_control） */
  priorAcupunctureControl?: FieldValue;
  baselineCatExperimentalNeg?: FieldValue;
  baselineCatExperimentalPos?: FieldValue;
  baselineCatControlNeg?: FieldValue;
  baselineCatControlPos?: FieldValue;
  totalSessionsClassA?: FieldValue;
  totalSessionsClassB?: FieldValue;
  sexExperimental?: FieldValue;
  sexControl?: FieldValue;
  typeOfData?: FieldValue;
  priorAcupuncture?: FieldValue;
  randomizedN?: FieldValue;
  /** 试验组在主要结局时点的样本量（金标准列名 randomized_n_experimental） */
  randomizedNExperimental?: FieldValue;
  /** 对照组在主要结局时点的样本量（金标准列名 randomized_n_control） */
  randomizedNControl?: FieldValue;
  /** 试验组脱落人数（金标准列名 analyzed_n_experimental） */
  analyzedNExperimental?: FieldValue;
  /** 对照组脱落人数（金标准列名 analyzed_n_control） */
  analyzedNControl?: FieldValue;
  dropoutTotal?: FieldValue;
  missingDataRatio?: FieldValue;
  missingDataReported?: FieldValue;
  primaryAnalysis?: FieldValue;
  missingDataHandling?: FieldValue;
  /** 未在此枚举中的额外字段（保住不丢信息） */
  extra?: Readonly<Record<string, FieldValue>>;
}

/** 文章级抽取结果。 */
export interface ArticleLevel {
  articleId: string;
  literatureNo?: FieldValue;
  title?: FieldValue;
  publicationYear?: FieldValue;
  language?: FieldValue;
  journal?: FieldValue;
  journalClass?: FieldValue;
  impactFactor2019?: FieldValue;
  firstAuthor?: FieldValue;
  authorContact?: FieldValue;
  funding1?: FieldValue;
  funding2?: FieldValue;
  registrationReported?: FieldValue;
  condition?: FieldValue;
  conditionSystem?: FieldValue;
  acuteOrSurgery?: FieldValue;
  country?: FieldValue;
  countryClass?: FieldValue;
  trialCenterCount?: FieldValue;
  /** 联网核验得到的元信息（Crossref），与 PDF 内信息分开放，便于对比 */
  external?: {
    doi?: FieldValue;
    crossrefTitle?: FieldValue;
    crossrefJournal?: FieldValue;
    crossrefYear?: FieldValue;
    crossrefAuthors?: FieldValue;
    /** 与 PDF 内信息的一致性判定 */
    consistency?: 'match' | 'mismatch' | 'unverifiable';
    mismatchNotes?: readonly string[];
  };
  /** Sheet2 的文章级结局分类（原始描述文本） */
  studyOutcomes?: {
    primaryOutcome?: FieldValue;
    pain?: FieldValue;
    nonPain?: FieldValue;
    function?: FieldValue;
    qualityOfLife?: FieldValue;
    importantEvents?: FieldValue;
    mortality?: FieldValue;
    remarks?: FieldValue;
  };
  extra?: Readonly<Record<string, FieldValue>>;
}

/* ------------------------------------------------------------------ *
 * 一次抽取的总文档
 * ------------------------------------------------------------------ */

export interface ExtractionDocument {
  schemaVersion: 'AA_EXTRACTION/1.0';
  /** 以 (year, articleId) 为主键——实测 2022/2024 存在跨年份重名 ID */
  year: string;
  articleId: string;
  sourcePdf: string;
  /** 生成时间（ISO） */
  generatedAt: string;
  /** 流水线版本，便于复现 */
  pipeline: { name: string; version: string; modelIds?: readonly string[] };
  article?: ArticleLevel;
  comparisons: readonly ComparisonLevel[];
  outcomes: readonly OutcomeLevel[];
  /** 无法归属到任何字段、但有价值的候选（不参与打分，供人工复核） */
  unresolved: readonly UnresolvedItem[];
  /** 校验阶段记录的问题 */
  issues: readonly Issue[];
}

export interface UnresolvedItem {
  /** 抽取者（agent / skill）标识 */
  skillId: string;
  reason: string;
  raw: string;
  evidence: readonly Evidence[];
  confidence: number;
}

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface Issue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** 相关字段路径，如 'comparisons[0].randomizationClass' */
  path?: string;
  evidence?: readonly Evidence[];
}

export const ok = (message: string, code: string, extra: Partial<Issue> = {}): Issue =>
  ({ severity: 'info', code, message, ...extra });
export const warn = (message: string, code: string, extra: Partial<Issue> = {}): Issue =>
  ({ severity: 'warning', code, message, ...extra });
export const err = (message: string, code: string, extra: Partial<Issue> = {}): Issue =>
  ({ severity: 'error', code, message, ...extra });
