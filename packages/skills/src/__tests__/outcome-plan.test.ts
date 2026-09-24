/**
 * outcome-plan 的**声明句锚定**校验：防回归测试。
 *
 * 这里覆盖的是一次真实误杀（2015-02，当年全部漏的 91% 都源于它）：
 * 摘要声明句写 `Secondary outcomes were QoL, global change, …`（用缩写 **QoL**），
 * 而模型给出的结局名是 `quality of life`——朴素的子串匹配对不上（`qol` ≠ `quality`），
 * 于是**唯一的生活质量结局被整条丢弃** `OUTCOME_NOT_ANCHORED`。
 *
 * 因此这些用例锁两件事：
 *   ① 缩写 ↔ 全称要能对上（quality of life ↔ QoL、health-related quality of life ↔ HRQoL）；
 *   ② 不能因此放松到"什么都收"——声明句里没有、anchor 也不在声明段落的指标仍要丢弃
 *      （这是当初加这个校验的原因：否则结果表里的量表分项会全被收进来）。
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ingest, findMiddleFile } from '@aa/ingest';
import { createOutcomePlanSkill } from '../outcome-plan.ts';
import type { LlmInvoker, LlmResponse, MiniDoc, SkillContext } from '@aa/core';

const ROOT = resolve(__dirname, '../../../..');
const hasData = findMiddleFile(ROOT, '2015', '-2015-02') !== null;

const getDoc = (): MiniDoc => ingest({ rootDir: ROOT, year: '2015', studyId: '-2015-02' }).doc;

const ctxOf = (doc: MiniDoc, llm: LlmInvoker): SkillContext => ({ doc, llm, log: () => {} });

/** 按调用次数依次返回不同 JSON 的假模型（本 SKILL 有回退调用）。 */
const seqLlm = (payloads: unknown[]): LlmInvoker => {
  let i = 0;
  return {
    async invoke(): Promise<LlmResponse> {
      const json = payloads[Math.min(i++, payloads.length - 1)];
      return { text: JSON.stringify(json), json, model: 'fake' };
    },
  };
};

/** 声明句所在段落（b9，摘要 Methods 段）里的原文片段。 */
const DECL = 'Secondary outcomes were QoL, global change, SAR-related medication usage, and adverse events.';

describe.skipIf(!hasData)('outcome-plan — 声明句锚定（缩写与误杀）', () => {
  it('缩写 QoL 能对上全称 quality of life，不会被误杀', async () => {
    const doc = getDoc();
    const out = await createOutcomePlanSkill().run(ctxOf(doc, seqLlm([{
      declarationFound: { value: 'true', quote: DECL, confidence: 0.9 },
      outcomes: [
        {
          outcomeName: { value: 'quality of life', quote: 'quality of life (QoL)', confidence: 0.9 },
          instrument: { value: 'RQLQ(S)', quote: 'Rhinoconjunctivitis Quality of Life Questionnaire', confidence: 0.9 },
          outcomeClass: { value: '4', quote: 'quality of life (QoL)', confidence: 0.9 },
          anchor: { value: DECL, quote: DECL, confidence: 0.9 },
        },
      ],
    }])));

    const names = out.payload.outcomes.map((o) => o.name?.raw);
    expect(names).toContain('quality of life');
    expect(out.payload.rejected ?? []).toHaveLength(0);
  });

  it('声明句里没有、anchor 也不在声明段落的指标仍要丢弃（防"什么都收"）', async () => {
    const doc = getDoc();
    const out = await createOutcomePlanSkill().run(ctxOf(doc, seqLlm([{
      declarationFound: { value: 'true', quote: DECL, confidence: 0.9 },
      outcomes: [
        {
          // 结果表里的额外指标（不是声明句里的任何一项）
          outcomeName: { value: 'nasal obstruction score', quote: 'nasal obstruction', confidence: 0.9 },
          instrument: { value: 'ZZZ-9 unusual instrument', quote: 'nasal obstruction', confidence: 0.9 },
          outcomeClass: { value: '2', quote: 'nasal obstruction', confidence: 0.9 },
          anchor: { value: 'nasal obstruction was recorded weekly', quote: 'nasal obstruction was recorded weekly', confidence: 0.9 },
        },
      ],
    }])));

    const names = out.payload.outcomes.map((o) => o.name?.raw);
    expect(names).not.toContain('nasal obstruction score');
    expect((out.payload.rejected ?? []).some((r) => /声明句/.test(r.reason))).toBe(true);
  });
});
