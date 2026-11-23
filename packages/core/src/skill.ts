/**
 * @aa/core — SKILL 契约
 *
 * 需求 3 要求"用多 Agent SKILL 针对不同层级精细化提取"。
 * 这里把 SKILL 定义成【有明确输入输出契约 + 证据要求 + 校验器】的单元，
 * 而不是一段提示词。这样每个层级都能独立测试、独立评分、独立替换模型。
 */

import type { Evidence, Issue } from './contracts.js';
import type { MiniDoc, SectionRole } from './minidoc.js';

/** 每个 SKILL 负责的抽取层级。 */
export type SkillLevel = 'article' | 'comparison' | 'outcome' | 'cross-cutting';

/** SKILL 可以使用的工具（由运行器注入，便于离线测试）。 */
export interface SkillContext {
  doc: MiniDoc;
  /** 调用 LLM。实现由运行器提供，SKILL 不关心具体模型 */
  llm: LlmInvoker;
  /** 联网补充（Crossref 等）。未配置时为 undefined */
  crossref?: CrossrefClient;
  /**
   * 第二联网补充源（Europe PMC）。未配置时为 undefined。
   *
   * 与 `crossref` 并列而不是合并成一个接口，是因为**两者的能力边界不同**：
   * Crossref 是 DOI 的权威方（可覆盖 title/journal/firstAuthor）；
   * Europe PMC 只适合当第二意见（题名常更完整，但**不含通讯作者邮箱**）。
   * 接口定义在本包内而不是 import `@aa/europepmc`——core 是所有包的依赖，不能反向依赖。
   */
  europepmc?: EuropePmcClient;
  /** 结构化日志 */
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** 读取金标准字段定义（受控编码的图例来源） */
  legend?: LegendLookup;
}

export interface LlmRequest {
  /** 系统提示（SKILL 的角色与约束） */
  system: string;
  /** 用户内容（证据材料） */
  user: string;
  /** 期望的 JSON Schema；运行器据此做结构化输出约束 */
  schema?: unknown;
  /** 温度等采样参数 */
  temperature?: number;
  /** 单次 Responses 请求可覆盖全局思考强度。 */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
  /** 归属标识，便于计费与复现 */
  tag: string;
}

export interface LlmResponse {
  /** 原始文本输出 */
  text: string;
  /** 若请求了 schema，则为解析后的对象 */
  json?: unknown;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmInvoker {
  invoke(req: LlmRequest): Promise<LlmResponse>;
}

/** Crossref 等联网核验的最小接口。 */
export interface CrossrefClient {
  /** 按 DOI 查询作品元信息 */
  byDoi(doi: string): Promise<CrossrefWork | null>;
  /** 按题名模糊查询，返回候选（用于验证 DOI 缺失的情形） */
  byTitle(title: string, opts?: { year?: string }): Promise<readonly CrossrefWork[]>;
}

export interface CrossrefWork {
  doi: string;
  title?: string;
  containerTitle?: string;
  issuedYear?: string;
  authors?: readonly string[];
  type?: string;
}

/** Europe PMC 记录（只声明 SKILL 层用得到的部分）。 */
export interface EuropePmcWork {
  doi: string;
  /** PubMed 题名——**比 Crossref 更常带副标题**，这是接入本源的主要理由 */
  title?: string;
  journal?: string;
  pubYear?: string;
  pmid?: string;
  pmcid?: string;
  /** 全部作者的邮箱（**不含通讯作者标记**，不用于自动填 authorContact） */
  authorEmails: readonly string[];
}

/** Europe PMC 的最小接口（按 DOI 查一条）。 */
export interface EuropePmcClient {
  byDoi(doi: string): Promise<EuropePmcWork | null>;
}

/** 受控编码图例查询（来自金标准的图例行与批注）。 */
export interface LegendLookup {
  /** 取某层级某字段的图例文本 */
  get(level: SkillLevel, field: string): string | undefined;
}

/**
 * SKILL 的输出。
 * 注意：产物是"部分字段"而非整份文档——运行器负责合并各 SKILL 的结果。
 */
export interface SkillOutput<TPayload = unknown> {
  skillId: string;
  level: SkillLevel;
  /** 该 SKILL 负责的字段（键名与 core 契约中的字段名一致） */
  payload: TPayload;
  /** 该 SKILL 认为有材料但抽不出字段的候选，交人工复核 */
  unresolved: {
    reason: string;
    raw: string;
    evidence: readonly Evidence[];
    confidence: number;
  }[];
  issues: readonly Issue[];
}

/**
 * SKILL 定义。
 *
 * @typeParam TPayload 该 SKILL 产出的字段集合
 */
export interface Skill<TPayload = unknown> {
  id: string;
  /** 语义化版本——契约变更时必须升版本，便于比较不同版本的分数 */
  version: string;
  level: SkillLevel;
  /** 一句话说明职责边界 */
  description: string;
  /** 需要哪些章节的材料（运行器据此裁剪证据，控制 token） */
  needs: readonly SectionRole[];
  /** 是否需要表格材料（多模态场景） */
  needsTables?: boolean;
  /** 是否需要图片（多模态场景） */
  needsFigures?: boolean;

  /** 执行抽取 */
  run(ctx: SkillContext): Promise<SkillOutput<TPayload>>;

  /**
   * 确定性校验器（可选但强烈建议）。
   * 只做能用规则判定的事：编码是否在图例范围内、数值是否能从证据中逐字找到、
   * 例数是否自洽（试验组+对照组=总例数）等。
   */
  validate?(output: SkillOutput<TPayload>, ctx: SkillContext): readonly Issue[];
}

/** 运行器把一个文档上的多个 SKILL 串起来。 */
export interface PipelineStage {
  id: string;
  /** 依赖的上游 stage id，运行器据此拓扑排序 */
  dependsOn?: readonly string[];
  run(input: PipelineInput): Promise<PipelineOutput>;
}

export interface PipelineInput {
  year: string;
  articleId: string;
  doc: MiniDoc;
  /** 上游各 stage 的产出 */
  previous: Readonly<Record<string, unknown>>;
  ctx: Omit<SkillContext, 'doc'>;
}

export interface PipelineOutput {
  stageId: string;
  output: unknown;
  issues: readonly Issue[];
  /** 耗时（ms），用于性能观测 */
  elapsedMs: number;
}
