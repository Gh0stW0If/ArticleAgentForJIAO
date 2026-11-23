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
  type GroupStats,
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
import { groundField, numericTokens, type RawFieldClaim } from './grounding.ts';
import { intervalProblem, reportedNumber } from './timepoints.ts';

const TIMEPOINT_JSON = new Set(['baseline', 'endOfTreatment', 'followUpEnd']);

/** 一条待补/待核的记录。 */
interface AuditItem {
  outcomeName: string;
  outcomeId?: string;
  source?: RawFieldClaim['source'];
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

      const auditIds = list.map((row, index) => `${row.comparisonScope?.id ?? row.studyId}:${index + 1}`);

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
            if (cont.varianceType?.code === '2' && has('ciLower') !== has('ciUpper')) {
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
        numberTableCells: true,
        maxCharsPerBlock: 6000,
        ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
      });

      /** 已抽取结果的紧凑摘要：只列结局名 + 各时点已有的键与值，避免把整份文档塞进去。 */
      const summary = list.map((o, i) => {
        const name = o.outcome?.name?.raw ?? '(未命名)';
        const ins = o.outcome?.instrument?.raw ?? '';
        const tps = Object.entries(o.timepoints ?? {}).map(([tp, block]) => {
          const continuous = block?.continuous;
          const show = (side: 'experimental' | 'control'): string => {
            const entries = Object.entries({ ...continuous?.[side], ...block?.binary?.[side] });
            const parts = entries.filter(([, value]) => value?.raw).map(([key, value]) => `${key}=${value.raw}`);
            return `${side}: ${parts.join(' ') || '-'}`;
          };
          return `    ${tp} (varianceType=${continuous?.varianceType?.code ?? '?'}): ${show('experimental')} | ${show('control')}`;
        });
        const pair = o.comparisonScope;
        const scope = pair ? ` (${pair.intervention} vs ${pair.control})` : '';
        return `  [outcomeId=${auditIds[i]}] ${name}${ins ? ` / ${ins}` : ''}${scope}\n${tps.join('\n')}`;
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
          system: PROMPTS.outcomeAudit + '\n每条差异原样返回摘要的 outcomeId。表格差异返回 source={block,row,column}，行列从 1 开始。varianceType 为 1 或 3 时，ciLower 存单个 SE/SD，ciUpper 无需填写。只在同一结局、组别、时点及估计口径下报告 CI 或例数。',
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
              ...(x.outcomeId ? { outcomeId: String(x.outcomeId) } : {}),
              ...(x.source && typeof x.source === 'object' ? { source: x.source as NonNullable<RawFieldClaim['source']> } : {}),
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

      /** 新响应使用行 ID，旧响应仅允许唯一且精确的结局名称。 */
      const findIndex = (item: AuditItem): number => {
        if (item.outcomeId) return auditIds.indexOf(item.outcomeId);
        const norm = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const expected = norm(item.outcomeName);
        if (!expected) return -1;
        const matched = list.flatMap((row, index) => {
          const name = row.outcome?.name?.raw ?? '';
          const instrument = row.outcome?.instrument?.raw ?? '';
          return [name, instrument, name + instrument].some(label => norm(label) === expected) ? [index] : [];
        });
        return matched.length === 1 ? matched[0]! : -1;
      };

      type Proposal = { item: AuditItem; idx: number; tp: string; candidate: FieldValue };
      const pendingIntervals = new Map<GroupStats, { lower: Proposal[]; upper: Proposal[] }>();
      const report = (item: AuditItem, idx: number, tp: string | undefined, reason: string) => {
        reported.push({ outcomeIndex: idx >= 0 ? idx : null, field: tp ? `${tp}.${item.field}` : item.field, value: item.value, reason });
      };
      const applied = ({ item, idx, tp, candidate }: Proposal) => {
        filled.push({ outcomeIndex: idx, timepoint: tp, field: item.field, value: item.value });
        issues.push(warn(`已补漏：结局「${item.outcomeName}」${tp}.${item.field} = ${item.value}`,
          'AUDIT_FILLED', { path: `outcomes[${idx}].${tp}.${item.field}`, evidence: candidate.evidence }));
      };

      const applyItem = (item: AuditItem, isSuspect: boolean): void => {
        const idx = findIndex(item);
        const tp = item.timepoint && TIMEPOINT_JSON.has(item.timepoint)
          ? item.timepoint as keyof NonNullable<OutcomeLevel['timepoints']> : undefined;
        const grounded = groundField(ctx.doc, `outcomeAudit.${item.field}`,
          { value: item.value, quote: item.quote, ...(item.source ? { source: item.source } : {}),
            ...(item.confidence !== undefined ? { confidence: item.confidence } : {}) },
          { kinds: ['text', 'title', 'table'] });
        if (grounded.unresolved) {
          unresolved.push(grounded.unresolved);
          report(item, idx, tp, 'quote 无法定位，未采用');
          return;
        }
        if (!grounded.field) return;
        if (idx < 0) {
          report(item, idx, tp, '未唯一匹配到对应结局及比较组');
          return;
        }
        const match = /^(experimental|control)(CiLower|CiUpper|N)$/.exec(item.field);
        const cont = tp ? list[idx]!.timepoints?.[tp]?.continuous : undefined;
        const side = match?.[1] as 'experimental' | 'control' | undefined;
        const group = side ? cont?.[side] : undefined;
        const leaf = match?.[2] === 'N' ? 'n' : match?.[2] === 'CiLower' ? 'ciLower' : 'ciUpper';
        if (!tp || !group || isSuspect || !match) {
          report(item, idx, tp, '需人工核对');
          return;
        }
        const slot = group[leaf];
        if (slot?.raw && !/^(NR|NA|NE)$/i.test(slot.raw)) {
          report(item, idx, tp, '该位置已有值，未覆盖');
          return;
        }
        const source = grounded.field.evidence[0];
        const estimate = group.estimate?.evidence[0];
        const value = reportedNumber(grounded.field);
        const sameCell = source?.kind === 'table' && estimate?.kind === 'table'
          && source.tableCell?.row !== undefined && source.tableCell.row === estimate.tableCell?.row
          && source.tableCell.column === estimate.tableCell.column;
        const sameExcerpt = source?.kind === 'text' && estimate?.kind === 'text' && source.quote === estimate.quote;
        const scoped = source && estimate && value !== undefined && numericTokens(source.quote).includes(value)
          && source.blockId === estimate.blockId && source.page === estimate.page && (sameCell || sameExcerpt);
        const proposal = { item, idx, tp, candidate: grounded.field };
        if (scoped && leaf === 'n' && sameCell && Number(/\bn\s*=\s*(\d+)\b/i.exec(source.quote)?.[1]) === value && value > 0) {
          group.n = grounded.field;
          applied(proposal);
        } else if (scoped && leaf !== 'n' && cont?.varianceType?.code === '2') {
          const entry = pendingIntervals.get(group) ?? { lower: [], upper: [] };
          entry[leaf === 'ciLower' ? 'lower' : 'upper'].push(proposal);
          pendingIntervals.set(group, entry);
        } else {
          report(item, idx, tp, '缺少同一时点、组别和统计量的证据，交人工确认');
        }
      };

      for (const g of gaps) applyItem(g, false);
      for (const s of suspects) applyItem(s, true);
      const estimateWithInterval = /([−–+-]?\d+(?:\.\d+)?)\s*(?:[,;]?\s*(?:95\s*%\s*(?:CI|confidence interval))\s*)?[([]\s*([−–+-]?\d+(?:\.\d+)?)\s*(?:to|[,–—]|\s+-\s+)\s*([−–+-]?\d+(?:\.\d+)?)\s*[)\]]/gi;
      for (const [group, { lower, upper }] of pendingIntervals) {
        const lo = lower[0];
        const hi = upper[0];
        const candidateLower = lo?.candidate ?? group.ciLower;
        const candidateUpper = hi?.candidate ?? group.ciUpper;
        const expected = [group.estimate, candidateLower, candidateUpper].map(reportedNumber);
        const quoted = group.estimate?.evidence[0]?.quote ?? '';
        const matchingTuple = [...quoted.matchAll(estimateWithInterval)].some(match =>
          match.slice(1).every((part, index) => Number(part.replace(/[−–]/g, '-')) === expected[index]));
        if (lower.length > 1 || upper.length > 1 || !matchingTuple
            || intervalProblem(group.estimate, candidateLower, candidateUpper, true)) {
          for (const { item, idx, tp } of [...lower, ...upper]) report(item, idx, tp, '置信区间的边界或来源无法唯一确认');
          continue;
        }
        if (lo) { group.ciLower = lo.candidate; applied(lo); }
        if (hi) { group.ciUpper = hi.candidate; applied(hi); }
      }

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
