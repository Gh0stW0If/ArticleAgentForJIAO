/**
 * tools/canonical-field-map.mjs 的类型声明。
 *
 * 该文件是**提示词与图例的唯一真源**，位于仓库 tools/ 下（不属于任何 workspace 包）。
 * skills 包需要读取它来做确定性编码，因此这里补一份声明，
 * 使跨目录导入也有类型（避免 `any` 与 implicit any 报错）。
 *
 * ⚠️ 若 canonical-field-map.mjs 的字段结构变化，本声明需同步更新。
 */

export interface CanonicalField {
  /** 稳定的英文 JSON 键 */
  key: string;
  /** 金标准中文表头 / 编码名 */
  label?: string;
  /** Sheet3 编码名（仅结局级） */
  code?: string;
  /** 出处：由 LLM 抽取 / 由流程填写 */
  source: 'llm' | 'gold_meta' | string;
  /** 允许取值：编码 → 含义 */
  codes?: Record<string, string>;
  /** 来自单元格批注的填写要求 */
  requirement?: string;
  /** 单元格批注坐标，如 'K2' */
  comment?: string;
  /** 字段含义说明 */
  desc?: string;
}

export declare const ARTICLE_FIELDS: CanonicalField[];
export declare const COMPARISON_FIELDS: CanonicalField[];
export declare const STUDY_OUTCOME_FIELDS: CanonicalField[];
export declare const OUTCOME_TOP_FIELDS: CanonicalField[];
export declare const TIMEPOINT_FIELDS: CanonicalField[];
export declare const SOURCE_LABELS: Record<string, string>;
