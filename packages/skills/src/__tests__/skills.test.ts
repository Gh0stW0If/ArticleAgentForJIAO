import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ingest, findMiddleFile } from '@aa/ingest';
import { createArticleMetaSkill } from '../article-meta.ts';
import { createStubLlm, LlmNotConfiguredError, createLlmRecorder, requestKey } from '../llm.ts';
import { collectMaterials, parseAnchors } from '../materials.ts';
import { groundField, groundResponse } from '../grounding.ts';
import { decode, legendFor, renderLegendHints } from '../legend.ts';
import type { LlmInvoker, LlmRequest, LlmResponse, MiniDoc, MiniDocBlock, CrossrefClient } from '@aa/core';

const ROOT = resolve(__dirname, '../../../..');
const hasData = findMiddleFile(ROOT, '2015', '-2015-01') !== null;

let cachedDoc: MiniDoc | null = null;
const getDoc = (): MiniDoc => {
  cachedDoc ??= ingest({ rootDir: ROOT, year: '2015', studyId: '-2015-01' }).doc;
  return cachedDoc;
};

/* ============================ legend 解码 ============================ */

describe('legend — 确定性编码解码', () => {
  it('已登记的图例可查到', () => {
    expect(legendFor('conditionSystem')?.codes['1']).toContain('肌肉骨骼');
    expect(legendFor('countryClass')?.codes['2']).toContain('西方');
    expect(legendFor('controlType')?.codes['2']).toBe('非刺入假针刺');
  });

  it('本身是合法编码时直接采用', () => {
    expect(decode('conditionSystem', '1').code).toBe('1');
    expect(decode('countryClass', '2').code).toBe('2');
  });

  it('复合编码（金标准里有 2/5、1/3 这类值）', () => {
    const r = decode('controlTypeConverted', '2/5');
    expect(r.code).toBe('2/5');
    expect(r.meaning).toContain('Non-penetrating');
    expect(r.meaning).toContain('usual care');
  });

  it('按含义关键词反查', () => {
    expect(decode('countryClass', '西方').code).toBe('2');
    expect(decode('acupunctureType', '耳针').code).toBe('7');
    expect(decode('stimulationType', '电针').code).toBe('2');
  });

  it('无法映射时返回 none 并说明原因，绝不瞎猜', () => {
    const r = decode('countryClass', 'Atlantis');
    expect(r.code).toBeUndefined();
    expect(r.method).toBe('none');
    expect(r.note).toContain('无法把');
  });

  it('未登记图例的字段明确说明缺图例', () => {
    const r = decode('someUnknownField', '1');
    expect(r.method).toBe('none');
    expect(r.note).toContain('无图例');
  });

  it('渲染图例提示供模型参考', () => {
    const hints = renderLegendHints(['countryClass', 'controlType']);
    expect(hints).toContain('1=东方');
    expect(hints).toContain('2=非刺入假针刺');
  });
});

/* ========================== LLM 接口留空 ========================== */

describe('llm — 接口留空的桩实现', () => {
  it('桩实现显式失败，而不是返回假成功', async () => {
    const llm = createStubLlm();
    expect(llm.kind).toBe('stub');
    await expect(llm.invoke({ system: 's', user: 'u', tag: 't' })).rejects.toThrow(LlmNotConfiguredError);
  });

  it('错误信息指向交接契约', async () => {
    const llm = createStubLlm();
    await expect(llm.invoke({ system: 's', user: 'u', tag: 'tag-x' })).rejects.toThrow(/packages\/skills\/src\/llm\.ts/);
  });

  it('录制/回放：指纹稳定', () => {
    const req: LlmRequest = { system: 'a', user: 'b', tag: 't' };
    expect(requestKey(req)).toBe(requestKey({ ...req }));
    expect(requestKey(req)).not.toBe(requestKey({ ...req, user: 'c' }));
  });

  it('回放未命中时报错，不静默漏字段', async () => {
    const rec = createLlmRecorder([]);
    await expect(rec.invoke({ system: 's', user: 'u', tag: 't' })).rejects.toThrow(/回放未命中/);
  });
});

/* ====================== grounding：证据不变量 ====================== */

describe.skipIf(!hasData)('grounding — 模型输出落地', () => {
  it('无 quote 的字段被拒绝，转入 unresolved（不伪造坐标）', () => {
    const doc = getDoc();
    const r = groundField(doc, 'condition', { value: 'fibromyalgia', confidence: 0.9 });
    expect(r.field).toBeUndefined();
    expect(r.unresolved?.reason).toContain('未提供支撑原文');
  });

  it('quote 是幻觉（文档里没有）时被拒绝', () => {
    const doc = getDoc();
    const r = groundField(doc, 'condition', {
      value: 'made up',
      quote: 'This sentence definitely does not appear anywhere in the paper about zebras',
      confidence: 0.95,
    });
    expect(r.field).toBeUndefined();
    expect(r.unresolved?.reason).toMatch(/无法在文档中定位|幻觉/);
  });

  it('真实 quote 落地成功并带 bbox', () => {
    const doc = getDoc();
    const r = groundField(doc, 'title', {
      value: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial',
      quote: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial',
      confidence: 0.98,
    });
    expect(r.field).toBeDefined();
    expect(r.field!.evidence.length).toBe(1);
    expect(r.field!.evidence[0]!.page).toBe(1);
    expect(r.field!.evidence[0]!.bbox).not.toBeNull();
    expect(r.field!.provenance).toBe('model');
  });

  it('置信度低于阈值时转入 unresolved 但保留证据', () => {
    const doc = getDoc();
    const r = groundField(
      doc,
      'condition',
      { value: 'fibromyalgia', quote: 'fibromyalgia', confidence: 0.2 },
      { minConfidence: 0.5 },
    );
    expect(r.field).toBeUndefined();
    expect(r.unresolved?.evidence.length).toBe(1);
  });

  it('批量落地：多值字段合并进 alternatives', () => {
    const doc = getDoc();
    const out = groundResponse<Record<string, unknown>>(
      doc,
      {
        funding: [
          { value: 'Fund A', quote: 'ISRCTN60217348', confidence: 0.8 },
          { value: 'Fund B', quote: 'Trial registration number', confidence: 0.8 },
        ],
      },
      { funding: 'funding1' },
    );
    const f = out.payload.funding1 as { raw: string; alternatives?: unknown[] } | undefined;
    expect(f).toBeDefined();
    expect(f!.raw).toBe('Fund A');
    expect(f!.alternatives?.length).toBe(1);
  });
});

/* ========================= materials 裁剪 ========================= */

describe.skipIf(!hasData)('materials — 证据材料裁剪', () => {
  it('只取指定章节，且每块带锚点', () => {
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['metadata', 'abstract'], tables: false, figures: false });
    expect(m.blocks.length).toBeGreaterThan(0);
    expect(m.text).toMatch(/\[\[b\d+\|p\d+\]\]/);
    // 不应包含表格块
    expect(m.blocks.some((b) => b.type === 'table')).toBe(false);
    // 不应包含参考文献
    expect(m.blocks.some((b) => b.section === 'references')).toBe(false);
  });

  it('锚点可被解析回块号（用于审计模型是否真读了材料）', () => {
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['abstract'] });
    const anchors = parseAnchors(m.text);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(doc.blocks.some((b) => b.index === a)).toBe(true);
  });

  it('表格材料转成 Markdown 网格（控制 token）', () => {
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['results'], tables: true });
    const tb = m.blocks.find((b) => b.type === 'table' && b.markdown);
    expect(tb).toBeDefined();
    expect(tb!.markdown).toContain('| --- |');
    expect(tb!.hasGrid).toBe(true);
  });

  it('总量超限时截断并记录 trimmed', () => {
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['methods', 'results', 'discussion'], maxTotalChars: 2000 });
    expect(m.chars).toBeLessThanOrEqual(2000);
    expect(m.trimmed).toBeGreaterThan(0);
  });

  it('表格不受章节过滤——结果表被 MinerU 排到 DISCUSSION 之后也必须保留', () => {
    /*
     * 实测（2015-01）：核心结果表 `Table 2 Evaluation of outcome measures`（含全部结局的
     * 效应量与 95%CI）在 MinerU 阅读顺序里排在 `DISCUSSION` 标题之后，section 成了
     * `discussion`，于是被 `sections:['results','methods','abstract']` 整块滤掉——模型看不到表，
     * 只能答 NR，审计也无法纠正。表格是内容，必须保留。
     */
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['abstract', 'methods'], tables: true });
    const tables = m.blocks.filter((b) => b.type === 'table');
    expect(tables.length).toBeGreaterThan(0);
    // 但明显不是内容的章节（参考文献）里的表格块仍要排除
    expect(m.blocks.some((b) => b.type === 'table' && b.section === 'references')).toBe(false);
  });

  it('不请求表格时，表格块一个都不进材料', () => {
    const doc = getDoc();
    const m = collectMaterials(doc, { sections: ['results', 'discussion'], tables: false });
    expect(m.blocks.some((b) => b.type === 'table')).toBe(false);
  });

  /* ---------- 媒体保真：表格/图片一张都不能丢（上游硬要求） ---------- */

  /** 造一份最小 MiniDoc，用于精确控制块与预算。 */
  const mkDoc = (blocks: MiniDocBlock[]): MiniDoc => ({
    schemaVersion: 'AA_MINIDOC/1.0', year: '2015', articleId: 't-01',
    sourcePdf: 'x.pdf', mineruDir: 'build/mineru', pages: [], blocks,
    stats: { totalBlocks: blocks.length, droppedNoise: 0, tables: 0, figures: 0, equations: 0, pagesCovered: 1 },
    warnings: [],
  });
  const mkBlock = (index: number, type: MiniDocBlock['type'], section: MiniDocBlock['section'], text: string, extra: Partial<MiniDocBlock> = {}): MiniDocBlock => ({
    index, type, section, text, page: 1, bbox: [0, 0, 100, 100], ...extra,
  });

  it('超容量时先丢正文、表格留到最后（补充材料表排在末尾也不能被丢）', () => {
    // 实测 2015-02：eTable 1（结局数据表）排在参考文献之后，按"从后往前丢"第一个被丢
    const prose = 'x'.repeat(3000);
    const doc = mkDoc([
      mkBlock(0, 'text', 'results', prose),
      mkBlock(1, 'text', 'discussion', prose),
      mkBlock(2, 'table', 'results', 'Table 2 Outcome measures\nA\tB', {
        table: { html: '<table></table>', caption: 'Table 2 Outcome measures', grid: [['A', 'B'], ['1', '2']] },
      }),
    ]);
    const m = collectMaterials(doc, { tables: true, maxTotalChars: 1500 });
    const tables = m.blocks.filter((b) => b.type === 'table');
    expect(tables).toHaveLength(1);                 // 表格必须活下来
    expect(m.blocks.length).toBeLessThan(3);         // 丢的是正文块
    expect(m.trimmed).toBeGreaterThan(0);
  });

  it('真表格不因落在 references 章节而被丢，参考文献列表的"伪表格"仍要排除', () => {
    const doc = mkDoc([
      mkBlock(0, 'table', 'references', 'eTable 1 Symptom scores at baseline\nA\tB\tC', {
        table: { html: '<table></table>', caption: 'eTable 1 Symptom scores at baseline', grid: [['A', 'B', 'C'], ['1', '2', '3']] },
      }),
      mkBlock(1, 'table', 'references', 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial Vas J, et al.', {
        table: { html: '<table></table>', grid: [['Acupuncture for fibromyalgia'], ['Vas J']] },
      }),
    ]);
    const m = collectMaterials(doc, { sections: ['results'], tables: true });
    const kept = m.blocks.filter((b) => b.type === 'table').map((b) => b.index);
    expect(kept).toContain(0);        // eTable 1 是真表 → 保留
    expect(kept).not.toContain(1);    // 参考文献列表被误判成表 → 排除
  });

  it('text 为空但 html/grid 有内容的表格块同样不能被丢', () => {
    const doc = mkDoc([
      mkBlock(0, 'table', 'results', '', {
        table: { html: '<table><tr><td>1</td></tr></table>', grid: [['1']] },
      }),
    ]);
    const m = collectMaterials(doc, { sections: ['results'], tables: true });
    expect(m.blocks.filter((b) => b.type === 'table')).toHaveLength(1);
  });
});

/* ====================== article-meta SKILL ====================== */

/** 构造一个"模型"，按固定 JSON 回应，模拟真实回传。 */
function fakeLlm(json: unknown): LlmInvoker {
  return {
    async invoke(_req: LlmRequest): Promise<LlmResponse> {
      return { text: JSON.stringify(json), json, model: 'fake-model' };
    },
  };
}

/** 最小可用的 Crossref 假客户端（不打网络）。 */
const fakeCrossref: CrossrefClient = {
  async byDoi(doi: string) {
    return {
      doi,
      title: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial',
      containerTitle: 'Acupuncture in Medicine',
      issuedYear: '2015',
      authors: ['Jorge Vas'],
    };
  },
  async byTitle() { return []; },
};

describe.skipIf(!hasData)('SKILL: article-meta', () => {
  it('元信息齐备：字段带证据、编码由本地确定性推导', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ verifyWithCrossref: false });
    const out = await skill.run({
      doc,
      llm: fakeLlm({
        title: { value: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', quote: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', confidence: 0.98 },
        publicationYear: { value: '2015', quote: 'Acupunct Med 2016;34:257–266', confidence: 0.7 },
        language: { value: 'English', quote: 'Acupuncture for fibromyalgia in primary care', confidence: 0.6 },
        journal: { value: 'Acupuncture in medicine', quote: 'Acupunct Med 2016;34:257–266', confidence: 0.9 },
        firstAuthor: { value: 'Jorge Vas', quote: 'Jorge Vas', confidence: 0.95 },
        condition: { value: 'fibromyalgia', quote: 'diagnosed with fibromyalgia', confidence: 0.95 },
        country: { value: 'Spain', quote: 'three primary care centres in southern Spain', confidence: 0.9 },
      }),
      log: () => {},
    });

    expect(out.skillId).toBe('article-meta');
    expect(out.payload.title?.raw).toContain('fibromyalgia');
    expect(out.payload.title!.evidence[0]!.page).toBe(1);
    expect(out.payload.condition?.raw).toBe('fibromyalgia');

    // ⚠️ 关于 conditionSystem（疾病系统）：这是刻意的保守行为。
    // 图例给的是系统类别（1=肌肉骨骼和结缔组织疾病 …），而论文里写的是具体疾病名
    // （fibromyalgia）。要把 "fibromyalgia" 映射到 "1" 需要医学知识，属于**语义映射**，
    // 不是字符串匹配能可靠解决的。因此本地解码器拒绝猜，如实记录失败，
    // 让该字段留空并可被人工/后续 LLM 步骤处理——
    // 而不是产出一个看似正确、实则可能错误的编码（这类错误极难被发现）。
    expect(out.payload.conditionSystem).toBeUndefined();
    expect(out.issues.some((i) => i.code === 'CODE_DECODE_FAILED')).toBe(true);

    // 反过来：若模型给的是能确定性匹配的值，编码必须被推出且 provenance=deterministic
    const out2 = await createArticleMetaSkill({ verifyWithCrossref: false }).run({
      doc,
      llm: fakeLlm({
        country: { value: 'Spain', quote: 'three primary care centres in southern Spain', confidence: 0.9 },
      }),
      log: () => {},
    });
    expect(out2.payload.country?.raw).toBe('Spain');
    // Spain 属于西方，但图例是 1=东方/2=西方/3=东西方都有，同样需要地理知识
    // → 这里只断言"要么给出确定性编码，要么如实记录失败"，二者必居其一
    const coded = out2.payload.countryClass;
    const failed = out2.issues.some((i) => i.code === 'CODE_DECODE_FAILED');
    expect(Boolean(coded) !== Boolean(failed)).toBe(true);
    if (coded) {
      expect(coded.provenance).toBe('deterministic');
      expect(coded.confidence).toBe(1);
    }
  });

  it('模型未提供结构化 JSON 时给出明确 issue，不产出空结果', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ verifyWithCrossref: false });
    const out = await skill.run({
      doc,
      llm: { async invoke() { return { text: '抱歉我无法完成', model: 'x' }; } },
      log: () => {},
    });
    expect(out.payload).toEqual({});
    expect(out.issues.some((i) => i.code === 'NO_STRUCTURED_OUTPUT')).toBe(true);
  });

  it('幻觉 quote 的字段进入 unresolved，不出现在 payload 里', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ verifyWithCrossref: false });
    const out = await skill.run({
      doc,
      llm: fakeLlm({
        condition: { value: 'zebra flu', quote: 'The participants were all diagnosed with zebra influenza in Patagonia', confidence: 0.99 },
      }),
      log: () => {},
    });
    expect(out.payload.condition).toBeUndefined();
    expect(out.unresolved.length).toBe(1);
    expect(out.unresolved[0]!.reason).toMatch(/无法在文档中定位|幻觉/);
  });

  it('DOI 形态不合法时被丢弃并记 issue（防正文正则脏值）', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill({ verifyWithCrossref: false });
    const out = await skill.run({
      doc,
      llm: fakeLlm({
        doi: { value: '10.1136/acupmed-2015-010950group.bmj.com', quote: 'doi:10.1136/acupmed-2015-010950', confidence: 0.8 },
      }),
      log: () => {},
    });
    // normalizeDoi 会去掉尾随内容不了的域名部分 → 形态仍非法时丢弃
    const dropped = out.issues.some((i) => i.code === 'DOI_MALFORMED');
    const kept = out.payload.doi?.raw;
    // 二选一：要么丢弃并记 issue，要么规范化后保留为合法 DOI
    expect(dropped || (kept && !kept.includes('group.bmj.com'))).toBe(true);
  });

  it('接入 Crossref 后写入校验结果', async () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill();
    const out = await skill.run({
      doc,
      llm: fakeLlm({
        title: { value: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', quote: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', confidence: 0.98 },
        doi: { value: '10.1136/acupmed-2015-010950', quote: 'http://dx.doi.org/10.1136/acupmed-2015-010950', confidence: 0.9 },
        journal: { value: 'Acupuncture in medicine', quote: 'Acupunct Med 2016;34:257–266', confidence: 0.9 },
        publicationYear: { value: '2015', quote: 'Acupunct Med 2016;34:257–266', confidence: 0.8 },
      }),
      crossref: fakeCrossref,
      log: () => {},
    });
    expect(out.payload.crossref).toBeDefined();
    expect(out.payload.crossref!.verdict).toBe('match');
    expect(out.payload.crossref!.comparisons.some((c) => c.field === 'journal' && c.verdict === 'match')).toBe(true);
  });

  /* -------- 发表年份：以 DOI 的时间为准，Crossref 为最高置信度来源 -------- */

  it('年份规则：DOI 字符串里的年份优先（本文页脚写 2016、DOI 是 …-2015-…）', async () => {
    const doc = getDoc();
    const out = await createArticleMetaSkill().run({
      doc,
      llm: fakeLlm({
        // 模型照着页脚引文答 2016（`Acupunct Med 2016;34:257–266`）
        publicationYear: { value: '2016', quote: 'Acupunct Med 2016;34:257–266', confidence: 0.8 },
        doi: { value: '10.1136/acupmed-2015-010950', quote: 'doi:10.1136/acupmed-2015-010950', confidence: 0.9 },
      }),
      crossref: fakeCrossref,   // Crossref 对这篇只有 created 2016-02 / issued 2016-08
      log: () => {},
    });
    expect(out.payload.publicationYear?.raw).toBe('2015');
    expect(out.payload.publicationYear?.provenance).toBe('deterministic');
    expect(out.issues.some((i) => i.code === 'YEAR_FROM_DOI')).toBe(true);
    // 证据来自 DOI 所在块，可回溯
    expect(out.payload.publicationYear?.evidence[0]?.quote).toContain('acupmed-2015-010950');
  });

  it('年份规则：DOI 里没有年份时以 Crossref 为准（如 10.1177/0269215515578698）', async () => {
    const doc = getDoc();
    const out = await createArticleMetaSkill().run({
      doc,
      llm: fakeLlm({
        publicationYear: { value: '2016', quote: 'Accepted 23 December 2015', confidence: 0.8 },
        doi: { value: '10.1177/0269215515578698', quote: 'doi:10.1136/acupmed-2015-010950', confidence: 0.9 },   // 真实存在的 quote + 一个不含年份的 DOI
      }),
      crossref: {
        async byDoi() {
          return { doi: '10.1177/0269215515578698', title: 'x', issuedYear: '2015' };
        },
        async byTitle() { return []; },
      },
      log: () => {},
    });
    expect(out.payload.publicationYear?.raw).toBe('2015');
    expect(out.payload.publicationYear?.provenance).toBe('external');
    expect(out.issues.some((i) => i.code === 'YEAR_FROM_CROSSREF')).toBe(true);
  });

  it('年份规则：Crossref 与 DOI 一致时不产生无谓的覆盖 issue', async () => {
    const doc = getDoc();
    const out = await createArticleMetaSkill().run({
      doc,
      llm: fakeLlm({
        publicationYear: { value: '2015', quote: 'Accepted 23 December 2015', confidence: 0.8 },
        doi: { value: '10.1136/acupmed-2015-010950', quote: 'doi:10.1136/acupmed-2015-010950', confidence: 0.9 },
      }),
      crossref: fakeCrossref,
      log: () => {},
    });
    expect(out.payload.publicationYear?.raw).toBe('2015');
    expect(out.issues.some((i) => i.code === 'YEAR_FROM_DOI' || i.code === 'YEAR_FROM_CROSSREF')).toBe(false);
  });

  it('Crossref 命中时覆盖 title/journal/firstAuthor，且保留原值以便复核', async () => {
    const doc = getDoc();
    const out = await createArticleMetaSkill().run({
      doc,
      llm: fakeLlm({
        title: { value: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', quote: 'Acupuncture for fibromyalgia in primary care: a randomised controlled trial', confidence: 0.98 },
        journal: { value: 'Acupuncture in medicine', quote: 'Acupunct Med 2016;34: 257–266', confidence: 0.9 },
        doi: { value: '10.1136/acupmed-2015-010950', quote: 'doi:10.1136/acupmed-2015-010950', confidence: 0.9 },
      }),
      crossref: fakeCrossref,
      log: () => {},
    });
    expect(out.payload.journal?.provenance).toBe('external');
    expect(out.payload.journal?.confidence).toBe(1);
    // PDF 内的原值留在 comparisons 里，可人工复核
    const jc = out.payload.crossref?.comparisons.find((c) => c.field === 'journal');
    expect(jc?.pdfValue).toBeTruthy();
    expect(out.issues.some((i) => i.code === 'CROSSREF_OVERRIDE')).toBe(true);
  });

  it('Crossref 网络失败降级为 warning，不拖垮整个 SKILL', async () => {    const doc = getDoc();
    const skill = createArticleMetaSkill();
    const failing: CrossrefClient = {
      async byDoi() { throw new Error('network down'); },
      async byTitle() { throw new Error('network down'); },
    };
    const out = await skill.run({
      doc,
      llm: fakeLlm({ title: { value: 'x', quote: 'Acupuncture for fibromyalgia in primary care', confidence: 0.9 } }),
      crossref: failing,
      log: () => {},
    });
    expect(out.payload.title).toBeDefined();
    expect(out.issues.some((i) => i.code === 'CROSSREF_ERROR')).toBe(true);
  });

  it('validate：年份不合理与注册号格式异常会被标出', () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill();
    const issues = skill.validate!({
      skillId: 'article-meta',
      level: 'article',
      payload: {
        publicationYear: { raw: '1492', evidence: [{ kind: 'text', page: 1, bbox: null, quote: 'x' }], provenance: 'model', confidence: 0.9 },
        registrationIds: { raw: 'NOT-A-REAL-ID-123', evidence: [{ kind: 'text', page: 1, bbox: null, quote: 'x' }], provenance: 'model', confidence: 0.9 },
      },
      unresolved: [],
      issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });
    expect(issues.some((i) => i.code === 'YEAR_IMPLAUSIBLE')).toBe(true);
    expect(issues.some((i) => i.code === 'REG_ID_UNKNOWN_FORMAT')).toBe(true);
  });

  it('validate：合法注册号不报警', () => {
    const doc = getDoc();
    const skill = createArticleMetaSkill();
    const issues = skill.validate!({
      skillId: 'article-meta',
      level: 'article',
      payload: {
        registrationIds: { raw: 'ISRCTN60217348, NCT03391986', evidence: [{ kind: 'text', page: 1, bbox: null, quote: 'x' }], provenance: 'model', confidence: 0.9 },
      },
      unresolved: [],
      issues: [],
    }, { doc, llm: createStubLlm(), log: () => {} });
    expect(issues.filter((i) => i.code === 'REG_ID_UNKNOWN_FORMAT')).toEqual([]);
  });
});
