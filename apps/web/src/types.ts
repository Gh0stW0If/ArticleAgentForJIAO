/** 前端使用的数据类型（与 /api 返回结构对应）。 */

export interface MiniDocPageMeta {
  page: number;
  width: number;
  height: number;
  rotate: number;
}

export interface MiniDocBlock {
  index: number;
  type: string;
  page: number;
  bbox: [number, number, number, number] | null;
  text: string;
}

export interface MiniDoc {
  year: string;
  studyId: string;
  sourcePdf: string;
  pages: MiniDocPageMeta[];
  blocks: MiniDocBlock[];
  stats: { blocks: number; pages: number };
}

export interface StudyEntry {
  file: string;
  studyId: string;
  /** corpus = Datas 语料；import = 用户导入 */
  source: 'corpus' | 'import';
  imported: boolean;
}

/** 一个字段的视图（流水线值 + 人工覆盖层合并结果）。 */
export interface FieldView {
  fieldPath: string;
  label: string;
  /** 规范清单里的键（camelCase）——按「原始表格列序」排序时用它对齐 */
  key?: string;
  raw: string;
  code?: string;
  legend?: string;
  decidedBy: 'human' | 'model' | 'deterministic' | 'external';
  overridden: boolean;
  /** 产物里是否存在该字段（false = 人工新增/纳入） */
  inGold?: boolean;
  confidence?: number;
  /** 证据（**只在左侧 PDF 上定位**，右侧不显示原文） */
  evidence?: { page: number; bbox: [number, number, number, number] | null; quote: string; kind?: string }[];
  missing?: 'not_reported' | 'not_applicable' | 'empty';
  llmRaw?: string;
  note?: string;
  /** 「待人工确认纳入」候选自带的名称/工具，供「纳入抽取」写入新行 */
  candidate?: { name: string; instrument: string; outcomeClass: string };
}

export interface FieldGroup {
  id: string;
  title: string;
  fields: FieldView[];
  collapsible?: boolean;
  /** 人工纳入出来的行 */
  included?: boolean;
}

/** 「原始表格列序」：键 = 规范清单 camelCase key。 */
export interface SheetOrder {
  sheet1: { article: string[]; comparison: string[] };
  sheet2: string[];
  sheet3: { top: string[]; timepoint: { baseline: string[]; endOfTreatment: string[]; followUpEnd: string[] } };
}

export interface SheetsPayload {
  layoutSource: string | null;
  headerOf: Record<string, string>;
  order: SheetOrder;
  sheet1: { title: string; article: FieldView[]; comparisons: FieldGroup[]; external: FieldView[] };
  sheet2: { title: string; fields: FieldView[] };
  sheet3: {
    title: string;
    rows: (FieldGroup & { index: number })[];
    candidates: FieldView[];
    nextOutcomeIndex: number;
  };
}

/** 后台任务（MinerU 解析 / LLM 抽取）。 */
export interface JobInfo {
  id: string;
  kind: 'parse' | 'extract';
  state: 'running' | 'done' | 'failed';
  year: string;
  study: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logTail: string[];
}

/** 本地设置（密钥只回显掩码）。 */
export interface SettingsInfo {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  crossrefMailto: string;
  apiKeyMasked: string;
  hasKey: boolean;
  keyFromEnv: boolean;
  configPath: string;
}
