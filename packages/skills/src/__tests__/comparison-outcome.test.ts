import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ingest, findMiddleFile } from '@aa/ingest';
import { createComparisonSkill, COMPARISON_FIELD_MAP } from '../comparison.ts';
import { createOutcomeSkill, buildOutcomePathMap, buildOutcomeIdentityPathMap, buildOutcomeValuesPathMap, armStructureOf, TIMEPOINT_FIELD_MAP, TIMEPOINT_FIELDS_BY_KIND, VARIANCE_PREFERENCE } from '../outcome.ts';
import { createOutcomeValuesSkill, buildOutcomeValuePathMap } from '../outcome-values.ts';
import { createStubLlm } from '../llm.ts';
import { PROMPTS, OUTCOME_TASKS } from '../prompts.generated.ts';
import type { LlmInvoker, LlmResponse, MiniDoc, SkillContext } from '@aa/core';

const ROOT = resolve(__dirname, '../../../..');
const hasData = findMiddleFile(ROOT, '2015', '-2015-01') !== null;

let cached: MiniDoc | null = null;
const getDoc = (): MiniDoc => {
  cached ??= ingest({ rootDir: ROOT, year: '2015', studyId: '-2015-01' }).doc;
  return cached;
};

const fakeLlm = (json: unknown): LlmInvoker => ({
  async invoke(): Promise<LlmResponse> {
    return { text: JSON.stringify(json), json, model: 'fake' };
  },
});

const ctxOf = (doc: MiniDoc, llm: LlmInvoker, crossref?: SkillContext['crossref']): SkillContext => ({
  doc, llm, log: () => {},
  ...(crossref ? { crossref } : {}),
});

/* ==================== 提示词与映射同步（防回归） ==================== */

describe('comparison / outcome — 提示词与路径映射同步', () => {
  it('comparison：提示词模板里的键都在 COMPARISON_FIELD_MAP 中', () => {
    const t = PROMPTS.comparison;
    const tpl = t.slice(t.indexOf('## JSON 模板'), t.indexOf('## 常见错误'));
    // comparison 模板把字段嵌在 comparisons 数组元素里，缩进不固定 → 用宽松匹配
    const keys = [...tpl.matchAll(/"([A-Za-z][A-Za-z0-9]*)":\s*\{\s*"value"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(40);
    const missing = keys.filter((k) => !(k in COMPARISON_FIELD_MAP));
    expect(missing, `模板键未登记：${missing.join(', ')}`).toEqual([]);
  });

  it('数值层：提示词里的时点字段键都在 TIMEPOINT_FIELD_MAP 中', () => {
    // 时点字段定义与 JSON 模板都在数值层（outcomeValue / outcomeValueTask）
    const t = PROMPTS.outcomeValue;
    const tpl = OUTCOME_TASKS.value;
    const keys = ['estimateType', 'varianceType', 'experimentalEstimate', 'experimentalCiLower',
      'experimentalCiUpper', 'experimentalN', 'controlEstimate', 'controlCiLower',
      'controlCiUpper', 'controlN'];
    for (const k of keys) {
      expect(t, `提示词缺字段定义 ${k}`).toContain(k);
      expect(tpl, `取值模板缺键 ${k}`).toContain(`"${k}"`);
      expect(k in TIMEPOINT_FIELD_MAP, `TIMEPOINT_FIELD_MAP 缺 ${k}`).toBe(true);
    }
    // 结局字段层不再讲时点数值
    expect(OUTCOME_TASKS.item).not.toContain('"experimentalEstimate"');
  });

  it('outcome：两阶段任务模板里的键都被 SKILL 的映射表登记（否则字段被静默丢弃）', () => {
    // 阶段 1（识别）只有名称 + 工具；阶段 2（取值）含结局字段 + 随访 + 时点
    const idMap = buildOutcomeIdentityPathMap(0);
    const valMap = buildOutcomeValuesPathMap(0, ['baseline']);

    /**
     * 取模板里的**顶层**键（形如 `"key": { "value": …`）。
     * 缩进层级不固定，因此只取最小缩进的那一层，避免把 baseline 里的时点字段误当成顶层键。
     */
    const topKeys = (text: string): string[] => {
      const tpl = text.slice(text.indexOf('## JSON 模板'));
      const hits = [...tpl.matchAll(/^([ \t]*)"([A-Za-z][A-Za-z0-9]*)":\s*\{\s*"value"/gm)]
        .map((m) => ({ indent: m[1]!.length, key: m[2]! }));
      if (!hits.length) return [];
      const min = Math.min(...hits.map((h) => h.indent));
      return hits.filter((h) => h.indent === min).map((h) => h.key);
    };

    // 阶段 1 必须**只**输出两个键——这是防止响应被撑爆的关键约束
    expect(topKeys(OUTCOME_TASKS.list).sort()).toEqual(['instrument', 'outcomeName']);
    for (const k of topKeys(OUTCOME_TASKS.list)) {
      expect(`outcomes.0.${k}` in idMap, `识别阶段模板键未登记：${k}`).toBe(true);
    }

    const itemKeys = topKeys(OUTCOME_TASKS.item);
    expect(itemKeys.length).toBeGreaterThan(10);
    const missingVal = itemKeys.filter((k) => !(`outcomes.0.${k}` in valMap));
    expect(missingVal, `取值模板键未登记：${missingVal.join(', ')}`).toEqual([]);
  });

  it('outcome：路径映射覆盖三个时点块（每块 = 三类数值字段）', () => {
    const map = buildOutcomePathMap(0, ['baseline', 'endOfTreatment', 'followUpEnd']);
    /*
     * 每个时点注册的路径数 = 三类字段数之和（**不是** TIMEPOINT_FIELD_MAP 的并集大小）：
     * `experimentalN`/`controlN` 在 continuous / binary / categorical 里含义不同、各算一次。
     * 这正是修掉"二分类块的例数被映射进连续型块"之后的结果。
     */
    const perTimepoint = Object.values(TIMEPOINT_FIELDS_BY_KIND)
      .reduce((n, fields) => n + Object.keys(fields).length, 0);
    expect(perTimepoint).toBeGreaterThan(Object.keys(TIMEPOINT_FIELD_MAP).length);
    for (const tp of ['baseline', 'endOfTreatment', 'followUpEnd']) {
      expect(Object.keys(map).filter((k) => k.includes(`.${tp}.`)).length).toBe(perTimepoint);
    }
    // 路径必须带数组下标（保证多结局互不覆盖）
    expect(map['outcomes.0.baseline.continuous.estimateType']).toBe('timepoints.baseline.continuous.estimateType');
    expect(map['outcomes.0.followUpEnd.continuous.controlN']).toBe('timepoints.followUpEnd.continuous.control.n');
    // 二分类 / 等级资料：模型输出按类型分组，键里必须带类型这一层
    expect(map['outcomes.0.endOfTreatment.binary.experimentalEvents']).toBe('timepoints.endOfTreatment.binary.experimental.events');
    expect(map['outcomes.0.endOfTreatment.binary.differenceEstimate']).toBe('timepoints.endOfTreatment.binary.differenceEstimate');
    expect(map['outcomes.0.baseline.categorical.cat1Experimental']).toBe('timepoints.baseline.categorical.experimental.cat1');
    /*
     * ⚠️ 这条是"二分类结局每组例数"整列漏抽的根因回归：
     * 同一个 `experimentalN` 在 binary 块里必须落到 `binary.experimental.n`，
     * 不能因为键名相同就写进 `continuous.experimental.n`。
     */
    expect(map['outcomes.0.endOfTreatment.binary.experimentalN']).toBe('timepoints.endOfTreatment.binary.experimental.n');
    expect(map['outcomes.0.endOfTreatment.binary.controlN']).toBe('timepoints.endOfTreatment.binary.control.n');
    expect(map['outcomes.0.endOfTreatment.continuous.experimentalN']).toBe('timepoints.endOfTreatment.continuous.experimental.n');
  });

  it('outcome：只映射实际出现的时点（缺时点不编造路径）', () => {
    const map = buildOutcomePathMap(1, ['baseline']);
    expect(map['outcomes.1.baseline.continuous.estimateType']).toBeDefined();
    expect(map['outcomes.1.followUpEnd.continuous.estimateType']).toBeUndefined();
  });

  it('变异值优先级遵循11月修正（SD < CI < SE < IQR < 全距）', () => {
    expect(VARIANCE_PREFERENCE['3']).toBeLessThan(VARIANCE_PREFERENCE['2']!);
    expect(VARIANCE_PREFERENCE['2']).toBeLessThan(VARIANCE_PREFERENCE['1']!);
    expect(VARIANCE_PREFERENCE['1']).toBeLessThan(VARIANCE_PREFERENCE['4']!);
  });
});

/* ==================== comparison SKILL ==================== */

describe.skipIf(!hasData)('SKILL: comparison', () => {
  const realPayload = {
    comparisons: [
      {
        intervention: { value: 'acupuncture+usual pharmacological treatment', quote: 'individualised acupuncture', confidence: 0.9 },
        control: { value: 'sham acupuncture+usual pharmacological treatment', quote: 'sham acupuncture', confidence: 0.9 },
        controlType: { value: '非刺入假针刺', quote: 'simulation on the dorsal and lumbar regions', confidence: 0.8 },
        randomizationClass: { value: '计算机随机', quote: 'secure centralised telephone and fax randomisation', confidence: 0.7 },
        allocationClass: { value: '中心隐藏（电话、网站）', quote: 'administered at an independent clinical trials unit', confidence: 0.8 },
        frequencyDesc: { value: 'one per week', quote: 'one per week', confidence: 0.95 },
      },
    ],
  };

  it('落地为带证据的比较组，且编码由本地图例推导', async () => {
    const doc = getDoc();
    const out = await createComparisonSkill().run(ctxOf(doc, fakeLlm(realPayload)));

    expect(out.payload.comparisons).toHaveLength(1);
    const c = out.payload.comparisons[0]!;
    expect(c.studyId).toBe('2015-01');
    expect(c.intervention?.raw).toContain('acupuncture');
    expect(c.intervention!.evidence[0]!.page).toBeGreaterThanOrEqual(1);

    // 编码为确定性推导（provenance=deterministic, confidence=1）
    expect(c.controlType?.provenance).toBe('deterministic');
    expect(c.controlType?.code).toBe('2');   // 非刺入假针刺
    expect(c.allocationClass?.code).toBe('1'); // 中心隐藏
  });

  it('支持多比较组（数组下标编入路径，互不覆盖）', async () => {
    const doc = getDoc();
    const two = {
      comparisons: [
        { intervention: { value: 'A', quote: 'acupuncture', confidence: 0.9 }, control: { value: 'B', quote: 'sham acupuncture', confidence: 0.9 } },
        { intervention: { value: 'C', quote: 'fibromyalgia', confidence: 0.9 }, control: { value: 'D', quote: 'one per week', confidence: 0.9 } },
      ],
    };
    const out = await createComparisonSkill().run(ctxOf(doc, fakeLlm(two)));
    expect(out.payload.comparisons).toHaveLength(2);
    expect(out.payload.comparisons[0]!.intervention?.raw).toBe('A');
    expect(out.payload.comparisons[1]!.intervention?.raw).toBe('C');
    expect(out.payload.comparisons[1]!.control?.raw).toBe('D');
  });

  it('comparisons 为空时给出明确 issue，不产出空壳', async () => {
    const doc = getDoc();
    const out = await createComparisonSkill().run(ctxOf(doc, fakeLlm({ comparisons: [] })));
    expect(out.payload.comparisons).toEqual([]);
    expect(out.issues.some((i) => i.code === 'NO_COMPARISONS')).toBe(true);
  });

  it('幻觉 quote 的字段进入 unresolved，不进入 payload', async () => {
    const doc = getDoc();
    const out = await createComparisonSkill().run(ctxOf(doc, fakeLlm({
      comparisons: [{ intervention: { value: 'x', quote: 'This sentence is not in the paper at all about zebras', confidence: 0.99 } }],
    })));
    expect(out.payload.comparisons[0]!.intervention).toBeUndefined();
    expect(out.unresolved.length).toBe(1);
  });

  it('validate：干预与对照同名、例数不自洽会被标出', async () => {
    const doc = getDoc();
    const skill = createComparisonSkill();
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const issues = skill.validate!({
      skillId: 'comparison', level: 'comparison',
      payload: {
        comparisons: [{
          studyId: '2015-01',
          intervention: { raw: 'same', evidence: ev, provenance: 'model', confidence: 0.9 },
          control: { raw: 'same', evidence: ev, provenance: 'model', confidence: 0.9 },
          randomizedN: { raw: '164', evidence: ev, provenance: 'model', confidence: 0.9 },
          priorAcupunctureExperimental: { raw: '80', evidence: ev, provenance: 'model', confidence: 0.9 },
          priorAcupunctureControl: { raw: '82', evidence: ev, provenance: 'model', confidence: 0.9 },
        }],
      },
      unresolved: [], issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });

    expect(issues.some((i) => i.code === 'SAME_INTERVENTION_AND_CONTROL')).toBe(true);
    expect(issues.some((i) => i.code === 'SAMPLE_SIZE_INCONSISTENT')).toBe(true);   // 80+82≠164
  });

  it('validate：例数自洽时不报警', () => {
    const doc = getDoc();
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const issues = createComparisonSkill().validate!({
      skillId: 'comparison', level: 'comparison',
      payload: {
        comparisons: [{
          studyId: '2015-01',
          randomizedN: { raw: '162', evidence: ev, provenance: 'model', confidence: 0.9 },
          priorAcupunctureExperimental: { raw: '80', evidence: ev, provenance: 'model', confidence: 0.9 },
          priorAcupunctureControl: { raw: '82', evidence: ev, provenance: 'model', confidence: 0.9 },
          randomizedNExperimental: { raw: '78', evidence: ev, provenance: 'model', confidence: 0.9 },
          randomizedNControl: { raw: '81', evidence: ev, provenance: 'model', confidence: 0.9 },
        }],
      },
      unresolved: [], issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });
    expect(issues.filter((i) => i.code === 'SAMPLE_SIZE_INCONSISTENT')).toEqual([]);
  });

  it('流程图与正文报告不同的同口径人数时，保留两处证据并交人工复核', async () => {
    const text = 'We allocated 80 participants to acupuncture';
    const figureOcr = 'Allocated to acupuncture (n=79)';
    const doc: MiniDoc = {
      ...getDoc(),
      blocks: [
        { type: 'text', section: 'results', text, page: 2, index: 1, bbox: null },
        { type: 'figure', section: 'results', text: figureOcr, figureOcr, page: 3, index: 2, bbox: [0, 0, 100, 100] },
      ],
    };
    const output = await createComparisonSkill().run(ctxOf(doc, fakeLlm({
      comparisons: [{
        sampleSizeEvidence: { priorAcupunctureExperimental: [
          { value: '80', quote: text, source: { block: 1 } },
          { value: '79', quote: figureOcr, source: { block: 2 } },
        ] },
      }],
    })));
    expect(output.payload.comparisons[0]?.priorAcupunctureExperimental).toBeUndefined();
    expect(output.issues.find(issue => issue.code === 'SAMPLE_SIZE_SOURCE_CONFLICT')?.evidence
      ?.map(source => [source.kind, source.page])).toEqual([['text', 2], ['figure', 3]]);
  });

  it('validate：不适用场景填 NR 会被提示应填 NA', async () => {
    const doc = getDoc();
    const out = await createComparisonSkill().run(ctxOf(doc, fakeLlm({
      comparisons: [{
        stimulationType: { value: '4', quote: 'acupuncture', confidence: 0.9 },
        insertionDepthText: { value: 'NR', quote: 'acupuncture', confidence: 0.9 },
      }],
    })));
    expect(out.issues.some((i) => i.code === 'SHOULD_BE_NA')).toBe(true);
  });
});

/* ==================== outcome SKILL ==================== */

/**
 * 结局 SKILL 是**两阶段**调用：第 1 次枚举结局指标（只含元信息），
 * 之后每个结局各一次调用取数值。因此测试用的 LLM 必须按调用次序返回不同载荷。
 */
const phaseLlm = (listJson: unknown, valuesJson: readonly unknown[]): LlmInvoker & { readonly prompts: string[] } => {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    async invoke(req): Promise<LlmResponse> {
      prompts.push(req.user);
      const json = n === 0 ? listJson : (valuesJson[n - 1] ?? {});
      n++;
      return { text: JSON.stringify(json), json, model: 'fake' };
    },
  };
};

describe.skipIf(!hasData)('SKILL: outcome', () => {
  it('两阶段：先枚举再逐个取值，第 2 次调用的任务里带上了该结局的身份', async () => {
    const doc = getDoc();
    const llm = phaseLlm(
      { outcomes: [{ outcomeName: { value: 'pain', quote: 'fibromyalgia', confidence: 0.9 }, instrument: { value: 'VAS', quote: 'visual analogue scale', confidence: 0.9 } }] },
      [{ endOfTreatment: { continuous: { experimentalEstimate: { value: '-41', quote: '−41.0%', confidence: 0.9 } } } }],
    );
    const out = await createOutcomeSkill().run(ctxOf(doc, llm));

    expect(llm.prompts).toHaveLength(2);
    // 第 2 次调用的用户消息：材料在前、任务在后，且任务里填入了结局身份
    expect(llm.prompts[1]).toContain('抽 取**指定结局**'.replace(' ', ''));
    expect(llm.prompts[1]).toContain('pain');
    expect(llm.prompts[1]).toContain('VAS');
    expect(out.payload.outcomes).toHaveLength(1);
    expect(out.payload.outcomes[0]!.timepoints?.endOfTreatment?.continuous?.experimental?.estimate?.raw).toBe('-41');
  });

  it('某个结局取值失败不影响其他结局（截断/解析错误被隔离）', async () => {
    const doc = getDoc();
    let n = 0;
    const llm: LlmInvoker = {
      async invoke(): Promise<LlmResponse> {
        n++;
        if (n === 1) {
          const json = { outcomes: [
            { outcomeName: { value: 'pain', quote: 'fibromyalgia', confidence: 0.9 } },
            { outcomeName: { value: 'depression', quote: 'depression', confidence: 0.9 } },
          ] };
          return { text: JSON.stringify(json), json, model: 'fake' };
        }
        if (n === 2) throw new Error('输出被 max_tokens 截断');
        const json = { endOfTreatment: { continuous: { controlN: { value: '81', quote: 'individualised acupuncture', confidence: 0.9 } } } };
        return { text: JSON.stringify(json), json, model: 'fake' };
      },
    };
    const out = await createOutcomeSkill().run(ctxOf(doc, llm));

    expect(out.payload.outcomes).toHaveLength(2);
    expect(out.issues.some((i) => i.code === 'OUTCOME_ITEM_FAILED')).toBe(true);
    // 第 2 个结局仍然拿到了数值
    expect(out.payload.outcomes[1]!.timepoints?.endOfTreatment?.continuous?.control?.n?.raw).toBe('81');
  });

  it('落地嵌套时点结构，数值来自表格证据', async () => {
    const doc = getDoc();
    const listPayload = {
      outcomes: [
        {
          outcomeName: { value: 'fibromyalgia', quote: 'diagnosed with fibromyalgia', confidence: 0.9 },
          instrument: { value: 'VAS', quote: 'visual analogue scale', confidence: 0.9 },
        },
      ],
    };
    const valuesPayload = {
      // 阶段 2 负责结局自身字段（编码/范围/方向/类型…）
      measurementRange: { value: '0-100', quote: '0–100 mm', confidence: 0.9 },
      measurementDirection: { value: '0', quote: 'visual analogue scale', confidence: 0.8 },  // 0=数值越小越好
      measurementType: { value: '2', quote: 'change in pain intensity', confidence: 0.8 },  // 2=组间差值
      // 注意：quote 必须真实存在于该 PDF 里（本文写的是 12 months，没有 42 weeks）
      followUpDescription: { value: '12 months', quote: '12 months', confidence: 0.9 },
      followUpValue: { value: '12', quote: '12 months', confidence: 0.9 },
      followUpUnit: { value: '2', quote: '12 months', confidence: 0.9 },
      endOfTreatment: {
        continuous: {
          estimateType: { value: '3', quote: 'change in pain intensity', confidence: 0.8 },  // 3=组内差值
          varianceType: { value: '2', quote: '95% CI', confidence: 0.9 },  // 2=95%CI
          experimentalEstimate: { value: '-41', quote: '−41.0%', confidence: 0.95 },
          experimentalCiLower: { value: '-47.2', quote: '−47.2%', confidence: 0.95 },
          experimentalCiUpper: { value: '-34.8', quote: '−34.8%', confidence: 0.95 },
          experimentalN: { value: '78', quote: 'sham acupuncture', confidence: 0.8 },
          controlEstimate: { value: '-27.1', quote: '−27.1%', confidence: 0.95 },
          controlCiLower: { value: '-33.2', quote: '−33.2%', confidence: 0.95 },
          controlCiUpper: { value: '-20.9', quote: '−20.9%', confidence: 0.95 },
          controlN: { value: '81', quote: 'individualised acupuncture', confidence: 0.8 },
        },
      },
    };
    const out = await createOutcomeSkill().run(ctxOf(doc, phaseLlm(listPayload, [valuesPayload])));

    expect(out.payload.outcomes).toHaveLength(1);
    const o = out.payload.outcomes[0]!;
    expect(o.outcome?.name?.raw).toBe('fibromyalgia');
    // 随访时间（金标准 follow_up 列）
    expect(o.followUp?.value?.raw).toBe('12');
    expect(o.followUp?.unit?.code).toBe('2');
    // 嵌套时点块
    const eot = o.timepoints?.endOfTreatment?.continuous;
    expect(eot).toBeDefined();
    expect(eot!.experimental?.estimate?.raw).toBe('-41');
    expect(eot!.experimental?.n?.raw).toBe('78');
    expect(eot!.control?.estimate?.raw).toBe('-27.1');
    // 编码为确定性推导
    expect(eot!.estimateType?.provenance).toBe('deterministic');
    expect(eot!.estimateType?.code).toBe('3');   // 组内差值
    expect(eot!.varianceType?.code).toBe('2');   // 95%CI
    // 元字段编码
    expect(o.outcome?.measurementDirection?.code).toBe('0'); // 数值越小越好
  });

  it('缺时点不编造：未出现的时点键不产生路径', async () => {
    const doc = getDoc();
    const out = await createOutcomeSkill().run(ctxOf(doc, phaseLlm(
      { outcomes: [{ outcomeName: { value: 'x', quote: 'fibromyalgia', confidence: 0.9 } }] },
      [{ baseline: { continuous: { estimateType: { value: '均数', quote: 'fibromyalgia', confidence: 0.9 } } } }],
    )));
    const o = out.payload.outcomes[0]!;
    expect(o.timepoints?.baseline).toBeDefined();
    expect(o.timepoints?.followUpEnd).toBeUndefined();
    expect(o.timepoints?.endOfTreatment).toBeUndefined();
  });

  it('多结局互不覆盖（下标编入路径）', async () => {    const doc = getDoc();
    const out = await createOutcomeSkill().run(ctxOf(doc, phaseLlm(
      {
        outcomes: [
          { outcomeName: { value: 'pain', quote: 'fibromyalgia', confidence: 0.9 } },
          { outcomeName: { value: 'depression', quote: 'depression', confidence: 0.9 } },
        ],
      },
      [
        { baseline: { continuous: { experimentalN: { value: '80', quote: 'fibromyalgia', confidence: 0.9 } } } },
        { baseline: { continuous: { experimentalN: { value: '77', quote: 'depression', confidence: 0.9 } } } },
      ],
    )));

    expect(out.payload.outcomes).toHaveLength(2);
    expect(out.payload.outcomes[0]!.outcome?.name?.raw).toBe('pain');
    expect(out.payload.outcomes[1]!.outcome?.name?.raw).toBe('depression');
    // 两条互不覆盖
    expect(out.payload.outcomes[0]!.timepoints?.baseline?.continuous?.experimental?.n?.raw).toBe('80');
    expect(out.payload.outcomes[1]!.timepoints?.baseline?.continuous?.experimental?.n?.raw).toBe('77');
  });

  it('outcomes 为空时给出明确 issue', async () => {
    const doc = getDoc();
    const out = await createOutcomeSkill().run(ctxOf(doc, fakeLlm({ outcomes: [] })));
    expect(out.payload.outcomes).toEqual([]);
    expect(out.issues.some((i) => i.code === 'NO_OUTCOMES')).toBe(true);
  });

  /* ==================== 数值层 SKILL（outcome-values） ==================== */

  it('outcome-values：只产出时点块，并且只回填自己那一行', async () => {
    const doc = getDoc();
    const seen: string[] = [];
    const llm: LlmInvoker = {
      async invoke(req): Promise<LlmResponse> {
        const json = {
          endOfTreatment: {
            continuous: {
              estimateType: { value: '3', quote: 'change in pain intensity', confidence: 0.8 },
              varianceType: { value: '3', quote: 'Mean (SD)', confidence: 0.9 },
              // ⚠️ quote 必须能在原文里定位，且**长度 ≥ 6**（定位器对超短 quote 直接放弃），
              // 所以这里用行标签做引文，而不是 `−41.0` 这种 5 字符的数字片段。
              experimentalEstimate: { value: '-41', quote: 'PainVAS (T0–T1)', confidence: 0.95 },
              experimentalCiLower: { value: '15.7', quote: 'Mean (SD)', confidence: 0.9 },
              experimentalN: { value: '78', quote: 'fibromyalgia', confidence: 0.8 },
            },
          },
        };
        seen.push(req.user.slice(req.user.indexOf('## 本次任务')));
        return { text: JSON.stringify(json), json, model: 'fake' };
      },
    };
    const out = await createOutcomeValuesSkill({
      targets: [{ rowIndex: 0, name: 'pain intensity', instrument: 'PainVAS' }],
    }).run(ctxOf(doc, llm));

    expect(out.payload.values).toHaveLength(1);
    const v = out.payload.values[0]!;
    expect(v.rowIndex).toBe(0);
    const eot = v.timepoints?.endOfTreatment?.continuous;
    expect(eot!.experimental?.estimate?.raw).toBe('-41');
    // 单值型变异值（SD）只填下限——这是本层最大的一块修正
    expect(eot!.experimental?.ciLower?.raw).toBe('15.7');
    expect(eot!.experimental?.ciUpper).toBeUndefined();
    // 编码确定性推导
    expect(eot!.varianceType?.code).toBe('3');
    // 任务说明里必须代入结局身份
    expect(seen[0]).toContain('pain intensity');
    expect(seen[0]).toContain('PainVAS');
  });

  it('outcome-values：逐「结局 × 比较组」行调用，多臂试验不会互相复制', async () => {
    /*
     * 实测教训：曾按「名称|工具」去重（认为同一结局数值是同一份），
     * 结果 2015-04 三臂试验里比较组 2 直接复制了比较组 1 的值
     * （金标准要 B 行 −2.34，我们给了 A 行 −1.56）。
     */
    const doc = getDoc();
    const asked: string[] = [];
    const llm: LlmInvoker = {
      async invoke(req): Promise<LlmResponse> {
        asked.push(req.user.slice(req.user.indexOf('本次比较组')));
        // 按"问的是哪一对"返回不同的数值，模拟表格里的不同臂行
        const isSaam = req.user.includes('sa-am');
        const json = {
          baseline: {
            continuous: {
              experimentalN: { value: isSaam ? '55' : '54', quote: 'fibromyalgia', confidence: 0.9 },
            },
          },
        };
        return { text: JSON.stringify(json), json, model: 'fake' };
      },
    };
    const out = await createOutcomeValuesSkill({
      targets: [
        { rowIndex: 0, name: 'depression', instrument: 'BDI', comparison: { intervention: 'body acupuncture', control: 'usual care' } },
        { rowIndex: 1, name: 'depression', instrument: 'BDI', comparison: { intervention: 'sa-am acupuncture', control: 'usual care' } },
      ],
    }).run(ctxOf(doc, llm));

    // 两行各问一次（不去重）
    expect(asked).toHaveLength(2);
    // 比较组身份进了提示词
    expect(asked[0]).toContain('body acupuncture');
    expect(asked[1]).toContain('sa-am acupuncture');
    // 两行拿到不同的数值，而不是复制
    expect(out.payload.values[0]!.timepoints?.baseline?.continuous?.experimental?.n?.raw).toBe('54');
    expect(out.payload.values[1]!.timepoints?.baseline?.continuous?.experimental?.n?.raw).toBe('55');
  });

  it('outcome-values：结局没有可定位的名称/工具时跳过并给出 issue', async () => {
    const doc = getDoc();
    const out = await createOutcomeValuesSkill({
      targets: [{ rowIndex: 3, name: '', instrument: '' }],
    }).run(ctxOf(doc, fakeLlm({})));
    expect(out.payload.values).toEqual([]);
    expect(out.issues.some((i) => i.code === 'OUTCOME_UNIDENTIFIED')).toBe(true);
  });

  it('outcome-values：区间数值即使合理，也拦下来自同一行另一组的列', async () => {
    const doc: MiniDoc = {
      ...getDoc(),
      blocks: [{
        type: 'table', page: 2, index: 17, bbox: null, section: 'results', text: 'Table 2 Results',
        table: { html: '', grid: [
          ['Outcome', 'Acupuncture ITT', '', 'Sham ITT', ''],
          ['', 'Mean', '95% CI', 'Mean', '95% CI'],
          ['Pain', '10', '8 to 12', '11', '9 to 13'],
        ] },
      }],
    };
    const cell = (value: string, quote: string, row: number, column: number) => ({
      value, quote, source: { block: 17, row, column },
    });
    const skill = createOutcomeValuesSkill({ targets: [{ rowIndex: 0, name: 'pain', instrument: 'VAS' }] });
    const evaluate = (column: number, lower: string, upper: string) => skill.run(ctxOf(doc, fakeLlm({
      endOfTreatment: { continuous: {
        varianceType: cell('2', '95% CI', 2, 3),
        experimentalEstimate: cell('10', '10', 3, 2),
        experimentalCiLower: cell(lower, `${lower} to ${upper}`, 3, column),
        experimentalCiUpper: cell(upper, `${lower} to ${upper}`, 3, column),
      } },
    })));
    const wrong = await evaluate(5, '9', '13');
    expect(wrong.issues.some(issue => issue.code === 'CI_SOURCE_MISMATCH')).toBe(true);
    expect(wrong.payload.values[0]?.timepoints?.endOfTreatment?.continuous?.experimental?.ciLower).toBeUndefined();
    const right = await evaluate(3, '8', '12');
    expect(right.payload.values[0]?.timepoints?.endOfTreatment?.continuous?.experimental?.ciLower?.raw).toBe('8');
  });

  it('outcome-values：同口径的疗程后均值同时报告 SD 和 CI 时，选 SD', async () => {
    const grid = [
      ['结局', '试验组', '', '对照组', ''],
      ['', 'Mean (SD)', 'Mean (95% CI)', 'Mean (SD)', 'Mean (95% CI)'],
      ['VAS', '10 (2)', '10 (8 to 12)', '12 (3)', '12 (9 to 15)'],
    ];
    const doc: MiniDoc = { ...getDoc(), blocks: [{
      type: 'table', page: 2, index: 17, bbox: null, section: 'results', text: 'Table 2 Results',
      table: { html: '', grid },
    }] };
    const cell = (value: string, row: number, column: number) => ({
      value, quote: grid[row - 1]![column - 1]!, source: { block: 17, row, column },
    });
    const sdOrCi = (sd: boolean) => {
      const a = sd ? 2 : 3;
      const b = sd ? 4 : 5;
      return {
        estimateType: cell('1', 2, a), varianceType: cell(sd ? '3' : '2', 2, a),
        experimentalEstimate: cell('10', 3, a), controlEstimate: cell('12', 3, b),
        experimentalCiLower: cell(sd ? '2' : '8', 3, a), controlCiLower: cell(sd ? '3' : '9', 3, b),
        ...(sd ? {} : { experimentalCiUpper: cell('12', 3, a), controlCiUpper: cell('15', 3, b) }),
      };
    };
    const skill = createOutcomeValuesSkill({ targets: [{ rowIndex: 0, name: 'pain', instrument: 'VAS' }] });
    const output = await skill.run(ctxOf(doc, fakeLlm({
      endOfTreatment: { continuousCandidates: [sdOrCi(false), sdOrCi(true)] },
    })));
    const selected = output.payload.values[0];
    expect(selected?.preferredResult).toBe('postTreatment');
    expect(selected?.timepoints?.endOfTreatment?.continuous?.varianceType?.code).toBe('3');
    expect(selected?.timepoints?.endOfTreatment?.continuous?.experimental?.ciUpper).toBeUndefined();
  });

  it('outcome-values：validate 按变异值类型判定上下限（SD 单值不算残缺）', () => {
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const fv = (raw: string) => ({ raw, evidence: ev, provenance: 'model' as const, confidence: 0.9 });
    const mk = (varianceCode: string, lo?: string, hi?: string) => ({
      skillId: 'outcome-values', level: 'outcome' as const,
      payload: {
        values: [{
          rowIndex: 0,
          timepoints: {
            baseline: {
              continuous: {
                varianceType: { raw: varianceCode, code: varianceCode, evidence: ev, provenance: 'deterministic' as const, confidence: 1 },
                experimental: { estimate: fv('10'), ...(lo ? { ciLower: fv(lo) } : {}), ...(hi ? { ciUpper: fv(hi) } : {}) },
              },
            },
          },
        }],
      },
      unresolved: [],
    });
    const codes = (o: ReturnType<typeof mk>) =>
      createOutcomeValuesSkill({ targets: [] })
        .validate!(o as unknown as Parameters<NonNullable<ReturnType<typeof createOutcomeValuesSkill>['validate']>>[0], ctxOf(getDoc(), fakeLlm({})))
        .map((i) => i.code);

    // SD(=3) 是单值型：只有下限是正常的
    expect(codes(mk('3', '15.7'))).not.toContain('CI_INCOMPLETE');
    // 单值型却给了上下限 → 疑似串列
    expect(codes(mk('3', '15.7', '20.1'))).toContain('VARIANCE_BOTH_BOUNDS_UNEXPECTED');
    // 95%CI(=2) 是双边界型：只填一半要报
    expect(codes(mk('2', '9'))).toContain('CI_INCOMPLETE');
    // SD 的数值不该被当成区间去要求"包住估计值"
    expect(codes(mk('3', '15.7'))).not.toContain('ESTIMATE_OUTSIDE_CI');
  });

  /*
   * 金标准 Sheet3 是「(比较组 × 结局指标) 一行」：
   * 2015-04（2 比较组 × 3 结局）有 6 行、2015-05（2×1）有 2 行，编号 EN007-111 / EN007-211。
   * 同一结局在不同比较组下数值相同、各占一行。
   */
  it('按比较组扇出：2 个比较组 → 每个结局各占一行，studyId 带比较组序号', async () => {
    const doc = getDoc();
    const list = { outcomes: [
      { outcomeName: { value: 'pain intensity', quote: 'fibromyalgia', confidence: 0.9 }, instrument: { value: 'VAS', quote: 'visual analogue scale', confidence: 0.9 } },
      { outcomeName: { value: 'depression', quote: 'depression', confidence: 0.9 }, instrument: { value: 'HDRS', quote: 'depression', confidence: 0.9 } },
    ] };
    const values = (n: string) => ({ endOfTreatment: { continuous: { experimentalN: { value: n, quote: 'fibromyalgia', confidence: 0.9 } } } });
    const out = await createOutcomeSkill({ comparisonCount: 2 })
      .run(ctxOf(doc, phaseLlm(list, [values('80'), values('80')])));

    expect(out.payload.outcomes).toHaveLength(4);   // 2 比较组 × 2 结局
    expect(out.payload.outcomes.map((o) => o.studyId)).toEqual([
      '2015-01-01', '2015-01-01', '2015-01-02', '2015-01-02',
    ]);
    // 同一结局在不同比较组下数值相同
    expect(out.payload.outcomes[0]!.timepoints?.endOfTreatment?.continuous?.experimental?.n?.raw).toBe('80');
    expect(out.payload.outcomes[2]!.timepoints?.endOfTreatment?.continuous?.experimental?.n?.raw).toBe('80');
    // ARMNU 由比较组数量确定性推导（2 个比较组 → 多臂）
    expect(out.payload.outcomes.every((o) => o.armNumber?.code === '2')).toBe(true);
    expect(out.payload.outcomes[0]!.armNumber?.provenance).toBe('deterministic');
  });

  it('单比较组：不扇出，studyId = articleId，ARMNU=1（双臂）', async () => {
    const doc = getDoc();
    const out = await createOutcomeSkill({ comparisonCount: 1 }).run(ctxOf(doc, phaseLlm(
      { outcomes: [{ outcomeName: { value: 'pain', quote: 'fibromyalgia', confidence: 0.9 } }] },
      [{ endOfTreatment: { continuous: { experimentalN: { value: '78', quote: 'fibromyalgia', confidence: 0.9 } } } }],
    )));
    expect(out.payload.outcomes).toHaveLength(1);
    expect(out.payload.outcomes[0]!.studyId).toBe('2015-01');
    expect(out.payload.outcomes[0]!.armNumber?.code).toBe('1');
  });

  it('armStructureOf：比较组数量 → ARMNU 编码', () => {
    expect(armStructureOf(1)).toBe('1');
    expect(armStructureOf(2)).toBe('2');
    expect(armStructureOf(4)).toBe('2');
  });

  it('数值层提示词要求把疗效数据填进疗程结束/随访，而不是只填 baseline', () => {
    expect(OUTCOME_TASKS.value).toMatch(/只填 baseline/);
    expect(OUTCOME_TASKS.value).toMatch(/不得.*用 baseline 顶替/);
    // 变异值的真实语义（SD/SE 是单值，只填下限）必须写进数值层
    expect(OUTCOME_TASKS.value).toMatch(/变异值/);
    expect(OUTCOME_TASKS.value).toMatch(/SD/);
  });

  it('validate：CI 反了 / 估计值落在 CI 外 / 例数非整数 会被标出', () => {
    const doc = getDoc();
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const fv = (raw: string) => ({ raw, evidence: ev, provenance: 'model' as const, confidence: 0.9 });
    const issues = createOutcomeSkill().validate!({
      skillId: 'outcome', level: 'outcome',
      payload: {
        outcomes: [{
          studyId: '2015-01',
          outcome: { name: fv('pain') },
          timepoints: {
            endOfTreatment: {
              continuous: {
                varianceType: { ...fv('2'), code: '2' },
                experimental: { estimate: fv('10'), ciLower: fv('20'), ciUpper: fv('5'), n: fv('78.5') },
              },
            },
          },
        }],
      },
      unresolved: [], issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });

    expect(issues.some((i) => i.code === 'CI_INVERTED')).toBe(true);
    expect(issues.some((i) => i.code === 'N_NOT_INTEGER')).toBe(true);
  });

  it('validate：估计值在 CI 内且例数为整数时不报警', () => {
    const doc = getDoc();
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const fv = (raw: string) => ({ raw, evidence: ev, provenance: 'model' as const, confidence: 0.9 });
    const issues = createOutcomeSkill().validate!({
      skillId: 'outcome', level: 'outcome',
      payload: {
        outcomes: [{
          studyId: '2015-01',
          outcome: { name: fv('pain') },
          timepoints: {
            endOfTreatment: { continuous: { experimental: { estimate: fv('-41'), ciLower: fv('-47.2'), ciUpper: fv('-34.8'), n: fv('78') } } },
          },
        }],
      },
      unresolved: [], issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });
    expect(issues.filter((i) => ['CI_INVERTED', 'ESTIMATE_OUTSIDE_CI', 'N_NOT_INTEGER'].includes(i.code))).toEqual([]);
  });

  it('validate：有随访无疗程结束 → 提示时点可能归错', () => {
    const doc = getDoc();
    const ev = [{ kind: 'text' as const, page: 1, bbox: null, quote: 'x' }];
    const issued = createOutcomeSkill().validate!({
      skillId: 'outcome', level: 'outcome',
      payload: {
        outcomes: [{
          studyId: '2015-01',
          outcome: { name: { raw: 'pain', evidence: ev, provenance: 'model', confidence: 0.9 } },
          timepoints: { followUpEnd: { continuous: {} } },
        }],
      },
      unresolved: [], issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });
    expect(issued.some((i) => i.code === 'MISSING_END_OF_TREATMENT')).toBe(true);
  });

  it('变异值类型选了低优先级（如 SD）会被提示复核', async () => {
    const doc = getDoc();
    const out = await createOutcomeSkill().run(ctxOf(doc, phaseLlm(
      { outcomes: [{ outcomeName: { value: 'pain', quote: 'fibromyalgia', confidence: 0.9 } }] },
      [{ endOfTreatment: { continuous: { varianceType: { value: '5', quote: 'fibromyalgia', confidence: 0.9 } } } }],  // 5=全距，低优先级
    )));
    expect(out.issues.some((i) => i.code === 'VARIANCE_TYPE_LOW_PRIORITY')).toBe(true);
  });
});
