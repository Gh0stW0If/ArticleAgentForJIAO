/**
 * @aa/skills — SKILL: 研究设计规划（study-plan）【上游】
 *
 * ===== 为什么要单独做一个"规划"SKILL =====
 *
 * 比较组级有 70 个字段、结局级每个时点 30 余个字段，而且**条数本身也是未知的**
 * （一篇论文有几个比较组、几个结局指标，得先数清楚）。
 * 让一次调用既判断结构又填细节，实测会出现两类错误：
 *   · 比较组数量数错 → 下游整组数据错位；
 *   · 结局指标列太多（把量表分项、基线变量都算成结局）→ 多出几十个错字段。
 *
 * 因此按需求「复杂任务分多个 SKILL」拆成两步：
 *   1. 本 SKILL（study-plan）**只做结构判断**：几个组、各组定位、几个比较组、每个比较是谁 vs 谁；
 *   2. 下游 SKILL（comparison / outcome）拿着这份"计划"去填细节，
 *      并且可以校验自己抽出来的组数与计划是否一致（数量不符会报 issue）。
 *
 * 材料只取摘要与方法学章节、且不含表格——组别与分组方式写在方法学的那段话里，
 * 而表格会把模型的注意力拉去数行（实测）。
 */

import {
  type FieldValue,
  type Issue,
  type Skill,
  type SkillContext,
  type SkillOutput,
  warn,
} from '@aa/core';
import { PROMPTS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundField, type RawFieldClaim } from './grounding.ts';

/** 计划里的一个组。 */
export interface PlannedGroup {
  label?: FieldValue;
  /** experimental = 接受待评干预；control = 对照/假针/等待组 */
  role?: FieldValue;
  description?: FieldValue;
}

/** 计划里的一个比较组（试验组 vs 对照组 的配对）。 */
export interface PlannedComparison {
  label?: FieldValue;
  intervention?: FieldValue;
  control?: FieldValue;
}

export interface StudyPlanPayload {
  groupCount?: FieldValue;
  experimentalGroupCount?: FieldValue;
  controlGroupCount?: FieldValue;
  comparisonCount?: FieldValue;
  groups: PlannedGroup[];
  comparisons: PlannedComparison[];
}

const SCALAR_KEYS = ['groupCount', 'experimentalGroupCount', 'controlGroupCount', 'comparisonCount'] as const;

const GROUP_KEYS = ['label', 'role', 'description'] as const;
const COMPARISON_KEYS = ['label', 'intervention', 'control'] as const;

/** 计划 SKILL 的输入材料：摘要 + 方法学，不含表格。 */
const PLAN_SECTIONS = ['abstract', 'metadata', 'methods'] as const;

/** 归一化臂名/组名，用于把比较组的一侧对回 groups（只做包含匹配，不做模糊评分）。 */
const normArm = (s?: string): string => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function createStudyPlanSkill(): Skill<StudyPlanPayload> {
  const skill: Skill<StudyPlanPayload> = {
    id: 'study-plan',
    version: '0.1.0',
    level: 'cross-cutting',
    description: '先判断研究结构：几个组、各组定位、几个比较组、每个比较是谁 vs 谁（不抽细节）',
    needs: ['abstract', 'methods'],
    needsTables: false,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<StudyPlanPayload>> {
      const issues: Issue[] = [];

      const materials = collectMaterials(ctx.doc, {
        sections: [...PLAN_SECTIONS],
        pages: [1],
        tables: false,
        figures: false,
        maxCharsPerBlock: 4000,
        maxTotalChars: 40_000,
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('摘要与方法学均无可用材料，无法判断研究结构', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'cross-cutting', payload: { groups: [], comparisons: [] }, unresolved: [], issues };
      }

      const res = await ctx.llm.invoke({
        system: PROMPTS.studyPlan,
        user: `以下是该论文的摘要与方法学材料。请按规则判断研究结构（组数、各组定位、比较组）。\n\n${materials.text}`,
        temperature: 0,
        tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
      });

      const payload: StudyPlanPayload = { groups: [], comparisons: [] };
      if (!res.json) {
        issues.push(warn('模型未返回结构化 JSON', 'NO_STRUCTURED_OUTPUT'));
        return { skillId: skill.id, level: 'cross-cutting', payload, unresolved: [], issues };
      }

      const raw = res.json as Record<string, unknown>;
      const unresolved: SkillOutput<StudyPlanPayload>['unresolved'] = [];

      /** 落地一个 claim（复用 grounding 的证据校验：quote 必须能在文中定位）。 */
      const claim = (path: string, v: unknown): FieldValue | undefined => {
        if (v === null || typeof v !== 'object') return undefined;
        const r = groundField(ctx.doc, path, v as RawFieldClaim, { kinds: ['text', 'title'] });
        if (r.field) return r.field;
        if (r.unresolved) unresolved.push(r.unresolved);
        if (r.issue) issues.push(warn(r.issue, 'GROUNDING_FAILED', { path }));
        return undefined;
      };

      for (const k of SCALAR_KEYS) {
        const f = claim(`studyPlan.${k}`, raw[k]);
        if (f) (payload as unknown as Record<string, unknown>)[k] = f;
      }

      for (const [i, g] of (Array.isArray(raw.groups) ? raw.groups : []).entries()) {
        if (g === null || typeof g !== 'object') continue;
        const rec: PlannedGroup = {};
        for (const k of GROUP_KEYS) {
          const f = claim(`studyPlan.groups[${i}].${k}`, (g as Record<string, unknown>)[k]);
          if (f) (rec as unknown as Record<string, unknown>)[k] = f;
        }
        if (rec.label || rec.description) payload.groups.push(rec);
      }

      /** 模型列出的候选比较组（先全部收下，再按"两侧都是对照"过滤）。 */
      const planned: PlannedComparison[] = [];
      for (const [i, c] of (Array.isArray(raw.comparisons) ? raw.comparisons : []).entries()) {
        if (c === null || typeof c !== 'object') continue;
        const rec: PlannedComparison = {};
        for (const k of COMPARISON_KEYS) {
          const f = claim(`studyPlan.comparisons[${i}].${k}`, (c as Record<string, unknown>)[k]);
          if (f) (rec as unknown as Record<string, unknown>)[k] = f;
        }
        if (rec.intervention || rec.control || rec.label) planned.push(rec);
      }

      /*
       * 丢掉「对照组 vs 对照组」的比较。
       *
       * 本系统评价的口径是**每一个比较组 = 一个试验组 vs 一个对照组**
       * （金标准 ARMNU=4「多对照组」就是同一试验组分别对多个对照）。
       * 实测 2015-05 是 3 臂（耳针 / 安慰针 / 常规治疗），模型列出了 3 个两两组合，
       * 多出的「安慰针 vs 常规治疗」既不在金标准里，还会把下游的比较组编号整体后移，
       * 导致 outcome 行全部错位（该篇 62.1%）。
       *
       * 只在**两侧都能对回 control 角色的组**时才丢——对不上就保留，宁可多不可错杀。
       */
      const role = (name?: string): string | undefined => {
        const n = normArm(name);
        if (!n) return undefined;
        for (const g of payload.groups) {
          const gl = normArm(g.label?.raw);
          if (!gl) continue;
          if (gl === n || gl.includes(n) || n.includes(gl)) return g.role?.raw;
        }
        return undefined;
      };
      for (const c of planned) {
        const ri = role(c.intervention?.raw);
        const rc = role(c.control?.raw);
        if (ri === 'control' && rc === 'control') {
          issues.push(warn(
            `比较组「${c.intervention?.raw} vs ${c.control?.raw}」两侧都是对照组，按口径不属于比较组，已丢弃`,
            'PLAN_COMPARISON_BOTH_CONTROL',
            { path: 'comparisons' },
          ));
          continue;
        }
        payload.comparisons.push(c);
      }

      if (!payload.comparisons.length) {
        issues.push(warn('未能判定任何比较组（下游会退化为"只有 1 个比较组"）', 'NO_COMPARISONS_PLANNED'));
      }

      return { skillId: skill.id, level: 'cross-cutting', payload, unresolved, issues };
    },

    /* ------------------------- 确定性校验器 ------------------------- */
    validate(output: SkillOutput<StudyPlanPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const p = output.payload;
      const num = (f?: FieldValue): number | undefined => {
        const n = Number(String(f?.raw ?? '').match(/\d+/)?.[0]);
        return Number.isFinite(n) ? n : undefined;
      };

      const g = num(p.groupCount);
      const e = num(p.experimentalGroupCount);
      const c = num(p.controlGroupCount);
      const cmp = num(p.comparisonCount);

      if (g !== undefined && e !== undefined && c !== undefined && e + c !== g) {
        issues.push(warn(`组数不自洽：试验组 ${e} + 对照组 ${c} ≠ 总组数 ${g}`, 'PLAN_GROUP_COUNT_MISMATCH', { path: 'groupCount' }));
      }
      if (g !== undefined && p.groups.length && g !== p.groups.length) {
        issues.push(warn(`groupCount=${g}，但 groups 只列出 ${p.groups.length} 个`, 'PLAN_GROUPS_INCOMPLETE', { path: 'groups' }));
      }
      if (cmp !== undefined && p.comparisons.length && cmp !== p.comparisons.length) {
        issues.push(warn(`comparisonCount=${cmp}，但 comparisons 只列出 ${p.comparisons.length} 个`, 'PLAN_COMPARISONS_INCOMPLETE', { path: 'comparisons' }));
      }
      if (!p.groups.some((x) => x.role?.raw === 'control')) {
        issues.push(warn('没有识别出任何对照组（role=control）', 'PLAN_NO_CONTROL_GROUP', { path: 'groups' }));
      }
      return issues;
    },
  };

  return skill;
}
