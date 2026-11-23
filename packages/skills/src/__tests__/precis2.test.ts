/**
 * PRECIS-2 SKILL 的纯逻辑测试。
 *
 * 评分本身需要真实材料与模型，不适合放单测；这里钉死三件**能确定性判定**的事：
 *   1. 05 的标签归一化（3B / 3-U / N/A / AS / 非法值）；
 *   2. 验证器对"3-U 与 3-B 混用、N/A 越界、未接地分数"的判定；
 *   3. 数值汇总只排除 N/A / AS，3-U 按 3 计入但单独计数。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeModelScore,
  summarizeDomains,
  createPrecis2Skill,
  PRECIS_DOMAINS,
  type PrecisPayload,
  type PrecisDomainResult,
} from '../precis2.ts';

describe('normalizeModelScore', () => {
  it('数字与数字字符串', () => {
    expect(normalizeModelScore('2')).toMatchObject({ label: '2', numeric: 2 });
    expect(normalizeModelScore(4)).toMatchObject({ label: '4', numeric: 4 });
  });

  it('3-B / 3B / 3-U / 3U', () => {
    expect(normalizeModelScore('3-B')).toMatchObject({ label: '3-B', numeric: 3 });
    expect(normalizeModelScore('3B')).toMatchObject({ label: '3-B', numeric: 3 });
    expect(normalizeModelScore('3-U')).toMatchObject({ label: '3-U', numeric: 3, uncertain: true });
    expect(normalizeModelScore('3U')).toMatchObject({ label: '3-U', numeric: 3, uncertain: true });
  });

  it('N/A 与 AS', () => {
    expect(normalizeModelScore('N/A')).toMatchObject({ label: 'N/A', numeric: null });
    expect(normalizeModelScore('na')).toMatchObject({ label: 'N/A', numeric: null });
    expect(normalizeModelScore('AS: Acupressure=1; Exercise=3-B')).toMatchObject({
      label: 'AS: Acupressure=1; Exercise=3-B',
      numeric: null,
      armSpecific: true,
    });
  });

  it('非法值标 invalid，不猜成 3', () => {
    expect(normalizeModelScore('mostly pragmatic')).toMatchObject({ invalid: true, numeric: null });
    expect(normalizeModelScore('')).toMatchObject({ label: null, numeric: null });
  });
});

const domain = (key: string, over: Partial<PrecisDomainResult> = {}): PrecisDomainResult => ({
  key: key as PrecisDomainResult['key'],
  label: '3',
  numeric: 3,
  quotes: ['quote'],
  evidence: [{ kind: 'text', page: 1, bbox: [0, 0, 1, 1], quote: 'quote' }],
  evidenceText: 'evidence',
  rationale: 'rationale',
  confidence: 0.8,
  grounded: true,
  ...over,
});

const payload = (over: Partial<PrecisPayload> = {}): PrecisPayload => ({
  usualCareContext: 'primary care',
  domains: Object.fromEntries(PRECIS_DOMAINS.map((d) => [d.key, domain(d.key)])),
  conflicts: [],
  ...over,
});

describe('summarizeDomains', () => {
  it('排除 N/A 与 AS，3-U 按 3 计入并单独计数', () => {
    const p = payload();
    p.domains.flex_adherence = domain('flex_adherence', { label: 'N/A', numeric: null });
    p.domains.flex_delivery = domain('flex_delivery', { label: 'AS: A=1; B=3', numeric: null, armSpecific: true });
    p.domains.eligibility = domain('eligibility', { label: '3-U', numeric: 3, uncertain: true });

    const s = summarizeDomains(p.domains);
    expect(s.scored).toBe(7);
    expect(s.notApplicable).toBe(1);
    expect(s.armSpecific).toBe(1);
    expect(s.uncertain).toBe(1);
    expect(s.numericTotal).toBe(21);
    expect(s.numericMean).toBe(3);
  });
});

describe('validate', () => {
  const skill = createPrecis2Skill();
  const ctx = {} as Parameters<NonNullable<typeof skill.validate>>[1];
  const codes = (p: PrecisPayload): string[] =>
    (skill.validate!({ skillId: 'precis2', level: 'cross-cutting', payload: p, unresolved: [], issues: [] }, ctx))
      .map((i) => i.code ?? '');

  it('干净输出不报错', () => {
    expect(codes(payload())).toEqual([]);
  });

  it('N/A 只允许灵活性-依从', () => {
    const p = payload();
    p.domains.setting = domain('setting', { label: 'N/A', numeric: null, absenceBased: true });
    expect(codes(p)).toContain('PRECIS_NA_OUTSIDE_ADHERENCE');
  });

  it('非 3-U/N/A 的分数没有引文要报未接地', () => {
    const p = payload();
    p.domains.recruitment = domain('recruitment', { evidence: [], grounded: false, absenceBased: false });
    expect(codes(p)).toContain('PRECIS_UNGROUNDED_SCORE');
  });

  it('3-U 允许没有引文（信息不足本来就没有可引原句）', () => {
    const p = payload();
    p.domains.recruitment = domain('recruitment', {
      label: '3-U', numeric: 3, uncertain: true, evidence: [], grounded: false, absenceBased: true,
    });
    expect(codes(p)).not.toContain('PRECIS_UNGROUNDED_SCORE');
  });

  it('3-B 与 uncertain 同时出现要报冲突', () => {
    const p = payload();
    p.domains.eligibility = domain('eligibility', { label: '3-B', numeric: 3, uncertain: true });
    expect(codes(p)).toContain('PRECIS_LABEL_CONFLICT');
  });

  it('缺领域要报', () => {
    const p = payload();
    delete p.domains.primary_analysis;
    expect(codes(p)).toContain('PRECIS_DOMAIN_MISSING');
  });
});
