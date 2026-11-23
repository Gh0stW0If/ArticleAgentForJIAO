import { describe, it, expect } from 'vitest';
import {
  mergeOverlay, makeAnnotation, annotationStats, evidenceFromSelection,
  buildConsensus, consensusStats, mergeConsensus, pairwiseAgreement,
  reviewerSummaries, reviewerOf, LEGACY_REVIEWER,
  type AnnotationOverlay, type FieldValue,
} from '@aa/core';

const ev = (quote: string, page = 1) => ({ kind: 'text' as const, page, bbox: [0, 0, 10, 10] as const, quote });

const llmField = (raw: string, code?: string): FieldValue => ({
  raw,
  ...(code ? { code } : {}),
  evidence: [ev('llm quote')],
  provenance: 'model',
  confidence: 0.8,
});

const humanField = (raw: string, quote = 'human quote'): FieldValue => ({
  raw,
  evidence: [ev(quote)],
  provenance: 'human',
  confidence: 1,
});

const overlay = (entries: AnnotationOverlay['entries']): AnnotationOverlay => ({
  schemaVersion: 'AA_ANNOTATION/1.0',
  year: '2015',
  articleId: '2015-01',
  sourcePdf: 'Datas/articles/2015/-2015-01.pdf',
  entries,
  updatedAt: new Date().toISOString(),
});

describe('annotation — 合并人工覆盖层', () => {
  const pipeline = {
    'article.title': llmField('Acupuncture for fibromyalgia', 'x'),
    'article.country': llmField('Spain'),
    'comparisons.0.randomizationClass': llmField('2'),
  };

  it('无覆盖层时全部采用流水线值', () => {
    const merged = mergeOverlay(pipeline, null);
    expect(merged).toHaveLength(3);
    for (const m of merged) {
      expect(m.decidedBy).toBe('model');
      expect(m.overridden).toBe(false);
    }
  });

  it('override：人工值优先，且保留 LLM 原值', () => {
    const merged = mergeOverlay(pipeline, overlay([
      makeAnnotation('article.country', humanField('China', 'southern Spain'), {
        action: 'override',
        llmValue: pipeline['article.country'],
      }),
    ]));
    const m = merged.find((x) => x.fieldPath === 'article.country')!;
    expect(m.value.raw).toBe('China');
    expect(m.decidedBy).toBe('human');
    expect(m.overridden).toBe(true);
    expect(m.llmValue?.raw).toBe('Spain');           // 可回滚
    expect(m.value.evidence[0]!.quote).toBe('southern Spain');
  });

  it('add：LLM 未抽出的字段由人工补录', () => {
    const merged = mergeOverlay(pipeline, overlay([
      makeAnnotation('article.registrationIds', humanField('ISRCTN60217348', 'Trial registration number'), { action: 'add' }),
    ]));
    const m = merged.find((x) => x.fieldPath === 'article.registrationIds')!;
    expect(m.value.raw).toBe('ISRCTN60217348');
    expect(m.overridden).toBe(true);
    expect(m.llmValue).toBeUndefined();
  });

  it('confirm：确认正确但不视为改动', () => {
    const merged = mergeOverlay(pipeline, overlay([
      makeAnnotation('article.title', humanField('Acupuncture for fibromyalgia'), {
        action: 'confirm',
        llmValue: pipeline['article.title'],
      }),
    ]));
    const m = merged.find((x) => x.fieldPath === 'article.title')!;
    expect(m.decidedBy).toBe('human');
    expect(m.overridden).toBe(false);                 // confirm 不算改动
    expect(m.llmValue?.raw).toBe('Acupuncture for fibromyalgia');
  });

  it('流水线与覆盖层都没有的字段不会凭空出现', () => {
    const merged = mergeOverlay(pipeline, overlay([]));
    expect(merged.map((m) => m.fieldPath)).toEqual([
      'article.country', 'article.title', 'comparisons.0.randomizationClass',
    ]);
  });

  it('字段路径与流水线一致（支持嵌套层级路径）', () => {
    const deep = {
      'outcomes.1.timepoints.endOfTreatment.continuous.experimental.estimate': llmField('-41'),
    };
    const merged = mergeOverlay(deep, overlay([
      makeAnnotation(
        'outcomes.1.timepoints.endOfTreatment.continuous.experimental.estimate',
        humanField('-42', '−42.0%'),
        { action: 'override', llmValue: deep['outcomes.1.timepoints.endOfTreatment.continuous.experimental.estimate'] },
      ),
    ]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.value.raw).toBe('-42');
    expect(merged[0]!.llmValue?.raw).toBe('-41');
  });

  it('结果按字段路径排序（便于稳定展示与 diff）', () => {
    const merged = mergeOverlay(pipeline, null);
    const paths = merged.map((m) => m.fieldPath);
    expect(paths).toEqual([...paths].sort());
  });
});

describe('annotation — 统计与证据构造', () => {
  it('统计人工干预情况（LLM 质量评估用）', () => {
    const s = annotationStats(overlay([
      makeAnnotation('a', humanField('1'), { action: 'add' }),
      makeAnnotation('b', humanField('2'), { action: 'override' }),
      makeAnnotation('c', humanField('3'), { action: 'confirm' }),
      makeAnnotation('d', humanField('4'), { action: 'override' }),
    ]));
    expect(s).toEqual({ total: 4, added: 1, overridden: 2, confirmed: 1 });
  });

  it('空覆盖层统计为 0', () => {
    expect(annotationStats(null)).toEqual({ total: 0, added: 0, overridden: 0, confirmed: 0 });
  });

  it('evidenceFromSelection：产出可序列化的 bbox 元组（不是 readonly）', () => {
    const e = evidenceFromSelection(3, [10, 20, 30, 40] as const, '原文片段', { blockId: 'b7' });
    expect(e.page).toBe(3);
    expect(e.bbox).toEqual([10, 20, 30, 40]);
    expect(e.quote).toBe('原文片段');
    expect(e.blockId).toBe('b7');
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);   // 可序列化（要存盘）
  });

  it('evidenceFromSelection 支持指定 kind（表格/图）', () => {
    expect(evidenceFromSelection(1, [0, 0, 1, 1] as const, 'q', { kind: 'table' }).kind).toBe('table');
  });
});

/* ==========================================================================
 * 多人机核对（202609）
 * ========================================================================== */

/** 构造某位核对人的覆盖层。 */
const byReviewer = (reviewer: string, entries: AnnotationOverlay['entries'], updatedAt = '2026-09-24T00:00:00.000Z'): AnnotationOverlay => ({
  schemaVersion: 'AA_ANNOTATION/2.0',
  year: '2015',
  articleId: '2015-01',
  sourcePdf: 'Datas/articles/2015/-2015-01.pdf',
  reviewer,
  entries,
  updatedAt,
});

const at = (fieldPath: string, raw: string, action: 'confirm' | 'override' | 'add' = 'override') =>
  makeAnnotation(fieldPath, humanField(raw), { action });

describe('annotation — 多人核对：逐字段状态', () => {
  const pipeline = {
    'article.title': llmField('Acupuncture for fibromyalgia'),
    'article.country': llmField('Spain'),
  };

  it('两位核对人结论一致 → agreed，并采用该值', () => {
    const rows = buildConsensus(pipeline, [
      byReviewer('A', [at('article.country', 'Spain', 'confirm')]),
      byReviewer('B', [at('article.country', 'Spain', 'confirm')]),
    ]);
    const row = rows.find((r) => r.fieldPath === 'article.country')!;
    expect(row.status).toBe('agreed');
    expect(row.agreedWithMachine).toBe(true);
    expect(row.agreedValue!.raw).toBe('Spain');
    expect(row.opinions.map((o) => o.reviewer)).toEqual(['A', 'B']);
  });

  it('两位核对人结论不同 → disputed，且不给出一致值', () => {
    const rows = buildConsensus(pipeline, [
      byReviewer('A', [at('article.country', 'Spain')]),
      byReviewer('B', [at('article.country', 'China')]),
    ]);
    const row = rows.find((r) => r.fieldPath === 'article.country')!;
    expect(row.status).toBe('disputed');
    expect(row.agreedValue).toBeUndefined();
  });

  it('只有一位核对人表态 → single（还差第二人）', () => {
    const rows = buildConsensus(pipeline, [byReviewer('A', [at('article.title', 'X', 'confirm')])]);
    expect(rows.find((r) => r.fieldPath === 'article.title')!.status).toBe('single');
  });

  it('无人表过态的机器字段 → machine-only', () => {
    const rows = buildConsensus(pipeline, []);
    expect(rows.every((r) => r.status === 'machine-only')).toBe(true);
  });

  it('比对忽略大小写与多余空白', () => {
    const rows = buildConsensus(pipeline, [
      byReviewer('A', [at('article.title', '  acupuncture FOR fibromyalgia ')]),
      byReviewer('B', [at('article.title', 'Acupuncture for fibromyalgia')]),
    ]);
    expect(rows.find((r) => r.fieldPath === 'article.title')!.status).toBe('agreed');
  });

  it('人工补录、机器没有的字段也会进入汇总', () => {
    const rows = buildConsensus(pipeline, [byReviewer('A', [at('article.doi', '10.1/x', 'add')])]);
    const row = rows.find((r) => r.fieldPath === 'article.doi')!;
    expect(row.machineValue).toBeUndefined();
    expect(row.status).toBe('single');
  });

  it('v1 旧覆盖层（无 reviewer 字段）归一化为 legacy，不丢历史记录', () => {
    const legacy = overlay([at('article.country', 'Spain', 'confirm')]);
    expect(reviewerOf(legacy)).toBe(LEGACY_REVIEWER);
    expect(buildConsensus(pipeline, [legacy]).find((r) => r.fieldPath === 'article.country')!.opinions[0]!.reviewer)
      .toBe(LEGACY_REVIEWER);
  });
});

describe('annotation — 多人核对：合并与统计', () => {
  const pipeline = {
    'article.title': llmField('Acupuncture for fibromyalgia'),
    'article.country': llmField('Spain'),
  };

  it('一致时采用人工值；disputed 时保留机器原值、不替人裁决', () => {
    const merged = mergeConsensus(pipeline, [
      byReviewer('A', [at('article.country', 'Spain', 'confirm'), at('article.title', 'Title A')]),
      byReviewer('B', [at('article.country', 'China'), at('article.title', 'Title A')]),
    ]);

    const country = merged.find((m) => m.fieldPath === 'article.country')!;
    expect(country.value.raw).toBe('Spain');       // disputed → 保留机器值
    expect(country.reviewStatus).toBe('disputed');
    expect(country.overridden).toBe(false);

    const title = merged.find((m) => m.fieldPath === 'article.title')!;
    expect(title.value.raw).toBe('Title A');       // agreed → 采用人工值
    expect(title.reviewStatus).toBe('agreed');
    expect(title.overridden).toBe(true);           // 与机器原值不同 = 真的改了
    expect(title.llmValue!.raw).toBe('Acupuncture for fibromyalgia');
    expect(title.decidedBy).toBe('human');
  });

  it('确认机器值不算改动', () => {
    const merged = mergeConsensus(pipeline, [
      byReviewer('A', [at('article.title', 'Acupuncture for fibromyalgia', 'confirm')]),
      byReviewer('B', [at('article.title', 'Acupuncture for fibromyalgia', 'confirm')]),
    ]);
    const title = merged.find((m) => m.fieldPath === 'article.title')!;
    expect(title.overridden).toBe(false);
    expect(title.decidedBy).toBe('human');
  });

  it('统计包含分歧数与"真正改掉"的数量', () => {
    const rows = buildConsensus(pipeline, [
      byReviewer('A', [at('article.country', 'Spain', 'confirm'), at('article.title', 'T1')]),
      byReviewer('B', [at('article.country', 'China'), at('article.title', 'T1')]),
    ]);
    expect(consensusStats(rows)).toEqual({
      total: 2, agreed: 1, disputed: 1, single: 0, machineOnly: 0, reviewed: 2, changed: 1,
    });
  });

  it('两两一致率只用"两人都表过态"的字段做分母', () => {
    const [pair] = pairwiseAgreement([
      byReviewer('A', [at('f1', 'x'), at('f2', 'y')]),
      byReviewer('B', [at('f1', 'x')]),           // B 没标 f2 → 不进分母
    ]);
    expect(pair!.reviewerA).toBe('A');
    expect(pair!.reviewerB).toBe('B');
    expect(pair!.common).toBe(1);
    expect(pair!.same).toBe(1);
    expect(pair!.rate).toBe(1);
  });

  it('没有共同字段时一致率为 null（不报 0%，避免误读为完全不一致）', () => {
    const [pair] = pairwiseAgreement([
      byReviewer('A', [at('f1', 'x')]),
      byReviewer('B', [at('f2', 'y')]),
    ]);
    expect(pair!.common).toBe(0);
    expect(pair!.rate).toBeNull();
  });

  it('逐核对人统计（界面进度面板用）', () => {
    const s = reviewerSummaries([
      byReviewer('B', [at('f1', 'x'), at('f2', 'y', 'add')]),
      byReviewer('A', [at('f1', 'x', 'confirm')]),
    ]);
    expect(s.map((x) => x.reviewer)).toEqual(['A', 'B']);
    expect(s[1]).toMatchObject({ total: 2, added: 1, overridden: 1, confirmed: 0 });
  });
});

