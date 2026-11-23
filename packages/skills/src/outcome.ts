/**
 * @aa/skills — SKILL: 结局级（outcome）
 *
 * 对应金标准 Sheet3 的**结局自身字段**部分（名称、测量工具、编码、量表范围/方向/单位/类型、
 * 基线调整、随访时间）。**数值部分不在这里**——「结局 × 时点」的效应量/变异值/例数由
 * 下游 SKILL `outcome-values` 负责（见 outcome-values.ts 里的说明：两套规则都很长，
 * 混在一次调用里会互相挤占篇幅，实测两边都做不好）。
 *
 * 结构（与 build/gold 一致，见 docs/02-gold-schema.md）：
 *   outcomes[] = { ...结局元信息, baseline|endOfTreatment|followUpEnd: { 数值字段 } }
 * 时点块由 `outcome-values` 回填；本 SKILL 若自己拿到了时点块（例如单独运行时模型仍给了），
 * 也会照常合并与校验——路径映射与校验实现与下游共用（见 timepoints.ts）。
 *
 * ===== 为什么分两次调用 =====
 *
 * 一篇论文常有 4~6 个结局指标，一次性输出枚举 + 逐条字段会撞上输出长度上限
 * （finish_reason=length），而截断的 JSON 无法解析 —— 结果是**整个结局层全丢**。
 * 因此拆成两步：
 *   1. `list`  ：只枚举结局指标（每个量表/分量表一条），填名称与工具；
 *   2. `item`  ：针对其中某一个结局，抽它自身的字段。
 * 两步的系统提示完全相同，只有用户消息末尾的「本次任务」不同；材料放在前面，
 * 于是同一篇论文的多次调用共享「系统提示 + 材料」前缀，能吃到服务端的上下文缓存。
 */

import {
  type OutcomeLevel,
  type Issue,
  type Skill,
  type SkillContext,
  type SkillOutput,
  type FieldValue,
  warn,
} from '@aa/core';
import { PROMPTS, OUTCOME_TASKS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundNested, type GroundOptions } from './grounding.ts';
import { decode } from './legend.ts';
import {
  TIMEPOINTS,
  type TimepointJsonKey,
  type TimepointBlocks,
  addTimepointPaths,
  TIMEPOINT_FIELDS_BY_KIND,
  decodeTimepointCodes,
  validateTimepoints,
} from './timepoints.ts';

/*
 * 时点相关定义与校验集中在 timepoints.ts —— 本文件与 outcome-values.ts 共用，
 * 这里重新导出，保持既有引用（测试、其他工具）不变。
 */
export {
  TIMEPOINTS,
  TIMEPOINT_FIELD_MAP,
  TIMEPOINT_FIELDS_BY_KIND,
  TIMEPOINT_CODE_TARGETS,
  VARIANCE_PREFERENCE,
  SINGLE_VALUE_VARIANCE,
  TWO_BOUND_VARIANCE,
} from './timepoints.ts';
export type { TimepointJsonKey } from './timepoints.ts';

/** 结局自身的字段：JSON 键 → 规范路径（阶段 1：枚举时填）。 */
const OUTCOME_META_MAP: Readonly<Record<string, string>> = {
  armNumber: 'armNumber',
  specialDataFlag: 'outcome.specialCategory',
  construct: 'outcome.constructCode',
  subconstruct: 'outcome.subconstructCode',
  pValueRange: 'outcome.pValueRange',
  pValue: 'outcome.pValue',
  outcomeName: 'outcome.name',
  instrument: 'outcome.instrument',
  measurementRange: 'outcome.measurementRange',
  measurementDirection: 'outcome.measurementDirection',
  measurementUnit: 'outcome.measurementUnit',
  measurementType: 'outcome.measurementType',
  baselineAdjusted: 'outcome.baselineAdjusted',
  primaryOutcomeTimepoint: 'outcome.primaryOutcomeTimepoint',
};

/** 本结局的随访时间（阶段 2 与数值一起填）。 */
const OUTCOME_FOLLOWUP_MAP: Readonly<Record<string, string>> = {
  followUpDescription: 'followUp.description',
  followUpValue: 'followUp.value',
  followUpUnit: 'followUp.unit',
};

/** 全部结局级字段（元信息 + 随访时间），供路径映射与测试使用。 */
const OUTCOME_TOP_MAP: Readonly<Record<string, string>> = {
  ...OUTCOME_META_MAP,
  ...OUTCOME_FOLLOWUP_MAP,
};

/** 需要确定性编码的结局元字段。 */
const OUTCOME_CODE_TARGETS: readonly string[] = [
  'armNumber', 'specialDataFlag', 'construct', 'subconstruct', 'pValueRange',
  'measurementDirection', 'measurementType', 'baselineAdjusted', 'primaryOutcomeTimepoint',
];

/** 时点块内需要确定性编码的字段。 */
const TIMEPOINT_CODE_TARGETS: readonly string[] = ['estimateType', 'varianceType'];

/** 随访时间块内需要确定性编码的字段。 */
const FOLLOWUP_CODE_TARGETS: readonly string[] = ['followUpUnit'];

/** ARMNU 编码的含义（写进 FieldValue.legend，前端可读）。 */
const ARM_STRUCTURE_LEGEND: Readonly<Record<ArmStructureCode, string>> = {
  '1': '双臂',
  '2': '多臂',
  '3': '多试验组',
  '4': '多对照组',
};

/** 为第 idx 个结局生成完整路径映射（含三个时点块）。 */
export function buildOutcomePathMap(idx: number, timepointKeys: readonly TimepointJsonKey[]): Record<string, string> {
  const map: Record<string, string> = {};
  const inPrefix = `outcomes.${idx}`;
  for (const [jsonKey, suffix] of Object.entries(OUTCOME_TOP_MAP)) {
    map[`${inPrefix}.${jsonKey}`] = suffix;
  }
  addTimepointPaths(map, inPrefix, timepointKeys);
  return map;
}

/** 阶段 1（识别）的路径映射：只有结局名称与测量工具。 */
export function buildOutcomeIdentityPathMap(idx: number): Record<string, string> {
  const inPrefix = `outcomes.${idx}`;
  return {
    [`${inPrefix}.outcomeName`]: 'outcome.name',
    [`${inPrefix}.instrument`]: 'outcome.instrument',
  };
}

/** 阶段 1（枚举）的路径映射：只有结局元信息。 */
export function buildOutcomeMetaPathMap(idx: number): Record<string, string> {
  const map: Record<string, string> = {};
  const inPrefix = `outcomes.${idx}`;
  for (const [jsonKey, suffix] of Object.entries(OUTCOME_META_MAP)) map[`${inPrefix}.${jsonKey}`] = suffix;
  return map;
}

/** 阶段 2（取值）的路径映射：结局字段 + 随访时间 + 各时点数值块。 */
export function buildOutcomeValuesPathMap(idx: number, timepointKeys: readonly TimepointJsonKey[]): Record<string, string> {
  const map: Record<string, string> = {};
  const inPrefix = `outcomes.${idx}`;
  // 阶段 2 会把结局自身字段一并取回（编码/范围/方向/单位/类型/基线调整…）
  for (const [jsonKey, suffix] of Object.entries(OUTCOME_META_MAP)) {
    if (jsonKey === 'outcomeName' || jsonKey === 'instrument') continue;  // 阶段 1 已有
    map[`${inPrefix}.${jsonKey}`] = suffix;
  }
  for (const [jsonKey, suffix] of Object.entries(OUTCOME_FOLLOWUP_MAP)) map[`${inPrefix}.${jsonKey}`] = suffix;
  addTimepointPaths(map, inPrefix, timepointKeys);
  return map;
}

/** 随访时间单位 → 金标准编码（见 canonical：1=天 2=月 3=年 4=周 5=小时）。 */
const FOLLOWUP_UNIT_CODE: Readonly<Record<string, string>> = {
  day: '1', days: '1', 天: '1',
  month: '2', months: '2', 月: '2',
  year: '3', years: '3', 年: '3',
  week: '4', weeks: '4', 周: '4',
  hour: '5', hours: '5', 小时: '5',
};

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

/**
 * 随访时间三件套的**内部一致性**修正。
 *
 * 实测缺陷（语义判定报出来的 "存在错误" 里有 2 例）：模型给了
 * `followUpDescription = "13 weeks"` 却把 `followUpValue` / `followUpUnit` 填成 `NR`——
 * 同一字段自相矛盾，金标准则是有值的（"7 weeks" → value 7 / unit 4）。
 *
 * 因此当描述里能解析出「数值 + 单位」而 value/unit 缺失时，就地确定性地补上
 * （单位按 canonical 的 5 个编码映射），并记 issue 以便审计。
 */
function normalizeFollowUp(
  fu: NonNullable<OutcomeLevel['followUp']>,
  base: string,
  issues: Issue[],
): NonNullable<OutcomeLevel['followUp']> {
  const desc = String(fu.description?.raw ?? '').trim();
  const missingValue = !fu.value?.raw || /^(NR|NA)$/i.test(fu.value.raw);
  const missingUnit = !fu.unit?.raw || /^(NR|NA)$/i.test(fu.unit.raw);
  if (!desc || /^(NR|NA)$/i.test(desc)) return fu;
  if (!missingValue && !missingUnit) return fu;

  const m = /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years|hour|hours|天|周|月|年|小时)/i.exec(desc)
    ?? /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|days|week|weeks|month|months|year|years|hour|hours)\b/i.exec(desc);
  if (!m) return fu;

  const valueRaw = /^\d/.test(m[1]!) ? m[1]! : (NUMBER_WORDS[m[1]!.toLowerCase()] ?? '');
  const unitCode = FOLLOWUP_UNIT_CODE[m[2]!.toLowerCase()];
  if (!valueRaw || !unitCode) return fu;

  const ev = fu.description!.evidence;
  const patched: NonNullable<OutcomeLevel['followUp']> = { ...fu };
  if (missingValue) {
    patched.value = {
      raw: valueRaw,
      evidence: ev,
      provenance: 'deterministic',
      confidence: 0.9,
    };
  }
  if (missingUnit) {
    patched.unit = {
      raw: unitCode,
      code: unitCode,
      legend: { '1': '天', '2': '月', '3': '年', '4': '周', '5': '小时' }[unitCode] ?? '',
      evidence: ev,
      provenance: 'deterministic',
      confidence: 0.9,
    };
  }
  issues.push(warn(
    `${base}.followUp：描述「${desc.slice(0, 40)}」已给出时间，但 value/unit 缺失，` +
    `已按描述确定性补全为 value=${patched.value?.raw ?? '(保留)'} / unit=${patched.unit?.raw ?? '(保留)'}`,
    'FOLLOWUP_DERIVED_FROM_DESCRIPTION',
    { path: `${base}.followUp` },
  ));
  return patched;
}

export interface OutcomePayload {
  outcomes: OutcomeLevel[];
}

export interface OutcomeSkillOptions {
  maxTotalChars?: number;
  /** 是否把表格纳入材料（默认 true —— 数值主要在表里） */
  includeTables?: boolean;
  /**
   * 比较组数量（由 comparison SKILL 的结果得出，运行器传入）。
   *
   * 金标准 Sheet3 是「**(比较组 × 结局指标) 一行**」：
   * 实测 2015-04（2 个比较组 × 3 个结局）有 6 行、2015-05（2×1）有 2 行，
   * 同一结局在不同比较组下各占一行、数值相同（编号 EN007-111 / EN007-211 也印证了这一点）。
   * 因此本 SKILL 先按「结局指标」抽一次，再按比较组扇出成多行。
   */
  comparisonCount?: number;
  /** 组别结构编码（ARMNU）：1=双臂 2=多臂；缺省时按比较组数量推导 */
  armStructure?: ArmStructureCode;
  /**
   * 上游 outcome-plan SKILL 判定的结局清单（可选）。
   *
   * 传进来时**不再自己枚举**：枚举交给 outcome-plan（它带"声明句锚定"校验，
   * 能把只在结果表里出现的量表分项挡掉）。这里只负责逐条取值。
   *
   * ⚠️ 传的是 outcome-plan 已落地好的 FieldValue（带证据），**不要**再拿 anchor 去重新定位：
   * 实测 anchor 是整句声明（含上标、破折号、换行），重新定位会失败，
   * identity 于是为空 → 取值调用被跳过 → 整个结局层的数值全丢（实测准确率从 27.5% 掉到 21.8%）。
   */
  plannedOutcomes?: readonly { name?: FieldValue; instrument?: FieldValue }[];
}

/** ARMNU：研究组别结构（金标准 code 表）。 */
export type ArmStructureCode = '1' | '2' | '3' | '4';

/** 由比较组数量推导组别结构编码。 */
export function armStructureOf(comparisonCount: number): ArmStructureCode {
  return comparisonCount <= 1 ? '1' : '2';
}

export function createOutcomeSkill(opts: OutcomeSkillOptions = {}): Skill<OutcomePayload> {
  const includeTables = opts.includeTables ?? true;
  const comparisonCount = Math.max(1, Math.floor(opts.comparisonCount ?? 1));
  const armStructure = opts.armStructure ?? armStructureOf(comparisonCount);

  const skill: Skill<OutcomePayload> = {
    id: 'outcome',
    version: '0.1.0',
    level: 'outcome',
    description: '逐「结局 × 时点」抽取效应量与例数，含变异值类型的优先级选择',
    needs: ['results', 'abstract'],
    needsTables: includeTables,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<OutcomePayload>> {
      const issues: Issue[] = [];

      const materials = collectMaterials(ctx.doc, {
        /*
         * ⚠️ 必须带 methods。
         *
         * 实测：`measurementRange` / `measurementDirection` / `measurementUnit` 这三个
         * **量表元信息**几乎只写在方法学的量表描述里（`measured on a visual analogue scale
         * (PainVAS 0–100 mm)`），而结果章节与表格里只有数值。
         * 之前只取「results + abstract」，导致 15 组 measurement_range 全部答 NR（0%）——
         * 提示词写多少遍都没用，因为材料里根本没有那句话。
         */
        sections: ['results', 'abstract', 'methods'],
        pages: [1],                      // 摘要常给出主要结局
        tables: includeTables,
        figures: false,
        maxCharsPerBlock: 6000,
        ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
      });

      /*
       * 枚举阶段只看**论文自己声明的结局**：摘要 + 方法学章节，**不含表格、不含结果章节**。
       *
       * 实测两次：
       *   · 给全部结果材料 → 模型去数表格里的每一行，把 FIQ 的 fatigue/night rest 等量表分项、
       *     基线变量、亚组分析都当成独立结局（2015-01 报 7 条 / 金标准 4 条，2015-02 报 8 / 3 条）。
       *   · 只给摘要 → 又太少（2015-01 只报 1 条），因为「次要结局」声明写在方法学里
       *     （`The primary outcome was … Secondary outcomes included …`）。
       * 因此取摘要 + 方法学（不含表格）——这正是金标准标注时的依据。
       */
      const listMaterials = collectMaterials(ctx.doc, {
        sections: ['abstract', 'metadata', 'methods'],
        pages: [1],
        tables: false,
        figures: false,
        maxCharsPerBlock: 3000,
        maxTotalChars: 30_000,
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('结果章节与表格均无可用材料', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'outcome', payload: { outcomes: [] }, unresolved: [], issues };
      }

      const tableCount = materials.blocks.filter((b) => b.type === 'table').length;
      if (includeTables && tableCount === 0) {
        issues.push(warn('材料中没有表格，结局数值可能只能来自正文，抽取质量会下降', 'NO_TABLES_IN_MATERIAL'));
      }

      /*
       * 两步调用的用户消息都长这样：材料在前，任务在后。
       * 这样同一篇论文的多次调用共享「系统提示 + 材料」前缀 → 命中上下文缓存。
       */
      const userMessage = (task: string, mat: { text: string } = materials, tableCount = materials.blocks.filter((b) => b.type === 'table').length): string =>
        `以下是论文的相关材料（含 ${tableCount} 个表格，已转为 Markdown）。\n` +
        `数值请优先取自表格。材料结束后是本次任务的说明。\n\n` +
        `${mat.text}\n\n---\n${task}`;

      /* ---------------- 步骤 1：结局清单（优先用上游 plan，否则自己枚举） ---------------- */

      const plannedList = opts.plannedOutcomes ?? [];

      let rawArr: unknown[];
      /** 用计划时，identity 直接取计划里已落地的 FieldValue（跳过重新定位） */
      const plannedIdentity = new Map<number, { name?: FieldValue; instrument?: FieldValue }>();
      if (plannedList.length) {
        rawArr = plannedList.map((p, i) => {
          plannedIdentity.set(i, {
            ...(p.name ? { name: p.name } : {}),
            ...(p.instrument ? { instrument: p.instrument } : {}),
          });
          return {};   // 占位：identity 由 plannedIdentity 提供，见下方循环
        });
      } else {
        const listRes = await ctx.llm.invoke({
          system: PROMPTS.outcome,
          user: userMessage(OUTCOME_TASKS.list, listMaterials, 0),
          temperature: 0,
          tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:list`,
        });
        rawArr = ((listRes.json as { outcomes?: unknown } | undefined)?.outcomes as unknown[]) ?? [];

        // 摘要没声明结局时，退回完整材料再枚举一次（少见的兜底，避免整层空掉）
        if (!Array.isArray(rawArr) || rawArr.length === 0) {
          issues.push(warn('摘要未给出结局，回退到完整材料重新枚举', 'OUTCOME_LIST_FALLBACK'));
          const full = await ctx.llm.invoke({
            system: PROMPTS.outcome,
            user: userMessage(OUTCOME_TASKS.list),
            temperature: 0,
            tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:list-full`,
          });
          rawArr = ((full.json as { outcomes?: unknown } | undefined)?.outcomes as unknown[]) ?? [];
        }
        if (rawArr.length > 8) {
          issues.push(warn(`模型枚举出 ${rawArr.length} 个结局，明显多于常见范围（2~6），请复核`, 'TOO_MANY_OUTCOMES'));
        }
      }

      if (!Array.isArray(rawArr) || rawArr.length === 0) {
        issues.push(warn('没有可用的结局清单（outcomes 为空或缺失）', 'NO_OUTCOMES'));
        return { skillId: skill.id, level: 'outcome', payload: { outcomes: [] }, unresolved: [], issues };
      }

      const outcomes: OutcomeLevel[] = [];
      const allUnresolved: SkillOutput<OutcomePayload>['unresolved'] = [];
      const groundOpts: GroundOptions = {
        kinds: includeTables ? ['text', 'title', 'table'] : ['text', 'title'],
      };
      /** 先按「结局指标」抽一次，最后再按比较组扇出（见 OutcomeSkillOptions.comparisonCount） */
      const measures: { rec: OutcomeLevel; name: string }[] = [];

      /* -------- 逐个结局：步骤 2 取回该结局的完整字段，合并成一条 OutcomeLevel -------- */

      for (const [i, item] of rawArr.entries()) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        const itemObj = item as Record<string, unknown>;
        const base = `outcomes.${i}`;

        /*
         * 步骤 1 给的名称与工具要落地成 identity。
         * 用计划时直接取它已落地的 FieldValue（证据来自 outcome-plan 的声明句定位，已验证过）；
         * 自己枚举时才需要就地把模型的 claim 定位一遍。
         */
        let idRec: { outcome?: { name?: FieldValue; instrument?: FieldValue } };
        const fromPlan = plannedIdentity.get(i);
        if (fromPlan) {
          idRec = { outcome: { ...fromPlan } };
        } else {
          const idGrounded = groundNested<Record<string, unknown>>(
            ctx.doc, itemObj, buildOutcomeIdentityPathMap(i), groundOpts, base,
          );
          allUnresolved.push(...idGrounded.unresolved);
          for (const g of idGrounded.issues) issues.push(warn(g.reason, 'GROUNDING_FAILED', { path: `${base}.${g.field}` }));
          idRec = idGrounded.payload as { outcome?: { name?: FieldValue; instrument?: FieldValue } };
        }
        const identity = {
          name: (idRec.outcome?.name?.raw ?? '').trim(),
          instrument: (idRec.outcome?.instrument?.raw ?? '').trim(),
        };
        if (!identity.name && !identity.instrument) {
          issues.push(warn(`${base}: 结局既无名称也无测量工具，跳过取值`, 'OUTCOME_UNIDENTIFIED', { path: base }));
        }

        // 步骤 2：该结局的完整字段
        const rec: OutcomeLevel = { studyId: ctx.doc.articleId };
        if (idRec.outcome) rec.outcome = { ...idRec.outcome };
        if (identity.name || identity.instrument) {
          const task = OUTCOME_TASKS.item
            .replace('{{OUTCOME_NAME}}', identity.name || '（未命名）')
            .replace('{{INSTRUMENT}}', identity.instrument || '（未报告）');
          try {
            const valRes = await ctx.llm.invoke({
              system: PROMPTS.outcome,
              user: userMessage(task),
              temperature: 0,
              tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:item${i + 1}`,
            });
            const valJson = (valRes.json ?? {}) as Record<string, unknown>;
            const present = (Object.keys(TIMEPOINTS) as TimepointJsonKey[]).filter(
              (k) => valJson[k] !== null && typeof valJson[k] === 'object' && !Array.isArray(valJson[k]),
            );
            const valuesGrounded = groundNested<Record<string, unknown>>(
              ctx.doc, valJson, buildOutcomeValuesPathMap(i, present), groundOpts, base,
            );
            allUnresolved.push(...valuesGrounded.unresolved);
            for (const g of valuesGrounded.issues) issues.push(warn(g.reason, 'GROUNDING_FAILED', { path: `${base}.${g.field}` }));

            // 合并：元信息 + 随访 + 时点
            const v = valuesGrounded.payload as Record<string, unknown>;
            const vo = v.outcome as Record<string, FieldValue> | undefined;
            if (vo) rec.outcome = { ...(rec.outcome ?? {}), ...vo };
            const fu = v.followUp as OutcomeLevel['followUp'] | undefined;
            const tps = v.timepoints as OutcomeLevel['timepoints'] | undefined;
            if (fu) rec.followUp = normalizeFollowUp(fu, base, issues);
            if (tps) rec.timepoints = tps;
            if (!tps) {
              issues.push(warn(`${base}: 未取得任何时点数值`, 'NO_TIMEPOINT_DATA', { path: base }));
            }
            const arm = v.armNumber as FieldValue | undefined;
            if (arm) rec.armNumber = arm;
          } catch (e) {
            // 单个结局失败不应丢掉其他结局（截断/解析错误都会走到这里）
            issues.push(warn(
              `${base}（${identity.name || identity.instrument}）取值失败：${(e as Error).message}`,
              'OUTCOME_ITEM_FAILED',
              { path: base },
            ));
          }
        }

        // 编码推导：随访时间单位
        for (const key of FOLLOWUP_CODE_TARGETS) {          const fv = (rec.followUp as unknown as Record<string, FieldValue | undefined> | undefined)?.[
            key === 'followUpUnit' ? 'unit' : key
          ];
          if (!fv || typeof fv !== 'object' || !('raw' in fv)) continue;
          const d = decode(key, fv.raw);
          if (d.code) {
            (rec.followUp as unknown as Record<string, FieldValue>)[key === 'followUpUnit' ? 'unit' : key] = {
              raw: fv.raw, code: d.code,
              ...(d.meaning ? { legend: d.meaning } : {}),
              evidence: fv.evidence, provenance: 'deterministic', confidence: 1,
            } satisfies FieldValue;
          }
        }

        // 编码推导：结局元字段（模型可能给了中文含义或原文，编码由本地图例确定）
        for (const key of OUTCOME_CODE_TARGETS) {          const fv = key === 'armNumber'
            ? (rec.armNumber as FieldValue | undefined)
            : (rec.outcome as unknown as Record<string, FieldValue | undefined> | undefined)?.[key];
          if (!fv || typeof fv !== 'object' || !('raw' in fv)) continue;
          const d = decode(key, fv.raw);
          if (d.code) {
            const replaced: FieldValue = {
              raw: fv.raw, code: d.code,
              ...(d.meaning ? { legend: d.meaning } : {}),
              evidence: fv.evidence, provenance: 'deterministic', confidence: 1,
            };
            if (key === 'armNumber') rec.armNumber = replaced;
            else if (rec.outcome) (rec.outcome as unknown as Record<string, FieldValue>)[key] = replaced;
          } else {
            issues.push(warn(
              `${base}.${key} 无法确定性编码：${d.note ?? '未知原因'}`,
              'CODE_DECODE_FAILED',
              { path: `${base}.${key}`, ...(fv.evidence.length ? { evidence: fv.evidence } : {}) },
            ));
          }
        }

        /*
         * 时点块的编码推导与校验（共用实现，见 timepoints.ts）。
         *
         * 本 SKILL 的提示词已不要求输出时点数值（那是 outcome-values 的职责），
         * 所以这里是"有则处理"：单独运行本 SKILL、或模型多给了时点块时，照常落地并校验。
         */
        decodeTimepointCodes(rec.timepoints as TimepointBlocks | undefined, base, issues);

        measures.push({ rec, name: identity.name || identity.instrument });
      }

      /*
       * 扇出：金标准 Sheet3 是「(比较组 × 结局指标) 一行」。
       * 同一结局在各比较组下数值相同，但各占一行——这样按比较组汇总分析时不用再拆。
       * 行内 studyId 带比较组序号（2015-04-01 / 2015-04-02），与 core 契约的约定一致。
       */
      const perMeasure = measures.map((m) => m.rec);
      for (let c = 0; c < comparisonCount; c++) {
        for (const rec of perMeasure) {
          const row: OutcomeLevel = {
            ...rec,
            studyId: comparisonCount > 1 ? `${ctx.doc.articleId}-${String(c + 1).padStart(2, '0')}` : ctx.doc.articleId,
            // ARMNU 由比较组数量确定性推导（不占模型的注意力）
            armNumber: {
              raw: armStructure,
              code: armStructure,
              legend: ARM_STRUCTURE_LEGEND[armStructure],
              evidence: [{ kind: 'external', page: 1, bbox: null, quote: `比较组数量=${comparisonCount}` }],
              provenance: 'deterministic',
              confidence: 1,
            },
          };
          outcomes.push(row);
        }
      }

      return { skillId: skill.id, level: 'outcome', payload: { outcomes }, unresolved: allUnresolved, issues };
    },

    validate(output: SkillOutput<OutcomePayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const list = output.payload.outcomes;
      if (list.length === 0) {
        issues.push(warn('未产出任何结局', 'EMPTY_OUTCOMES'));
        return issues;
      }

      list.forEach((o, i) => {
        const p = `outcomes[${i}]`;

        if (!o.outcome?.name?.raw) {
          issues.push(warn('结局缺少名称', 'MISSING_OUTCOME_NAME', { path: `${p}.outcome.name` }));
        }

        /*
         * 时点数值的完整性/合理性校验归 `outcome-values` SKILL（它才是那部分的产出方）。
         * 这里只在"确实拿到了时点块"时顺带校验一次（单独运行本 SKILL 的场景），
         * 不因为时点为空而报警——否则每次全量运行都会为每个结局多报一条噪声。
         */
        if (o.timepoints && Object.keys(o.timepoints).length > 0) {
          validateTimepoints(o.timepoints as TimepointBlocks, p, issues);
          // 结束疗程时缺失但随访有值 → 提示复核（可能是把 6 个月误当疗程结束）
          const hasEnd = Boolean(o.timepoints.endOfTreatment);
          const hasFollow = Boolean(o.timepoints.followUpEnd);
          if (!hasEnd && hasFollow) {
            issues.push(warn(`${p}: 有随访结束数据但无疗程结束数据，请确认时点是否归错`, 'MISSING_END_OF_TREATMENT', { path: p }));
          }
        }
      });

      return issues;
    },
  };

  return skill;
}
