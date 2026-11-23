/**
 * @aa/skills — SKILL: 结局数值层（outcome-values）
 *
 * 只做一件事：**给定结局清单，逐个抽取它的「结局 × 时点」数值块**。
 *
 * ===== 为什么要从 outcome 里拆出来 =====
 *
 * 原先把「结局自身字段」和「各时点数值」塞在同一次调用里，提示词被迫同时讲两件事：
 * 编码字段的图例（construct/subconstruct/measurementType…）、量表范围方向单位、
 * 以及数值列的识别规则（ITT vs per-protocol、变异值是 SD 还是 95%CI、例数在正文里…）。
 * 实测后果：数值规则的篇幅把结局字段的规则挤掉——`measurementRange`、`subconstruct`
 * 这类字段长期低分，而数值列规则又因为太长而没被执行到位。**两件事互相拖累。**
 *
 * 拆分后：
 *   · `outcome`        —— 只输出结局自身字段，提示词短、图例清楚；
 *   · `outcome-values` —— 只输出三个时点块，提示词里全是"数值取哪一列"的规则
 *     （ITT/PP 列表、变异值单值还是双边界、四件套、例数在正文…），每条都短兵相接。
 *
 * ===== 调用编排 =====
 *
 * **每个「结局指标 × 比较组」行一次调用**。
 *
 * ⚠️ 这里曾经按「名称|工具」去重（认为"同一结局的数值是同一份，不必重复问"）——
 * 在**多臂试验**上是错的，而且是静默错：实测 2015-04 是三臂试验（body acupuncture /
 * sa-am acupuncture / usual care），金标准按「比较组 × 结局」各占一行，
 * 比较组 1 取表格的 A 行（BDI 差值 −1.56）、比较组 2 取 B 行（−2.34）。
 * 去重让比较组 2 直接**复制了比较组 1 的值**，两行数字一模一样。
 * 因此现在**逐行调用**，并把该行的「干预 vs 对照」写进提示词——模型才能在多臂表里
 * 找到对应那一行（表格只写 A/B/C，必须回方法学查图例）。
 *
 * 材料与 outcome 相同（结果章节 + 摘要 + 方法学 + 表格），因此同一篇论文的多次调用
 * 共享「系统提示 + 材料」前缀，能吃服务端上下文缓存。
 */

import {
  type FieldValue,
  type OutcomeContinuous,
  type OutcomeTimepoint,
  type Issue,
  type Skill,
  type SkillContext,
  type SkillOutput,
  warn,
} from '@aa/core';
import { PROMPTS, OUTCOME_TASKS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundNested, numericTokens, type GroundOptions } from './grounding.ts';
import {
  TIMEPOINTS,
  type TimepointJsonKey,
  type TimepointBlocks,
  addTimepointPaths,
  decodeTimepointCodes,
  intervalProblem,
  reportedNumber,
  validateTimepoints,
  VARIANCE_PREFERENCE,
  type DifferenceFields,
  type PreferredResult,
} from './timepoints.ts';

/** 待取值的结局行（来自上一层的 outcomes，已带名称/工具）。 */
export interface OutcomeValueTarget {
  /** 在上一层 `outcomes` 数组里的下标——回填时按它定位。 */
  rowIndex: number;
  name: string;
  instrument: string;
  /** 量表单位（可选）：写进提示词，帮助模型认列（如 `mm`、`分`）。 */
  unit?: string;
  /**
   * 本行所属的**比较组**（多臂试验的关键）。
   *
   * 表格常按臂分行（A/B/C）并在"差值"列给「该臂 vs 对照」，
   * 因此必须告诉模型"本次要的是哪一对"，否则它只能任选一行。
   */
  comparison?: { intervention: string; control: string };
}

/** 一个结局的数值结果。 */
export interface OutcomeValueRecord {
  rowIndex: number;
  timepoints?: TimepointBlocks;
  preferredResult?: PreferredResult;
}

export interface OutcomeValuesPayload {
  values: OutcomeValueRecord[];
}

export interface OutcomeValuesSkillOptions {
  targets: readonly OutcomeValueTarget[];
  /** 是否把表格转成 Markdown 网格（数值几乎只在表格里，默认开）。 */
  includeTables?: boolean;
  /** 材料总字符上限。 */
  maxTotalChars?: number;
}

/**
 * 为第 i 个结局生成数值块的路径映射。
 *
 * ⚠️ 键是**含下标的输入路径**（`values.<i>.<时点>.<类型>.<字段>`，与 groundNested 的
 * `rawPrefix` 拼出来的路径一致），值是**相对记录根的输出路径**（`timepoints.<时点>...`）。
 * 输出路径若也带上 `values.<i>` 前缀，落地结果就变成了 `payload.values.baseline…`，
 * 而调用方读的是 `payload.timepoints` —— 字段会静默丢失（实测踩到过：测试里读出来是 undefined）。
 */
export function buildOutcomeValuePathMap(idx: number, keys: readonly TimepointJsonKey[]): Record<string, string> {
  const map: Record<string, string> = {};
  addTimepointPaths(map, `values.${idx}`, keys);
  return map;
}

function hasBothEstimates(continuous?: OutcomeContinuous): boolean {
  return reportedNumber(continuous?.experimental?.estimate) !== undefined
    && reportedNumber(continuous?.control?.estimate) !== undefined;
}

function selectionRank(value: OutcomeContinuous | undefined, at: TimepointJsonKey): number {
  if (!value) return -1;
  const type = value.estimateType?.code;
  const variance = value.varianceType?.code;
  const isChange = type === '3';
  const complete = [value.experimental, value.control].every(group => {
    const lower = reportedNumber(group?.ciLower);
    if (lower === undefined) return false;
    if (variance === '2') {
      return reportedNumber(group?.ciUpper) !== undefined
        && !intervalProblem(group?.estimate, group?.ciLower, group?.ciUpper, true);
    }
    if (variance === '3' || variance === '1') return lower >= 0 && reportedNumber(group?.ciUpper) === undefined;
    return true;
  });
  const format = variance ? VARIANCE_PREFERENCE[variance] ?? 9 : 9;
  return (hasBothEstimates(value) ? 100 : 0)
    + (at === 'endOfTreatment' && !isChange ? 30 : 0)
    + (complete ? 10 - format : 0);
}

function preferredOutcome(tps: TimepointBlocks): PreferredResult | undefined {
  const hasEventOrCategory = Object.values(tps).some(block => block.categorical
    || reportedNumber(block.binary?.experimental?.events) !== undefined
    || reportedNumber(block.binary?.control?.events) !== undefined);
  if (hasEventOrCategory) return undefined;
  const end = tps.endOfTreatment?.continuous;
  if (hasBothEstimates(end) && ['1', '2'].includes(end?.estimateType?.code ?? '')) return 'postTreatment';
  const hasDifference = [tps.endOfTreatment, tps.followUpEnd].some(block => {
    const field = (block?.binary as DifferenceFields | undefined)?.differenceEstimate;
    const n = reportedNumber(field);
    return n !== undefined && Boolean(field?.evidence.some(item => numericTokens(item.quote).includes(n)));
  });
  if (hasDifference) return 'betweenGroupDifference';
  if (hasBothEstimates(tps.baseline?.continuous) && hasBothEstimates(end) && end?.estimateType?.code !== '3') return 'prePost';
  return undefined;
}

export function validateExtractedIntervals(
  timepoints: TimepointBlocks, prefix: string, issues: Issue[], unresolved: SkillOutput<OutcomeValuesPayload>['unresolved'],
  requireCell = true,
): void {
  for (const [timepoint, data] of Object.entries(timepoints)) {
    const block = data as OutcomeTimepoint;
    const check = (scope: string, estimate: FieldValue | undefined, lower: FieldValue | undefined, upper: FieldValue | undefined,
      discard: () => void, varianceKnown = true) => {
      const problem = !varianceKnown && (reportedNumber(lower) !== undefined || reportedNumber(upper) !== undefined)
        ? { code: 'VARIANCE_TYPE_UNVERIFIED', message: '变异值的类型缺少可靠证据，请查原表' }
        : intervalProblem(estimate, lower, upper, requireCell);
      if (!problem) return;
      const path = `${prefix}.timepoints.${timepoint}.${scope}`;
      const evidence = [estimate, lower, upper].flatMap(field => field?.evidence ?? []);
      issues.push(warn(problem.message, problem.code, { path, evidence }));
      unresolved.push({
        reason: problem.message, evidence,
        raw: [estimate?.raw, lower?.raw, upper?.raw].filter(Boolean).join(' | '), confidence: 0,
      });
      discard();
    };
    const varianceType = block.continuous?.varianceType?.code;
    if (varianceType === '1' || varianceType === '3') {
      for (const side of ['experimental', 'control'] as const) {
        const group = block.continuous?.[side];
        if (!group?.ciUpper) continue;
        const path = `${prefix}.timepoints.${timepoint}.continuous.${side}.ciUpper`;
        const upper = group.ciUpper;
        delete group.ciUpper;
        if (reportedNumber(upper) === undefined || reportedNumber(upper) === reportedNumber(group.ciLower)) continue;
        const message = 'SD/SE 仅使用一个变异值，上限已移入待核对';
        issues.push(warn(message, 'SINGLE_VARIANCE_UPPER', { path, evidence: upper.evidence }));
        unresolved.push({ reason: message, evidence: upper.evidence, raw: upper.raw, confidence: 0 });
      }
    }
    if (block.continuous && (varianceType === '2' || !varianceType)) {
      for (const side of ['experimental', 'control'] as const) {
        const group = block.continuous[side];
        if (!group) continue;
        check(`continuous.${side}`, group.estimate, group.ciLower, group.ciUpper, () => {
          delete group.ciLower;
          delete group.ciUpper;
        }, Boolean(varianceType));
      }
    }
    const difference = block.binary as DifferenceFields | undefined;
    if (difference) {
      check('binary.differenceEstimate', difference.differenceEstimate, difference.differenceCiLower, difference.differenceCiUpper, () => {
        delete difference.differenceCiLower;
        delete difference.differenceCiUpper;
      });
    }
  }
}

export function createOutcomeValuesSkill(opts: OutcomeValuesSkillOptions): Skill<OutcomeValuesPayload> {
  const includeTables = opts.includeTables ?? true;
  const targets = opts.targets;

  const skill: Skill<OutcomeValuesPayload> = {
    id: 'outcome-values',
    version: '0.2.0',
    level: 'outcome',
    description: '逐结局抽取「结局 × 时点」的数值块（效应量/变异值/例数），只做数值不做结局元信息',
    needs: ['results', 'abstract'],
    needsTables: includeTables,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<OutcomeValuesPayload>> {
      const issues: Issue[] = [];
      const values: OutcomeValueRecord[] = [];

      // 只保留能定位到结局的行；同一条结局指标只调用一次
      const usable = targets.filter((t) => t.name.trim() || t.instrument.trim());
      for (const t of targets) {
        if (!t.name.trim() && !t.instrument.trim()) {
          issues.push(warn(
            `outcomes.${t.rowIndex}: 结局既无名称也无测量工具，跳过数值抽取`,
            'OUTCOME_UNIDENTIFIED',
            { path: `outcomes.${t.rowIndex}` },
          ));
        }
      }

      if (usable.length === 0) {
        return { skillId: skill.id, level: 'outcome', payload: { values: [] }, unresolved: [], issues };
      }

      const materials = collectMaterials(ctx.doc, {
        // 与 outcome 同一套材料：数值来自结果章节与表格，量表口径可能写在方法学
        sections: ['results', 'abstract', 'methods'],
        pages: [1],
        tables: includeTables,
        figures: false,
        numberTableCells: true,
        maxCharsPerBlock: 6000,
        ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
      });
      if (materials.blocks.length === 0) {
        issues.push(warn('结果章节与表格均无可用材料', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'outcome', payload: { values: [] }, unresolved: [], issues };
      }
      const tableCount = materials.blocks.filter((b) => b.type === 'table').length;
      if (includeTables && tableCount === 0) {
        issues.push(warn('材料中没有表格，结局数值可能只能来自正文，抽取质量会下降', 'NO_TABLES_IN_MATERIAL'));
      }

      const userMessage = (task: string): string =>
        `以下是论文的相关材料（含 ${tableCount} 个表格，已转为 Markdown）。\n` +
        '表格里的每一列都可能是一个不同的统计量（例数 / 效应量 / 变异值 / p 值 / 组间差值），' +
        '取数前先把列头数清楚。\n\n' +
        '--- 材料开始 ---\n' + materials.text + '\n--- 材料结束 ---\n\n' + task;

      const groundOpts: GroundOptions = {
        kinds: includeTables ? ['text', 'title', 'table'] : ['text', 'title'],
        verifyNumericSource: true,
      };
      const allUnresolved: SkillOutput<OutcomeValuesPayload>['unresolved'] = [];

      /*
       * 逐**行**调用（一行 = 一个「结局指标 × 比较组」）。
       *
       * ⚠️ 不要再按「名称|工具」去重：多臂试验里同名结局在不同比较组下取的是**不同的臂行**
       * （2015-04：比较组 1 取 A 行 −1.56、比较组 2 取 B 行 −2.34）。
       * 去重会让后一个比较组静默复制前一个的值。
       */
      for (const [i, t] of usable.entries()) {
        const base = `values.${i}`;
        const comparisonLabel = t.comparison
          ? `${t.comparison.intervention || '（未报告）'} VS ${t.comparison.control || '（未报告）'}`
          : '（未提供比较组标签，请按原文确认）';

        try {
          const task = OUTCOME_TASKS.value
            .replace('{{OUTCOME_NAME}}', t.name || '（未命名）')
            .replace('{{INSTRUMENT}}', t.instrument || '（未报告）')
            .replace('{{UNIT}}', t.unit?.trim() || '（未报告）')
            .replace('{{COMPARISON}}', comparisonLabel);
          const res = await ctx.llm.invoke({
            system: PROMPTS.outcomeValue + '\n多臂试验只使用本行指定试验臂和指定对照臂，禁止跨臂合并分子和分母。按本结局表格单元格里的分子/分母记数，例数可随结局变化。比较变化量时，沿用结果行的起止周和各自的区间。',
            user: userMessage(task),
            temperature: 0,
            tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:value${i + 1}`,
          });
          const json = (res.json ?? {}) as Record<string, unknown>;
          // 模型只需输出三个时点块；出现别的键（如 outcomeName）说明它跑偏了，忽略即可
          const present = (Object.keys(TIMEPOINTS) as TimepointJsonKey[]).filter(
            (k) => json[k] !== null && typeof json[k] === 'object' && !Array.isArray(json[k]),
          );
          if (present.length === 0) {
            issues.push(warn(
              `${base}（${t.name || t.instrument}）：模型没有给出任何时点块`,
              'OUTCOME_VALUE_EMPTY',
              { path: `outcomes.${t.rowIndex}` },
            ));
            values.push({ rowIndex: t.rowIndex });
            continue;
          }
          const grounded = groundNested<Record<string, unknown>>(
            ctx.doc, json, buildOutcomeValuePathMap(i, present), groundOpts, base,
          );
          allUnresolved.push(...grounded.unresolved);
          for (const g of grounded.issues) {
            issues.push(warn(g.reason, 'GROUNDING_FAILED', { path: `${base}.${g.field}` }));
          }
          const tps = (grounded.payload as { timepoints?: TimepointBlocks }).timepoints ?? {};
          decodeTimepointCodes(tps, `outcomes.${t.rowIndex}`, issues);
          for (const at of present) {
            const block = json[at] as Record<string, unknown>;
            if (!Array.isArray(block.continuousCandidates)) continue;
            let rank = selectionRank(tps[at]?.continuous, at);
            let chosen: typeof grounded | undefined;
            for (const candidate of block.continuousCandidates.slice(0, 6)) {
              const alternative = groundNested<Record<string, unknown>>(
                ctx.doc, { [at]: { continuous: candidate } }, buildOutcomeValuePathMap(i, [at]), groundOpts, base,
              );
              const times = alternative.payload.timepoints as TimepointBlocks | undefined;
              decodeTimepointCodes(times, `outcomes.${t.rowIndex}`, []);
              const continuous = times?.[at]?.continuous;
              const score = selectionRank(continuous, at);
              if (continuous && score > rank) {
                tps[at] = { ...tps[at], continuous };
                chosen = alternative;
                rank = score;
              }
            }
            if (chosen) allUnresolved.push(...chosen.unresolved);
          }
          validateExtractedIntervals(tps, `outcomes.${t.rowIndex}`, issues, allUnresolved);
          const preferredResult = preferredOutcome(tps);
          const rec: OutcomeValueRecord = { rowIndex: t.rowIndex, timepoints: tps, ...(preferredResult ? { preferredResult } : {}) };
          if (!Object.keys(tps).length) {
            issues.push(warn(
              `${base}（${t.name || t.instrument}）：没有定位成功的时点数值`,
              'NO_TIMEPOINT_DATA',
              { path: `outcomes.${t.rowIndex}` },
            ));
          }
          values.push(rec);
        } catch (e) {
          // 单个结局失败不应丢掉其他结局（截断/解析错误都会走到这里）
          issues.push(warn(
            `${base}（${t.name || t.instrument}）数值抽取失败：${(e as Error).message}`,
            'OUTCOME_VALUE_FAILED',
            { path: `outcomes.${t.rowIndex}` },
          ));
          values.push({ rowIndex: t.rowIndex });
        }
      }

      values.sort((a, b) => a.rowIndex - b.rowIndex);
      return { skillId: skill.id, level: 'outcome', payload: { values }, unresolved: allUnresolved, issues };
    },

    validate(output: SkillOutput<OutcomeValuesPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      for (const v of output.payload.values) {
        if (!v.timepoints || Object.keys(v.timepoints).length === 0) {
          issues.push(warn('结局没有任何时点数值', 'NO_TIMEPOINT_DATA', { path: `outcomes.${v.rowIndex}` }));
          continue;
        }
        validateTimepoints(v.timepoints, `outcomes.${v.rowIndex}`, issues);
        const hasEnd = Boolean(v.timepoints.endOfTreatment);
        const hasFollow = Boolean(v.timepoints.followUpEnd);
        if (!hasEnd && hasFollow) {
          issues.push(warn(
            `outcomes.${v.rowIndex}: 有随访结束数据但无疗程结束数据，请确认时点是否归错`,
            'MISSING_END_OF_TREATMENT',
            { path: `outcomes.${v.rowIndex}` },
          ));
        }
      }
      return issues;
    },
  };

  return skill;
}
