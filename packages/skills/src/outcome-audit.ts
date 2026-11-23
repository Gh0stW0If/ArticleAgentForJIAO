/**
 * @aa/skills — SKILL: 结局层事后验证（outcome-audit）【查漏补缺】
 *
 * 需求：**在所有信息都提取完成后，再加一个验证 SKILL 专门检查是否有错和遗漏。**
 *
 * 设计：两段式，先确定性、后 LLM——这样最便宜的一批问题不必花判定费。
 *
 *   ① **确定性核查**（0 成本）：直接从已抽取结果里找结构性缺陷——
 *      有估计值却缺例数、CI 只填一半、整个时点块没有值、结局行一条数值都没有……
 *      实测 2015 年这类问题就有 48+ 处（`TIMEPOINT_MISSING_N`）。
 *      它们既是"要补的清单"，也是给 LLM 的**重点提示**（比让模型自己找高效得多）。
 *
 *   ② **LLM 核查**：把「论文材料」与「已抽取结果的紧凑摘要」一起给模型，
 *      只要求它报**差异**（漏掉的结局/时点/数值 + 与原文不符的值），每条必须带逐字 quote。
 *      带 quote 的条目再经 `groundField` 定位校验：
 *        · 目标位置**当前为空** → 就地补上（provenance='model'，证据来自 quote）；
 *        · 目标已有值 / 定位失败 → 只记录（`suspects` 与 `unresolved`），绝不静默改写。
 *
 * 为什么不直接让它重抽一遍：那等于再花一遍全量成本，而且会与第一轮结果打架。
 * 核查只针对"差异"，成本与风险都可控。
 */

import {
  type FieldValue,
  type Issue,
  type OutcomeLevel,
  type Skill,
  type SkillContext,
  type SkillOutput,
  type UnresolvedItem,
  warn,
} from '@aa/core';
import { PROMPTS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundField, type RawFieldClaim } from './grounding.ts';

/** 时点块内的键（与 outcome SKILL 的 TIMEPOINT_FIELD_MAP 同名）。 */
const TIMEPOINT_KEYS = new Set([
  'estimateType', 'varianceType', 'experimentalEstimate', 'experimentalCiLower', 'experimentalCiUpper',
  'experimentalN', 'controlEstimate', 'controlCiLower', 'controlCiUpper', 'controlN',
  'experimentalEvents', 'controlEvents', 'differenceEstimate', 'differenceCiLower', 'differenceCiUpper',
]);

const TIMEPOINT_JSON = new Set(['baseline', 'endOfTreatment', 'followUpEnd']);

/** 一条待补/待核的记录。 */
interface AuditItem {
  outcomeName: string;
  timepoint?: string;
  field: string;
  value: string;
  quote: string;
  confidence?: number;
  reason?: string;
}

export interface OutcomeAuditPayload {
  /** 确定性核查发现的问题（与 issues 同一批，这里保留结构化副本便于报告） */
  checkResults: { code: string; path: string; message: string }[];
  /** 已就地补上的空位 */
  filled: { outcomeIndex: number; timepoint?: string; field: string; value: string }[];
  /** 目标已有值 / 无法定位 → 只报告不改写 */
  reported: { outcomeIndex: number | null; field: string; value: string; reason: string }[];
  /** 给 LLM 的输入摘要（便于复现与审计） */
  summaryChars: number;
}

export interface OutcomeAuditOptions {
  /** 已抽取的结局（由运行器传入） */
  extracted: readonly OutcomeLevel[];
  maxTotalChars?: number;
}

const empty = (n: number): boolean => n === 0;

export function createOutcomeAuditSkill(opts: OutcomeAuditOptions): Skill<OutcomeAuditPayload> {
  const skill: Skill<OutcomeAuditPayload> = {
    id: 'outcome-audit',
    version: '0.1.0',
    level: 'cross-cutting',
    description: '事后核查结局层：先确定性查结构性缺陷，再用 LLM 对照论文查漏补缺',
    needs: ['results', 'methods'],
    needsTables: true,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<OutcomeAuditPayload>> {
      const issues: Issue[] = [];
      const unresolved: UnresolvedItem[] = [];
      const checkResults: OutcomeAuditPayload['checkResults'] = [];
      const filled: OutcomeAuditPayload['filled'] = [];
      const reported: OutcomeAuditPayload['reported'] = [];

      const list = opts.extracted ?? [];
      if (!list.length) {
        issues.push(warn('没有已抽取的结局可供核查', 'NOTHING_TO_AUDIT'));
        return { skillId: skill.id, level: 'cross-cutting', payload: { checkResults, filled, reported, summaryChars: 0 }, unresolved, issues };
      }

      /* ---------------- ① 确定性核查 ---------------- */

      const checklist: string[] = [];
      list.forEach((o, i) => {
        const name = o.outcome?.name?.raw ?? o.outcome?.instrument?.raw ?? `结局${i + 1}`;
        const tps = Object.entries(o.timepoints ?? {}) as [string, Record<string, FieldValue> | undefined][];
        if (empty(tps.length)) {
          const m = `结局「${name}」完全没有时点数值`;
          issues.push(warn(m, 'AUDIT_NO_TIMEPOINT', { path: `outcomes[${i}]` }));
          checkResults.push({ code: 'AUDIT_NO_TIMEPOINT', path: `outcomes[${i}]`, message: m });
          checklist.push(`· 结局「${name}」：没有任何时点数值，论文里是否有？`);
          return;
        }
        for (const [tp, block] of tps) {
          const cont = block?.continuous as Record<string, FieldValue> | undefined;
          if (!cont) continue;
          for (const side of ['experimental', 'control'] as const) {
            const g = cont[side] as Record<string, FieldValue> | undefined;
            if (!g) continue;
            const val = (k: string): string => String(g[k]?.raw ?? '').trim();
            const has = (k: string): boolean => Boolean(val(k)) && !/^(NR|NA)$/i.test(val(k));
            if (has('estimate') && !has('n')) {
              const m = `结局「${name}」${tp}.${side}：有估计值但缺例数 n`;
              issues.push(warn(m, 'AUDIT_MISSING_N', { path: `outcomes[${i}].${tp}.${side}.n` }));
              checkResults.push({ code: 'AUDIT_MISSING_N', path: `outcomes[${i}].${tp}.${side}.n`, message: m });
              checklist.push(`· 结局「${name}」${tp}：缺 ${side === 'experimental' ? '试验组' : '对照组'}例数（多在正文里）`);
            }
            if (has('ciLower') !== has('ciUpper')) {
              const m = `结局「${name}」${tp}.${side}：95%CI 只填了一半`;
              issues.push(warn(m, 'AUDIT_CI_INCOMPLETE', { path: `outcomes[${i}].${tp}.${side}` }));
              checkResults.push({ code: 'AUDIT_CI_INCOMPLETE', path: `outcomes[${i}].${tp}.${side}`, message: m });
              checklist.push(`· 结局「${name}」${tp}：${side === 'experimental' ? '试验组' : '对照组'} CI 缺一半`);
            }
          }
        }
      });

      /* ---------------- ② LLM 核查（只报差异） ---------------- */

      const materials = collectMaterials(ctx.doc, {
        sections: ['results', 'methods', 'abstract'],
        pages: [1],
        tables: true,
        figures: false,
        maxCharsPerBlock: 6000,
        ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
      });

      /** 已抽取结果的紧凑摘要：只列结局名 + 各时点已有的键与值，避免把整份文档塞进去。 */
      const summary = list.map((o, i) => {
        const name = o.outcome?.name?.raw ?? '(未命名)';
        const ins = o.outcome?.instrument?.raw ?? '';
        const tps = Object.entries(o.timepoints ?? {}).map(([tp, block]) => {
          const cont = (block?.continuous ?? {}) as Record<string, FieldValue>;
          const show = (side: string): string => {
            const g = cont[side] as Record<string, FieldValue> | undefined;
            if (!g) return `${side}: -`;
            const parts = Object.entries(g)
              .filter(([, v]) => v?.raw)
              .map(([k, v]) => `${k}=${v.raw}`);
            return `${side}: ${parts.join(' ') || '-'}`;
          };
          return `    ${tp}: ${show('experimental')} | ${show('control')}`;
        });
        return `  [${i + 1}] ${name}${ins ? ` / ${ins}` : ''}\n${tps.join('\n')}`;
      }).join('\n');

      const user =
        `# 论文材料\n\n${materials.text}\n\n` +
        `# 已抽取的结局层结果（共 ${list.length} 条）\n\n${summary}\n\n` +
        (checklist.length
          ? `# 已自动发现的疑似缺口（请优先核实这些）\n\n${checklist.join('\n')}\n\n`
          : '') +
        `# 本次任务\n请对照上面的材料核查已抽取结果，**只报告差异**（遗漏或与原文不符），按系统提示的 JSON 格式输出。`;

      let gaps: AuditItem[] = [];
      let suspects: AuditItem[] = [];
      try {
        const res = await ctx.llm.invoke({
          system: PROMPTS.outcomeAudit,
          user,
          temperature: 0,
          tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
        });
        const json = (res.json ?? {}) as Record<string, unknown>;
        const asItems = (v: unknown): AuditItem[] =>
          (Array.isArray(v) ? v : [])
            .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
            .map((x) => ({
              outcomeName: String(x.outcomeName ?? ''),
              ...(x.timepoint ? { timepoint: String(x.timepoint) } : {}),
              field: String(x.field ?? ''),
              value: String(x.value ?? ''),
              quote: String(x.quote ?? ''),
              ...(typeof x.confidence === 'number' ? { confidence: x.confidence } : {}),
              ...(x.reason ? { reason: String(x.reason) } : {}),
            }))
            .filter((x) => x.field && x.quote.trim());
        gaps = asItems(json.gaps);
        suspects = asItems(json.suspects);
        for (const n of (Array.isArray(json.notes) ? json.notes : [])) {
          issues.push(warn(`核查说明：${String(n).slice(0, 200)}`, 'AUDIT_NOTE'));
        }
      } catch (e) {
        issues.push(warn(`LLM 核查失败（已跳过，确定性核查结果保留）：${(e as Error).message}`, 'AUDIT_LLM_FAILED'));
      }

      /* ---------------- 落地：能补的空位补上，其余只报告 ---------------- */

      /** 找到该结局在已抽取列表里的下标（按名称/工具模糊匹配）。 */
      const findIndex = (item: AuditItem): number => {
        const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const needle = norm(item.outcomeName);
        if (!needle) return -1;
        let best = -1;
        let bestScore = 0;
        list.forEach((o, i) => {
          const hay = norm(`${o.outcome?.name?.raw ?? ''} ${o.outcome?.instrument?.raw ?? ''}`);
          if (!hay) return;
          if (hay.includes(needle) || needle.includes(hay)) {
            const score = Math.min(hay.length, needle.length);
            if (score > bestScore) { bestScore = score; best = i; }
          }
        });
        return best;
      };

      const applyItem = (item: AuditItem, isSuspect: boolean): void => {
        const idx = findIndex(item);
        const grounded = groundField(
          ctx.doc,
          `outcomeAudit.${item.field}`,
          { value: item.value, quote: item.quote, ...(item.confidence !== undefined ? { confidence: item.confidence } : {}) } as RawFieldClaim,
          { kinds: ['text', 'title', 'table'] },
        );

        if (grounded.unresolved) {
          unresolved.push(grounded.unresolved);
          reported.push({ outcomeIndex: idx >= 0 ? idx : null, field: item.field, value: item.value, reason: 'quote 无法定位，未采用' });
          return;
        }
        if (!grounded.field) return;

        const tp = item.timepoint && TIMEPOINT_JSON.has(item.timepoint) ? item.timepoint : undefined;

        // 目标位置：时点块内的键 → 该结局该时点该组该叶；否则按结局级键处理
        if (idx >= 0 && tp && TIMEPOINT_KEYS.has(item.field)) {
          const target = list[idx]!;
          const block = (target.timepoints as unknown as Record<string, { continuous?: Record<string, unknown> }> | undefined)?.[tp];
          const cont = block?.continuous as Record<string, { experimental?: Record<string, FieldValue>; control?: Record<string, FieldValue> }> | undefined;
          const side = item.field.startsWith('experimental') ? 'experimental' : item.field.startsWith('control') ? 'control' : null;
          const leaf = side === 'experimental' ? item.field.slice('experimental'.length)
            : side === 'control' ? item.field.slice('control'.length) : item.field;
          const leafKey = leaf.charAt(0).toLowerCase() + leaf.slice(1);
          const sideMap = side && cont ? (cont[side] as unknown as Record<string, FieldValue> | undefined) : undefined;
          const slot = sideMap?.[leafKey];

          if (slot?.raw && !/^(NR|NA)$/i.test(slot.raw)) {
            // 已有值 → 绝不静默改写，只作为疑点报告
            reported.push({
              outcomeIndex: idx,
              field: `${tp}.${item.field}`,
              value: item.value,
              reason: isSuspect ? '与原值不符（原值已保留）' : '该位置已有值，未覆盖',
            });
            return;
          }
          if (cont && side) {
            if (!cont[side]) cont[side] = {};
            (cont[side] as unknown as Record<string, FieldValue>)[leafKey] = grounded.field;
            filled.push({ outcomeIndex: idx, timepoint: tp, field: item.field, value: item.value });
            issues.push(warn(
              `已补漏：结局「${item.outcomeName}」${tp}.${item.field} = ${item.value}`,
              'AUDIT_FILLED',
              { path: `outcomes[${idx}].${tp}.${item.field}`, evidence: grounded.field.evidence },
            ));
            return;
          }
        }

        // 兜底：找不到确切位置 → 只报告
        reported.push({
          outcomeIndex: idx >= 0 ? idx : null,
          field: `${tp ? `${tp}.` : ''}${item.field}`,
          value: item.value,
          reason: idx < 0 ? '未匹配到对应结局' : '该字段不支持自动回填，交人工确认',
        });
      };

      for (const g of gaps) applyItem(g, false);
      for (const s of suspects) applyItem(s, true);

      return {
        skillId: skill.id,
        level: 'cross-cutting',
        payload: { checkResults, filled, reported, summaryChars: materials.text.length },
        unresolved,
        issues,
      };
    },
  };

  return skill;
}
