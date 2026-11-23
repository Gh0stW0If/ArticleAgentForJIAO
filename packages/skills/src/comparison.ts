/**
 * @aa/skills — SKILL: 比较组级（comparison）
 *
 * 对应金标准 Sheet1 的「试验组/对照组配对」字段：设计方法学 + 针刺方案细节。
 *
 * 与其他层级的差异：**一篇论文可能有多个比较组**（多臂/多对照组），
 * 因此输出是 `{ comparisons: [...] }`，每个元素一套完整字段。
 * 落地时把数组下标编入路径（`comparisons.0.randomizationClass`），复用同一套证据校验。
 */

import {
  type ComparisonLevel,
  type Issue,
  type MiniDoc,
  type Skill,
  type SkillContext,
  type SkillOutput,
  type FieldValue,
  warn,
} from '@aa/core';
import { PROMPTS, COMPARISON_TASK } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundNested, type GroundOptions } from './grounding.ts';
import { decode } from './legend.ts';

/* ------------------------------ 字段映射 ------------------------------ */

/**
 * JSON 键 → 规范字段名。与 prompts.generated.ts 里 comparison 的 JSON 模板一致。
 * 有防回归测试保证两者同步（见 prompts.test.ts）。
 */
export const COMPARISON_FIELD_MAP: Readonly<Record<string, string>> = {
  intervention: 'intervention',
  control: 'control',
  controlType: 'controlType',
  controlTypeConverted: 'controlTypeConverted',
  comparisonType: 'comparisonType',
  randomizationMethod: 'randomizationMethod',
  randomizationClass: 'randomizationClass',
  allocationConcealment: 'allocationConcealment',
  allocationClass: 'allocationClass',
  stratificationBlocking: 'stratificationBlocking',
  blindingParticipants: 'blindingParticipants',
  blindingOutcomeAssessor: 'blindingOutcomeAssessor',
  patientExpectation: 'patientExpectation',
  practitionerCommunication: 'practitionerCommunication',
  practitionerYears: 'practitionerYears',
  practitionerEducation: 'practitionerEducation',
  practitionerSpecialty: 'practitionerSpecialty',
  acupunctureType: 'acupunctureType',
  stimulationType: 'stimulationType',
  pointSelection: 'pointSelection',
  pointLocationClass: 'pointLocationClass',
  protocolSource: 'protocolSource',
  frequencyDesc: 'frequencyDesc',
  frequencyValue: 'frequencyValue',
  frequencyUnit: 'frequencyUnit',
  frequencyClass: 'frequencyClass',
  courseDesc: 'courseDesc',
  courseValue: 'courseValue',
  courseUnit: 'courseUnit',
  totalSessions: 'totalSessions',
  deqi: 'deqi',
  insertionDepthText: 'insertionDepthText',
  insertionDepthClass: 'insertionDepthClass',
  stimulationIntensity: 'stimulationIntensity',
  needleRetentionDesc: 'needleRetentionDesc',
  needleRetentionValue: 'needleRetentionValue',
  needleRetentionUnit: 'needleRetentionUnit',
  needleCountText: 'needleCountText',
  needleCountMin: 'needleCountMin',
  postInsertionManipulation: 'postInsertionManipulation',
  needleAngleClass: 'needleAngleClass',
  needleDirectionClass: 'needleDirectionClass',
  maxFollowupDesc: 'maxFollowupDesc',
  maxFollowupValue: 'maxFollowupValue',
  maxFollowupUnit: 'maxFollowupUnit',
  sexExperimental: 'sexExperimental',
  sexControl: 'sexControl',
  sexDistribution: 'sexDistribution',
  typeOfData: 'typeOfData',
  priorAcupuncture: 'priorAcupuncture',
  randomizedN: 'randomizedN',
  randomizedNExperimental: 'randomizedNExperimental',
  randomizedNControl: 'randomizedNControl',
  analyzedN: 'analyzedN',
  analyzedNExperimental: 'analyzedNExperimental',
  analyzedNControl: 'analyzedNControl',
  dropoutTotal: 'dropoutTotal',
  missingDataRatio: 'missingDataRatio',
  missingDataReported: 'missingDataReported',
  primaryAnalysis: 'primaryAnalysis',
  missingDataHandling: 'missingDataHandling',

  /*
   * 分组字段（试验组 / 对照组各一列）。
   * 键名沿用金标准列名，但语义以金标准批注为准——见 canonical-field-map.mjs 里的说明。
   * 曾经漏登记这 9 个键，导致模型返回了也被静默丢弃（评测表上表现为"该字段恒为 0%"）。
   */
  priorAcupunctureExperimental: 'priorAcupunctureExperimental',
  priorAcupunctureControl: 'priorAcupunctureControl',
  baselineCatExperimentalNeg: 'baselineCatExperimentalNeg',
  baselineCatExperimentalPos: 'baselineCatExperimentalPos',
  baselineCatControlNeg: 'baselineCatControlNeg',
  baselineCatControlPos: 'baselineCatControlPos',
  needleRetentionClass: 'needleRetentionClass',
  totalSessionsClassA: 'totalSessionsClassA',
  totalSessionsClassB: 'totalSessionsClassB',
};

/** 需要确定性编码的字段（模型给原文，编码由本地图例推导）。 */
const CODE_TARGETS: readonly (keyof ComparisonLevel)[] = [
  'controlType', 'controlTypeConverted', 'comparisonType',
  'randomizationClass', 'allocationClass', 'stratificationBlocking',
  'blindingParticipants', 'blindingOutcomeAssessor', 'practitionerCommunication',
  'practitionerEducation', 'practitionerSpecialty', 'acupunctureType', 'stimulationType',
  'pointSelection', 'pointLocationClass', 'protocolSource',
  'frequencyUnit', 'frequencyClass', 'courseUnit', 'deqi',
  'insertionDepthClass', 'stimulationIntensity', 'needleRetentionUnit',
  'postInsertionManipulation', 'needleAngleClass', 'needleDirectionClass',
  'maxFollowupUnit', 'typeOfData', 'priorAcupuncture',
  'missingDataReported', 'primaryAnalysis', 'missingDataHandling',
  // 分组字段里的编码列（用来补齐图例文本）
  'needleRetentionClass', 'totalSessionsClassA',
];

/** 这些字段在「不适用」时应填 NA 而不是 NR（金标准明确要求）。 */
const NA_WHEN_NOT_APPLICABLE = new Set([
  'insertionDepthText', 'insertionDepthClass', 'needleRetentionDesc',
  'needleRetentionValue', 'needleRetentionClass', 'needleCountText',
  'postInsertionManipulation', 'needleAngleClass', 'needleDirectionClass',
]);

export interface ComparisonPayload {
  comparisons: ComparisonLevel[];
}

/**
 * 比较组排序：**假针/安慰剂对照在前，常规治疗/其他对照在后**（按 `controlType` 编码升序）。
 *
 * 实测依据（2015 三篇三臂试验，金标准的排列完全一致）：
 * ```
 *   2015-06  #1 EA vs 假电针(control_type=5)   →  #2 EA vs CIC 治疗(6)
 *   2015-05  #1 耳针 vs 安慰针(5)              →  #2 耳针 vs 常规治疗(6)
 *   2015-04  #1 体针 vs 常规治疗(6)            →  #2 萨阿针 vs 常规治疗(6)  ← 同类型保持原文顺序
 * ```
 * 排序不是"美观"问题：它决定 `studyId` 的编号（`2015-06-01` / `-02`），
 * 而下游 outcome-values 正是按编号回查"本次要取哪一对的数值"——顺序一变就整篇错位。
 * 稳定排序（同编码保持原文顺序），未知编码排在最后。
 */
export function sortComparisons(list: ComparisonLevel[]): ComparisonLevel[] {
  const orderOf = (c: ComparisonLevel): number => {
    const code = Number(String(c.controlType?.code ?? c.controlType?.raw ?? '').match(/\d+/)?.[0]);
    return Number.isFinite(code) ? code : 99;
  };
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => orderOf(a.c) - orderOf(b.c) || a.i - b.i)
    .map((x) => x.c);
}

export interface ComparisonSkillOptions {
  /** 材料最多取多少字符 */
  maxTotalChars?: number;
  /** 是否把表格纳入材料（默认 true —— 例数/性别/基线值主要在基线特征表里） */
  includeTables?: boolean;
  /**
   * 上游 study-plan SKILL 判定出的比较组（可选）。
   *
   * 传进来有两个好处：
   *   1. 提示词直接把"共有几个比较组、分别是哪两个组"讲清楚，减少模型数错组数；
   *   2. 抽出来的组数与之不符时能报 issue（数量错位是下游全部字段错位的前兆）。
   */
  plannedComparisons?: readonly { intervention: string; control: string }[];
}

export function createComparisonSkill(opts: ComparisonSkillOptions = {}): Skill<ComparisonPayload> {
  const planned = opts.plannedComparisons ?? [];
  const skill: Skill<ComparisonPayload> = {
    id: 'comparison',
    version: '0.1.0',
    level: 'comparison',
    description: '逐比较组抽取设计与针刺方案细节，并把受控编码由本地图例确定性推导',
    needs: ['methods', 'results'],
    needsTables: true,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<ComparisonPayload>> {
      const issues: Issue[] = [];

      /*
       * ⚠️ 必须带上表格。
       *
       * 各组的例数、性别分布、基线均值、既往针刺史等往往**只出现在基线特征表**里
       * （如 "Table 1 Descriptive analysis of baseline clinical and sociodemographic variables"）。
       * 实测不带表格时 sex_experimental / randomized_n_* / baseline_cat_* 一律抽成 NR。
       */
      const includeTables = opts.includeTables ?? true;
      const materials = collectMaterials(ctx.doc, {
        sections: ['methods', 'results', 'abstract'],
        tables: includeTables,
        figures: false,
        ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('方法学章节无可用材料', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'comparison', payload: { comparisons: [] }, unresolved: [], issues };
      }

      const comparisons: ComparisonLevel[] = [];
      const allUnresolved: SkillOutput<ComparisonPayload>['unresolved'] = [];
      const tableCount = materials.blocks.filter((b) => b.type === 'table').length;

      /** 材料在前、任务在后：多次调用共享前缀，命中上下文缓存。 */
      const askOne = async (i: number): Promise<Record<string, unknown> | null> => {
        const pc = planned[i]!;
        const task = COMPARISON_TASK
          .replace('{{INDEX}}', String(i + 1))
          .replace('{{INTERVENTION}}', pc.intervention || '（见材料）')
          .replace('{{CONTROL}}', pc.control || '（见材料）');
        const res = await ctx.llm.invoke({
          system: PROMPTS.comparison,
          user:
            `以下是论文的方法学与结果材料（含 ${tableCount} 个表格，已转为 Markdown）。\n` +
            `材料结束后是本次任务的说明。\n\n${materials.text}\n\n---\n${task}`,
          temperature: 0,
          tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:cmp${i + 1}`,
        });
        const json = res.json as Record<string, unknown> | undefined;
        if (!json) return null;
        // 兼容两种回传形状：任务说明要求的 { comparison: {...} } 与系统提示模板的 { comparisons: [ {...} ] }
        if (json.comparison && typeof json.comparison === 'object') return json.comparison as Record<string, unknown>;
        const arr = json.comparisons;
        if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') return arr[0] as Record<string, unknown>;
        return null;
      };

      /**
       * 逐个比较组抽取（上游给了计划时）。
       *
       * 为什么拆开：70 个字段 × N 个比较组会撞上输出上限——
       * 实测 2015-05（3 个比较组）直接 `finish_reason=length` 截断，整个比较组层全丢。
       * 逐个抽每个响应只有 ~2500 tok，安全得多，而且模型每次只盯一组，串列概率下降。
       */
      if (planned.length) {
        for (let i = 0; i < planned.length; i++) {
          const prefix = `comparisons.${i}`;
          const pathMap: Record<string, string> = {};
          for (const [k, v] of Object.entries(COMPARISON_FIELD_MAP)) pathMap[`comparison.${k}`] = v;

          let item: Record<string, unknown> | null = null;
          try {
            item = await askOne(i);
          } catch (e) {
            issues.push(warn(
              `comparisons[${i}] 抽取失败：${(e as Error).message}`,
              'COMPARISON_ITEM_FAILED',
              { path: prefix },
            ));
            continue;
          }
          if (!item) {
            issues.push(warn(`comparisons[${i}] 未返回可用 JSON`, 'COMPARISON_ITEM_EMPTY', { path: prefix }));
            continue;
          }

          const grounded = groundNested<Record<string, FieldValue>>(
            ctx.doc, item, pathMap, { kinds: ['text', 'title', 'table'] } satisfies GroundOptions, 'comparison',
          );
          allUnresolved.push(...grounded.unresolved);
          for (const g of grounded.issues) issues.push(warn(g.reason, 'GROUNDING_FAILED', { path: `${prefix}.${g.field}` }));

          const cmp = { studyId: ctx.doc.articleId, ...grounded.payload } as ComparisonLevel;
          const cmpRec = cmp as unknown as Record<string, FieldValue | undefined>;


          for (const target of CODE_TARGETS) {
            const src = cmpRec[target];
            if (!src || typeof src !== 'object' || !('raw' in src)) continue;
            const d = decode(String(target), src.raw);
            if (d.code) {
              cmpRec[target] = {
                raw: src.raw,
                code: d.code,
                ...(d.meaning ? { legend: d.meaning } : {}),
                evidence: src.evidence,
                provenance: 'deterministic',
                confidence: 1,
              } satisfies FieldValue;
            } else {
              issues.push(warn(
                `comparisons[${i}].${String(target)} 无法确定性编码：${d.note ?? '未知原因'}`,
                'CODE_DECODE_FAILED',
                { path: `${prefix}.${String(target)}`, ...(src.evidence.length ? { evidence: src.evidence } : {}) },
              ));
            }
          }

          for (const key of NA_WHEN_NOT_APPLICABLE) {
            const fv = cmpRec[key];
            if (fv?.raw === 'NR' && cmpRec.stimulationType?.code && ['3', '4', '5'].includes(cmpRec.stimulationType.code)) {
              issues.push(warn(
                `comparisons[${i}].${key} 填了 NR，但刺激类型为电针/激光针/穴位按压，按金标准应填 NA`,
                'SHOULD_BE_NA',
                { path: `${prefix}.${key}`, ...(fv.evidence.length ? { evidence: fv.evidence } : {}) },
              ));
            }
          }

          comparisons.push(cmp);
        }

        return { skillId: skill.id, level: 'comparison', payload: { comparisons: sortComparisons(comparisons) }, unresolved: allUnresolved, issues };
      }

      /* ---------------- 没有上游计划时的兜底：单次调用逐组输出 ---------------- */

      const res = await ctx.llm.invoke({
        system: PROMPTS.comparison,
        user: `以下是论文的方法学与结果材料（含表格，已转为 Markdown）。请按规则**逐比较组**抽取。\n\n${materials.text}`,
        temperature: 0,
        tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
      });

      if (!res.json) {
        issues.push(warn('模型未返回结构化 JSON', 'NO_STRUCTURED_OUTPUT'));
        return { skillId: skill.id, level: 'comparison', payload: { comparisons: [] }, unresolved: [], issues };
      }

      // 展开数组下标 → 路径映射，使嵌套数组也能复用同一套证据校验
      const rawArr = (res.json as { comparisons?: unknown }).comparisons;
      if (!Array.isArray(rawArr) || rawArr.length === 0) {
        issues.push(warn('模型未输出任何比较组（comparisons 为空或缺失）', 'NO_COMPARISONS'));
        return { skillId: skill.id, level: 'comparison', payload: { comparisons: [] }, unresolved: [], issues };
      }

      rawArr.forEach((item, i) => {
        if (item === null || typeof item !== 'object') return;

        // ⚠️ 映射表的键必须与 walk 生成的「含下标的完整路径」一致。
        // 曾写成裸键（`intervention`），而 walk 生成的是 `comparisons.0.intervention`，
        // 于是所有字段都查不到、且被静默忽略（payload 只剩 studyId，无任何报错）。
        const prefix = `comparisons.${i}`;
        const pathMap: Record<string, string> = {};
        for (const k of Object.keys(COMPARISON_FIELD_MAP)) pathMap[`${prefix}.${k}`] = k;

        // rawPrefix 把行内路径补全为映射表键（comparisons.<i>）
        const grounded = groundNested<Record<string, FieldValue>>(
          ctx.doc,
          item,
          pathMap,
          { kinds: ['text', 'title'] } satisfies GroundOptions,
          prefix,
        );
        allUnresolved.push(...grounded.unresolved);
        for (const g of grounded.issues) issues.push(warn(g.reason, 'GROUNDING_FAILED', { path: `comparisons[${i}].${g.field}` }));

        const cmp = { studyId: ctx.doc.articleId, ...grounded.payload } as ComparisonLevel;

        // 确定性编码（用 Record 视图写入，避免 keyof 联合类型带来的赋值窄化问题）
        const cmpRec = cmp as unknown as Record<string, FieldValue | undefined>;
        for (const target of CODE_TARGETS) {
          const src = cmpRec[target];
          if (!src || typeof src !== 'object' || !('raw' in src)) continue;
          const d = decode(String(target), src.raw);
          if (d.code) {
            cmpRec[target] = {
              raw: src.raw,
              code: d.code,
              ...(d.meaning ? { legend: d.meaning } : {}),
              evidence: src.evidence,
              provenance: 'deterministic',
              confidence: 1,
            } satisfies FieldValue;
          } else {
            issues.push(warn(
              `comparisons[${i}].${String(target)} 无法确定性编码：${d.note ?? '未知原因'}`,
              'CODE_DECODE_FAILED',
              { path: `comparisons[${i}].${String(target)}`, ...(src.evidence.length ? { evidence: src.evidence } : {}) },
            ));
          }
        }

        // NA / NR 语义校验：不适用场景填了 NR 应提示
        for (const key of NA_WHEN_NOT_APPLICABLE) {
          const fv = cmpRec[key];
          if (fv?.raw === 'NR' && cmpRec.stimulationType?.code && ['3', '4', '5'].includes(cmpRec.stimulationType.code)) {
            issues.push(warn(
              `comparisons[${i}].${key} 填了 NR，但刺激类型为电针/激光针/穴位按压，按金标准应填 NA`,
              'SHOULD_BE_NA',
              { path: `comparisons[${i}].${key}`, ...(fv.evidence.length ? { evidence: fv.evidence } : {}) },
            ));
          }
        }

        comparisons.push(cmp);
      });

      return { skillId: skill.id, level: 'comparison', payload: { comparisons: sortComparisons(comparisons) }, unresolved: allUnresolved, issues };
    },

    validate(output: SkillOutput<ComparisonPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const list = output.payload.comparisons;

      if (list.length === 0) {
        issues.push(warn('未产出任何比较组', 'EMPTY_COMPARISONS'));
        return issues;
      }

      // 与上游 study-plan 的判定对账：数量不符是"下游全部字段错位"的前兆
      if (planned.length && list.length !== planned.length) {
        issues.push(warn(
          `比较组数量与上游规划不符：规划 ${planned.length} 个，实际产出 ${list.length} 个`,
          'COMPARISON_COUNT_MISMATCH',
          { path: 'comparisons' },
        ));
      }

      list.forEach((c, i) => {
        const p = `comparisons[${i}]`;

        // 干预与对照不应完全相同
        if (c.intervention?.raw && c.control?.raw && c.intervention.raw === c.control.raw) {
          issues.push(warn('试验组与对照组的干预名称相同，请复核', 'SAME_INTERVENTION_AND_CONTROL', { path: `${p}.intervention` }));
        }

        // 编码必须在图例范围内
        for (const key of CODE_TARGETS) {
          const fv = c[key] as FieldValue | undefined;
          if (!fv?.code) continue;
          // 复合编码（如 2/5）逐段校验
          for (const part of fv.code.split('/')) {
            if (decode(String(key), part).method === 'none') {
              issues.push(warn(`${p}.${String(key)} 的编码 ${part} 不在图例内`, 'CODE_OUT_OF_LEGEND', { path: `${p}.${String(key)}` }));
            }
          }
        }

        // 例数自洽：试验组+对照组 = 随机总数
        const a = Number(c.randomizedNExperimental?.raw);
        const b = Number(c.randomizedNControl?.raw);
        const t = Number(c.randomizedN?.raw);
        if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(t) && a + b !== t) {
          issues.push(warn(
            `${p}: 随机例数不自洽，${a} + ${b} ≠ ${t}`,
            'SAMPLE_SIZE_INCONSISTENT',
            { path: `${p}.randomizedN` },
          ));
        }

        // 总次数与 频次×疗程 的粗校验（仅当三者都是纯数字时）
        const perWeek = Number(c.frequencyValue?.raw);
        const weeks = Number(c.courseValue?.raw);
        const total = Number(c.totalSessions?.raw);
        if (
          Number.isFinite(perWeek) && Number.isFinite(weeks) && Number.isFinite(total) &&
          c.frequencyUnit?.code === '2' && c.courseUnit?.code === '2' &&
          perWeek > 0 && weeks > 0 && total > 0 && Math.abs(perWeek * weeks - total) > 1
        ) {
          issues.push(warn(
            `${p}: 治疗总次数与「频次×疗程」不符（${perWeek}×${weeks}≠${total}），请复核`,
            'SESSION_COUNT_INCONSISTENT',
            { path: `${p}.totalSessions` },
          ));
        }
      });

      return issues;
    },
  };

  return skill;
}
