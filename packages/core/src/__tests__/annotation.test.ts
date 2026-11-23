import { describe, it, expect } from 'vitest';
import {
  mergeOverlay, makeAnnotation, annotationStats, evidenceFromSelection,
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
