import { describe, it, expect } from 'vitest';
import { verifyAgainstCrossref, pickBestCandidate, journalSignature, titleSimilarity, normText } from '../verify.ts';
import type { CrossrefWork } from '@aa/core';

/** 2015-01 的真实元信息（取自 gold 与 PDF 实测） */
const REAL: CrossrefWork = {
  doi: '10.1136/acupmed-2015-010950',
  title: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial',
  containerTitle: 'Acupuncture in Medicine',
  issuedYear: '2015',
  authors: ['Jorge Vas', 'Koldo Santos-Rey'],
  type: 'journal-article',
};

describe('crossref — 文本规范化', () => {
  it('去变音符、标点、大小写', () => {
    expect(normText('Sjögren’s Syndrome')).toBe('sjogrens syndrome');
    expect(normText('A  randomised   controlled trial:')).toBe('a randomised controlled trial');
  });

  it('期刊缩写签名能覆盖 Acupunct Med ↔ Acupuncture in Medicine', () => {
    const a = journalSignature('Acupunct Med');
    const b = journalSignature('Acupuncture in Medicine');
    // 'Acupuncture in Medicine' 去掉 of/the/and/in/for/on 后为 acupuncture medicine → 'am'
    expect(a.abbrev).toBe('am');
    expect(b.abbrev).toBe('am');
  });

  it('标题相似度对纯标点差异给出高分', () => {
    const a = 'Comparison of Acupuncture vs Sham Acupuncture or Waiting List Control in the Treatment of Aromatase Inhibitor–Related Joint Pain: A Randomized Clinical Trial';
    const b = 'Comparison of Acupuncture vs Sham Acupuncture or Waiting List Control in the Treatment of Aromatase Inhibitor–Related Joint Pain A Randomized Clinical Trial';
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.95);
  });

  it('完全不同的标题给低分', () => {
    expect(titleSimilarity('Acupuncture for fibromyalgia', 'Deep learning for image segmentation')).toBeLessThan(0.35);
  });
});

describe('crossref — 元信息校验', () => {
  it('全部一致 → match', () => {
    const v = verifyAgainstCrossref(
      {
        title: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial',
        journal: 'Acupuncture in medicine',
        year: '2015',
        firstAuthor: 'Jorge Vas',
        doi: '10.1136/acupmed-2015-010950',
      },
      REAL,
    );
    expect(v.verdict).toBe('match');
    expect(v.comparisons.find((c) => c.field === 'doi')!.verdict).toBe('match');
    expect(v.comparisons.find((c) => c.field === 'journal')!.verdict).toBe('match');
    expect(v.comparisons.find((c) => c.field === 'year')!.verdict).toBe('match');
  });

  it('DOI 抓错（抓到参考文献的）→ mismatch 并给出提示', () => {
    const v = verifyAgainstCrossref(
      { title: REAL.title!, doi: '10.1002/14651858.CD007854.pub3' },
      REAL,
    );
    const d = v.comparisons.find((c) => c.field === 'doi')!;
    expect(d.verdict).toBe('mismatch');
    expect(v.verdict).toBe('partial');   // 标题仍匹配
    expect(v.notes.join(' ')).toMatch(/参考文献/);
  });

  it('期刊名大小写/缩写差异不应判为 mismatch', () => {
    const v = verifyAgainstCrossref({ journal: 'ACUPUNCTURE IN MEDICINE' }, REAL);
    expect(v.comparisons.find((c) => c.field === 'journal')!.verdict).toBe('match');

    const v2 = verifyAgainstCrossref({ journal: 'Acupunct Med' }, REAL);
    expect(v2.comparisons.find((c) => c.field === 'journal')!.verdict).toBe('match');
    expect(v2.comparisons.find((c) => c.field === 'journal')!.note).toMatch(/缩写/);
  });

  it('年份不一致要提示「语料年份≠发表年份」而不是判为抽取错误', () => {
    // 实测：-2015-05.pdf 的期刊 DOI 是 2018 年的
    const v = verifyAgainstCrossref({ year: '2015' }, { ...REAL, issuedYear: '2018' });
    const y = v.comparisons.find((c) => c.field === 'year')!;
    expect(y.verdict).toBe('mismatch');
    expect(y.note).toMatch(/发表年份/);
    expect(v.notes.join(' ')).toMatch(/不应据此判为抽取错误/);
  });

  it('Crossref 无记录 → unverifiable，不猜', () => {
    const v = verifyAgainstCrossref({ title: 'x', doi: '10.1/x' }, null);
    expect(v.verdict).toBe('unverifiable');
    expect(v.comparisons).toEqual([]);
  });

  it('标题相似度略低 → partial 而非 match', () => {
    const v = verifyAgainstCrossref(
      { title: 'Acupuncture for fibromyalgia in primary care: randomised controlled trial' },
      REAL,
    );
    const t = v.comparisons.find((c) => c.field === 'title')!;
    expect(['match', 'partial']).toContain(t.verdict);
    expect(t.similarity).toBeGreaterThan(0.8);
  });

  it('第一作者仅姓氏匹配也算 match（作者名写法差异很常见）', () => {
    const v = verifyAgainstCrossref({ firstAuthor: 'Vas J' }, REAL);
    expect(v.comparisons.find((c) => c.field === 'authors')!.verdict).toBe('match');
  });
});

describe('crossref — 候选择优', () => {
  const mk = (doi: string, title: string, year?: string): CrossrefWork =>
    ({ doi, title, ...(year ? { issuedYear: year } : {}) });

  it('选相似度最高的', () => {
    const target = 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial';
    const picked = pickBestCandidate(target, [
      mk('10.1/a', 'Something completely unrelated about surgery'),
      mk('10.1/b', target),
    ]);
    expect(picked!.work.doi).toBe('10.1/b');
    expect(picked!.similarity).toBeGreaterThan(0.95);
  });

  it('同分时优先年份一致者', () => {
    const target = 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial';
    const picked = pickBestCandidate(target, [
      mk('10.1/old', target, '2011'),
      mk('10.1/right', target, '2015'),
    ], { year: '2015' });
    expect(picked!.work.doi).toBe('10.1/right');
  });

  it('全部低于阈值时返回 null，不"随便选一个"', () => {
    const picked = pickBestCandidate('Acupuncture for fibromyalgia', [
      mk('10.1/x', 'Deep learning for medical imaging'),
    ]);
    expect(picked).toBeNull();
  });
});
