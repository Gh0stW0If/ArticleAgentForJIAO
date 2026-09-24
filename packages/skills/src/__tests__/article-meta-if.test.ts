/**
 * article-meta 的**影响因子查表**：防回归测试。
 *
 * 背景（用户口径）：影响因子必须从 `Datas/IF-SCI-2019.xlsx`（JCR 2019 SCIE 全刊表）查，
 * 因为论文里根本没有这个数——让模型凭记忆答，实测 224 篇错 172 篇
 * （"对"的 50 篇几乎都是双方都填 NR）。
 *
 * 这里锁四条规则：
 *   ① 查得到 → 一律以表为准，覆盖模型给的值（哪怕模型给的是个"看起来合理"的数）；
 *   ② 查不到 → 填 **0**（该刊 2019 年未进 SCIE，含中文刊/ESCI 刊），不是 NR；
 *   ③ Crossref 判定 mismatch 时，它的刊名不可信，要退回 PDF 里的刊名；
 *   ④ 期刊名缺失时不写该字段（宁缺勿造）。
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ingest, findMiddleFile } from '@aa/ingest';
import { createArticleMetaSkill, type IfLookup } from '../article-meta.ts';
import type { LlmInvoker, LlmResponse, MiniDoc, SkillContext } from '@aa/core';

const ROOT = resolve(__dirname, '../../../..');
const hasData = findMiddleFile(ROOT, '2015', '-2015-01') !== null;
const getDoc = (): MiniDoc => ingest({ rootDir: ROOT, year: '2015', studyId: '-2015-01' }).doc;

/** 假模型：只返回期刊名/DOI，其余留空，避免材料定位失败干扰断言。 */
const journalLlm = (journal: string, doi = '10.1136/acupmed-2015-010950'): LlmInvoker => ({
  async invoke(): Promise<LlmResponse> {
    const json = {
      journal: { value: journal, quote: journal, confidence: 0.9 },
      doi: { value: doi, quote: doi, confidence: 0.9 },
    };
    return { text: JSON.stringify(json), json, model: 'fake' };
  },
});

const ctxOf = (doc: MiniDoc, llm: LlmInvoker, crossref?: unknown): SkillContext =>
  ({ doc, llm, log: () => {}, ...(crossref ? { crossref } : {}) } as unknown as SkillContext);

/**
 * Crossref 桩：真实链路里期刊名几乎都来自 Crossref 的 container-title
 * （2015-01 的 PDF 正文里根本没有刊名，只有页眉图），所以测试也走这条路。
 * 只需要 `byDoi` / `byTitle` 两个方法——`resolveAndVerify` 只调这两个。
 */
const crossrefStub = (containerTitle: string) => {
  const work = {
    doi: '10.1136/acupmed-2015-010950', title: 'Acupuncture for fibromyalgia in primary care',
    containerTitle, issuedYear: '2016', authors: ['A. Author'], type: 'journal-article',
  };
  return {
    async byDoi() { return work; },
    /* byTitle 返回**数组**（verify.ts 里按候选打分挑选） */
    async byTitle() { return [work]; },
  };
};

/** 表桩：只有这两种刊在"表"里。 */
const TABLE: IfLookup = (name) => {
  const key = String(name ?? '').toUpperCase();
  if (key.includes('ACUPUNCTURE IN MEDICINE')) return { journal: 'Acupuncture in Medicine', jif: '2.129', how: 'exact' };
  if (key.includes('PAIN')) return { journal: 'PAIN', jif: '5.483', how: 'exact' };
  return null;
};

describe.skipIf(!hasData)('article-meta — 影响因子查表', () => {
  it('表里查得到 → 覆盖模型给的值，并记 IF_FROM_TABLE', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ ifLookup: TABLE, includeAbstract: false });
    const out = await skill.run(ctxOf(doc, journalLlm('Acupuncture in Medicine'), crossrefStub('Acupuncture in Medicine')));

    expect(out.payload.journal?.raw).toBe('Acupuncture in Medicine');
    expect(out.payload.impactFactor2019?.raw).toBe('2.129');
    expect(out.payload.impactFactor2019?.provenance).toBe('external');
    expect(out.issues.some((i) => i.code === 'IF_FROM_TABLE')).toBe(true);
  });

  it('表里查不到 → 填 0（未进 SCIE），不是 NR，并记 IF_NOT_IN_TABLE', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ ifLookup: TABLE, includeAbstract: false });
    const out = await skill.run(ctxOf(doc, journalLlm('Journal of Nothing Indexed'), crossrefStub('Journal of Nothing Indexed')));

    expect(out.payload.impactFactor2019?.raw).toBe('0');
    expect(out.issues.some((i) => i.code === 'IF_NOT_IN_TABLE')).toBe(true);
  });

  it('没提供查表函数时不动该字段（保持向后兼容）', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ includeAbstract: false });
    const out = await skill.run(ctxOf(doc, journalLlm('Acupuncture in Medicine'), crossrefStub('Acupuncture in Medicine')));
    expect(out.payload.impactFactor2019).toBeUndefined();
  });

  it('期刊名缺失时不写该字段（宁缺勿造）', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ ifLookup: TABLE, includeAbstract: false });
    const out = await skill.run(ctxOf(doc, {
      async invoke(): Promise<LlmResponse> {
        const json = { title: { value: 'x', quote: 'x', confidence: 0.5 } };
        return { text: JSON.stringify(json), json, model: 'fake' };
      },
    }));
    expect(out.payload.impactFactor2019).toBeUndefined();
  });
});
