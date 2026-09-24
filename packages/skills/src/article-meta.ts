/**
 * @aa/skills — SKILL: 文章级元信息（article-meta）
 *
 * 对应金标准 Sheet1 的文章级字段 + Sheet2，以及需求 4（Crossref 校验）。
 *
 * 分级职责：
 *   - **模型**：从首页/摘要读懂题名、作者、期刊、国家、疾病名称等自由文本；
 *   - **确定性**：受控编码（疾病系统、国家分类、期刊分类…）由 legend.decode 推导；
 *               Crossref 校验由 @aa/crossref 完成；
 *               DOI 的形态校验（挡掉 "10.1136/…group.bmj.com" 这类脏值）也是确定性的。
 *
 * 关键约束：模型看不到坐标，只回传 quote；坐标由 grounding 层本地定位。
 */

import {
  type Evidence,
  type FieldValue,
  type Issue,
  type MiniDoc,
  type Skill,
  type SkillContext,
  type SkillOutput,
  type MiniDocBlock,
  warn,
} from '@aa/core';
import { resolveAndVerify, normalizeDoi, isLikelyDoi, type MetaVerification, type PdfMetaInput } from '@aa/crossref';
import { verifyWithEuropePmc, type EuropePmcVerification } from '@aa/europepmc';
import { PROMPTS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundResponse, type RawSkillResponse } from './grounding.ts';
import { decode } from './legend.ts';

/* ------------------------------ 输出结构 ------------------------------ */

export interface ArticleMetaPayload {
  title?: FieldValue;
  publicationYear?: FieldValue;
  language?: FieldValue;
  journal?: FieldValue;
  firstAuthor?: FieldValue;
  authorContact?: FieldValue;
  registrationReported?: FieldValue;
  /** PDF 内出现的注册号原文（如 ISRCTN60217348） */
  registrationIds?: FieldValue;
  condition?: FieldValue;
  country?: FieldValue;
  trialCenterCount?: FieldValue;
  funding1?: FieldValue;
  funding2?: FieldValue;
  /** 从 PDF 取得的 DOI */
  doi?: FieldValue;
  /**
   * 2019 影响因子。**由程序查 `Datas/IF-SCI-2019.xlsx` 得到**（论文里没有这个数），
   * 见 `opts.ifLookup` 与步骤 8。
   */
  impactFactor2019?: FieldValue;
  /** 受控编码（确定性推导，不是模型给的） */
  conditionSystem?: FieldValue;
  countryClass?: FieldValue;
  journalClass?: FieldValue;
  acuteOrSurgery?: FieldValue;
  /** Sheet2 的文章级结局分类描述 */
  studyOutcomes?: {
    primaryOutcome?: FieldValue;
    pain?: FieldValue;
    nonPain?: FieldValue;
    function?: FieldValue;
    qualityOfLife?: FieldValue;
    importantEvents?: FieldValue;
    mortality?: FieldValue;
    remarks?: FieldValue;
  };
  /** Crossref 校验结果 */
  crossref?: MetaVerification;
  /** Europe PMC 复核结果（第二独立源，只用于题名补全与冲突记录） */
  europepmc?: EuropePmcVerification;
  extra?: Record<string, FieldValue>;
}

/* ------------------------ 模型回传 → 规范字段 ------------------------ */

/**
 * JSON 键 → 规范字段名。
 *
 * 键名必须与 `tools/prompt_gen.mjs` 生成的 JSON 模板完全一致——
 * 提示词里给出的模板就是这份映射的来源（见 prompts.generated.ts）。
 * 未在此列出的键会被忽略（提示词已明确要求不要输出 gold_meta 字段）。
 */
const FIELD_MAP: Readonly<Record<string, string>> = {
  outliersInfluential: 'outliersInfluential',
  title: 'title',
  publicationYear: 'publicationYear',
  language: 'language',
  journal: 'journal',
  journalClass: 'journalClass',
  impactFactor2019: 'impactFactor2019',
  firstAuthor: 'firstAuthor',
  authorContact: 'authorContact',
  funding1: 'funding1',
  funding2: 'funding2',
  registrationReported: 'registrationReported',
  registrationIds: 'registrationIds',
  condition: 'condition',
  conditionSystem: 'conditionSystem',
  acuteOrSurgery: 'acuteOrSurgery',
  country: 'country',
  countryClass: 'countryClass',
  trialCenterCount: 'trialCenterCount',
  doi: 'doi',

  /*
   * Sheet2 的文章级结局分类（描述性文本）。
   *
   * 映射到 `studyOutcomes.<key>`：groundResponse 的 setDeep 会据此建出嵌套对象
   * `payload.studyOutcomes = { primaryOutcome: FieldValue, … }`，正好是契约要求的形状。
   * 曾漏掉这些键 → 模型返回了也没人接，Sheet2 七个字段全为空（实测 0%）。
   */
  primaryOutcome: 'studyOutcomes.primaryOutcome',
  outcomePain: 'studyOutcomes.pain',
  outcomeNonPain: 'studyOutcomes.nonPain',
  outcomeFunction: 'studyOutcomes.function',
  outcomeQualityOfLife: 'studyOutcomes.qualityOfLife',
  outcomeImportantEvents: 'studyOutcomes.importantEvents',
  outcomeMortality: 'studyOutcomes.mortality',
  /*
   * Sheet2 的「备注」列。金标准在已比对年份里填的全是 `NR`（没有一条真正的备注），
   * 而这张表以前**根本没问**这一列 → 52 处全被判"漏"（报告 §2.1.1）。
   */
  outcomeRemarks: 'studyOutcomes.remarks',
};

/** 需要确定性编码的字段 → 其原始值取自哪个已落地字段。 */
const CODE_SOURCES: readonly { target: keyof ArticleMetaPayload; from: keyof ArticleMetaPayload }[] = [
  { target: 'conditionSystem', from: 'condition' },
  { target: 'countryClass', from: 'country' },
  { target: 'journalClass', from: 'journal' },
];

/* ------------------------------ 提示词 ------------------------------ */

/**
 * 系统提示由 `tools/prompt_gen.mjs` 生成（见 prompts.generated.ts），
 * 内容包含：字段含义、来自单元格批注的填写要求、允许取值编码表、JSON 模板、常见错误。
 *
 * 之所以生成而不是手写：字段定义会随金标准演进，手写必然与 schema 漂移。
 * 生成的真源是 tools/canonical-field-map.mjs。
 */
const SYSTEM_PROMPT = PROMPTS.article;

const USER_TEMPLATE = (materials: string): string =>
  `以下是论文的材料（仅包含首页、摘要与作者信息等）。请按规则抽取文章级元信息。\n\n${materials}`;

/**
 * 邮箱模式（高精度，足以用来定点补料）。
 *
 * ⚠️ **必须用 `\s*`，不能用普通空格**。踩过这个坑：
 * PDF 文字层里邮箱经常**跨行断开**——实测 2024-03 是
 * `Corresponding Author: Lorenzo Cohen … (lcohen@\nmdanderson.org).`，
 * 2021-08 同理。把分隔符收紧成空格后，这类邮箱**一条都扫不到**，
 * 补料段变空、模型照旧答 NR，而当时误判成"模型明知而拒答"、白折腾了一轮提示词加固。
 * 换行出现在 `@` 两侧是 PDF 排版的常态，必须容忍。
 *
 * ⚠️ 同时必须容忍**点号两侧的空格**：`Charlie.xue@rmit. edu.au`、
 * `jorgef.vas. sspa@juntadeandalucia.es`（实测 2015 年两篇都是这样）。
 *
 * 匹配结果一律经 `replace(/\s+/g, '')` 归一化后再用；跨行拼接出假邮箱的风险很低
 * ——整条模式必须有 `@`，而几乎没有词以 `@` 开头。
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;
/** 与"通讯作者"相关的标记词，用于把候选按可信度排序。 */
const CORRESPONDING_RE = /(correspond(?:ence|ing)|通讯作者|通信作者|通訊作者|reprint)/i;

/**
 * 通讯作者邮箱的**全文定点补料**。
 *
 * ── 为什么需要（实测，见 `docs/16-author-contact.md`）────────────────
 * `collectMaterials` 的判据是「**章节命中 或 页码命中**」：
 * 只有 `metadata/abstract/funding/acknowledgements` 这四类章节，或前 `metaPages` 页的块才进材料。
 * 而通讯作者邮箱常常印在正文深处的"通讯作者脚注"里，MinerU 与章节追踪会把这个块归到
 * **`discussion` / `conclusion` / `references`**——章节不在白名单、页码又超出前 2 页，
 * 于是**整块被丢掉**，模型只能答 `NR`。
 *
 * 在 150 条"金标准确实是邮箱"的样本上实测：
 *   · 邮箱所在块**进得了材料**：96 条 → 加权正确率 **81.8%**；
 *   · 邮箱所在块**进不了材料**：17 条 → 加权正确率 **0.0%**（一条都没对）；
 *   · 落在这一类里的块章节分布：`discussion` 7 / `references` 6 / `conclusion` 4。
 *
 * ── 做法与取舍 ───────────────────────────────────────────────
 * 邮箱是**高精度模式**，用正则扫全文即可，不需要扩大材料窗口（discussion/references 动辄上万字符，
 * 全塞进去会挤掉真正有用的首页信息）。这里只把"扫到的邮箱 + 所在页/章节 + 是否挨着
 * correspondence 字样"作为一小段提示追加在材料末尾：
 *   · 模型仍要自己判断选哪一个（多作者时"通讯作者优先"的规则不变）；
 *   · 提示里**保留页码与章节**，便于它在 quote 里引用真实位置。
 */
function collectEmailHint(doc: MiniDoc): string | null {
  /** key = 小写去空格（用于去重）；display = 首次出现的原样（保留大小写，供模型照抄进 quote）。 */
  const found = new Map<string, { display: string; pages: Set<number>; sections: Set<string>; marked: boolean }>();
  for (const b of doc.blocks) {
    if (b.dropped) continue;
    const text = String(b.text ?? '');
    if (!text) continue;
    const marked = CORRESPONDING_RE.test(text);
    for (const m of text.match(EMAIL_RE) ?? []) {
      const display = m.replace(/\s+/g, '');
      const key = display.toLowerCase();
      const cur = found.get(key) ?? { display, pages: new Set<number>(), sections: new Set<string>(), marked: false };
      cur.pages.add(b.page);
      cur.sections.add(b.section);
      cur.marked ||= marked;
      found.set(key, cur);
    }
  }
  if (!found.size) return null;

  /* 有 correspondence 标记的排前面，其次按页号——让模型先看到最可能的那一个 */
  const list = [...found.values()]
    .sort((a, b) => (Number(b.marked) - Number(a.marked)) || (Math.min(...a.pages) - Math.min(...b.pages)))
    .slice(0, 20);

  const lines = list.map((x) => {
    const tag = x.marked ? '，同段出现 correspondence/通讯作者 字样' : '';
    return `- ${x.display}（p${[...x.pages].join(',')}，${[...x.sections].join('/')}${tag}）`;
  });
  return `--- 附：程序在**全文**中扫描到的邮箱（供 authorContact 参考）---\n`
    + `说明：这一段是程序正则扫描的结果，**不在上面材料的裁剪范围内**，因此可能包含材料之外的邮箱。`
    + `但它是**真实的证据**，不是提示或猜测——其中的邮箱确实印在这篇论文里，页码与章节就是它的位置。\n`
    + `选择规则：① 标了 correspondence / corresponding author / 通讯作者 的那个 ② 第一作者 ③ 若只有一个就取它；`
    + `只有下面**全是第三方邮箱**（如期刊编辑部、投稿系统）时才填 NR。\n`
    + `⚠️ 不要因为正文里出现「联系方式见文末」「Author affiliations and article information are listed at the end`
    + ` of this article」这类句子就填 NR——那句话恰恰说明邮箱在下面这段里。\n`
    + lines.join('\n');
}

/* ------------------------------ SKILL ------------------------------ */

/** 影响因子查表：期刊名 → 2019 影响因子（由 `tools/lib/if.mjs` 从 Datas 的 xlsx 建好注入）。 */
export type IfLookup = (journalName: string) => { journal: string; jif: string; how?: string } | null;

export interface ArticleMetaSkillOptions {
  /** 首页取 meta 时包含的页数，默认 2（覆盖首页与可能的续页） */
  metaPages?: number;
  /** 是否纳入摘要段 */
  includeAbstract?: boolean;
  /** 是否发起 Crossref 校验，默认 true（未提供 client 时跳过） */
  verifyWithCrossref?: boolean;
  /**
   * 是否发起 Europe PMC 复核，默认 true（未提供 client 时跳过）。
   *
   * 来源与策略见 `packages/europepmc/src/client.ts` 的文件头：**只做两件事**——
   * ① 题名补全（Crossref 常缺副标题，实测 27 篇题名失分里 20 篇是"Crossref 比 EPMC 短"）；
   * ② 冲突记录（不改值）。**不碰 `authorContact`**（EPMC 列每位作者的邮箱、无通讯作者标记，
   * "唯一邮箱"只有 42% 正确率，用了反而会引入错误）。
   */
  verifyWithEuropePmc?: boolean;
  /**
   * 影响因子查表函数。**不提供时该字段保持模型输出（可能编造），提供时一律以表为准。**
   * 论文里没有影响因子，只能查表——见 tools/if_index.mjs 与 docs/12-impact-factor.md。
   */
  ifLookup?: IfLookup;
}

/**
 * 找出"唯一一个带 correspondence 标记的邮箱"，供 `authorContact` 的确定性兜底使用。
 *
 * 返回 `null` 的条件（**一律不猜**）：
 *   · 全文没有任何邮箱；
 *   · 没有任何邮箱挨着 correspondence/通讯作者 字样（此时谁是通讯作者无法判定）；
 *   · **有两个及以上**不同的 candidate（多作者/多单位，属于要判断的情形，交回模型与人工）。
 *
 * `quote` 取该邮箱在块文本里的**原样片段**（含可能存在的 OCR 空格），
 * 这样它能被 `auditEvidence` 在原文里定位到——quote 定位不上就等于没有证据。
 */
function pickCorrespondingEmail(doc: MiniDoc): { email: string; quote: string; block: MiniDocBlock } | null {
  const cands = new Map<string, { email: string; quote: string; block: MiniDocBlock }>();
  for (const b of doc.blocks) {
    if (b.dropped) continue;
    const text = String(b.text ?? '');
    if (!text || !CORRESPONDING_RE.test(text)) continue;
    for (const m of text.match(EMAIL_RE) ?? []) {
      const email = m.replace(/\s+/g, '');
      const key = email.toLowerCase();
      if (cands.has(key)) continue;
      cands.set(key, { email, quote: m, block: b });
    }
  }
  if (cands.size !== 1) return null;
  return [...cands.values()][0]!;
}

/**
 * 创建 article-meta SKILL。
 *
 * LLM 通过 `ctx.llm` 注入；未配置时（桩实现）会在调用模型那一步显式失败，
 * 而不是产出空结果——这是刻意的设计（见 packages/skills/src/llm.ts）。
 */
export function createArticleMetaSkill(
  opts: ArticleMetaSkillOptions = {},
): Skill<ArticleMetaPayload> {
  const metaPages = opts.metaPages ?? 2;
  const includeAbstract = opts.includeAbstract ?? true;
  const doVerify = opts.verifyWithCrossref ?? true;
  const doVerifyEpMc = opts.verifyWithEuropePmc ?? true;

  const skill: Skill<ArticleMetaPayload> = {
    id: 'article-meta',
    version: '0.1.0',
    level: 'article',
    description: '抽取文章级元信息（题名/作者/期刊/年份/国家/疾病/注册号/资金/DOI），并用 Crossref 校验',
    needs: includeAbstract ? ['metadata', 'abstract'] : ['metadata'],
    needsTables: false,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<ArticleMetaPayload>> {
      const issues: Issue[] = [];

      /* --- 1) 裁剪材料：首页 + 摘要 + 资金/致谢 --- */
      /*
       * ⚠️ 必须带上 funding / acknowledgements 章节。
       * 实测：资金信息（funder 名称与类型）几乎只写在 Funding 声明或致谢里，
       * 只给首页+摘要时模型一律答"未报告"——6 篇里错了 4 篇（funding1/funding2 各 5/4 个错）。
       */
      const materials = collectMaterials(ctx.doc, {
        sections: includeAbstract
          ? ['metadata', 'abstract', 'funding', 'acknowledgements']
          : ['metadata', 'funding', 'acknowledgements'],
        pages: Array.from({ length: metaPages }, (_, i) => i + 1),
        tables: false,
        figures: false,
        maxTotalChars: 30_000,
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('首页/摘要无可用材料，无法抽取文章级元信息', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'article', payload: {}, unresolved: [], issues };
      }

      /* --- 1b) 通讯作者邮箱：**全文定点补料** --- */
      const emailHint = collectEmailHint(ctx.doc);

      /* --- 2) 调模型 --- */
      const res = await ctx.llm.invoke({
        system: SYSTEM_PROMPT,
        user: USER_TEMPLATE(emailHint ? `${materials.text}\n\n${emailHint}` : materials.text),
        schema: RESPONSE_SCHEMA,
        temperature: 0,
        tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
      });

      if (!res.json) {
        issues.push(warn('模型未返回结构化 JSON，无法落地字段', 'NO_STRUCTURED_OUTPUT'));
        return { skillId: skill.id, level: 'article', payload: {}, unresolved: [], issues };
      }

      /* --- 3) 落地为带证据的 FieldValue --- */
      const grounded = groundResponse<Record<string, FieldValue>>(
        ctx.doc,
        res.json as RawSkillResponse,
        FIELD_MAP,
        { preferPages: Array.from({ length: metaPages }, (_, i) => i + 1) },
      );

      // studyOutcomes 是嵌套结构，从扁平键里挑出来单独组装
      const payload: ArticleMetaPayload = {};
      const studyOutcomes: NonNullable<ArticleMetaPayload['studyOutcomes']> = {};
      for (const [k, v] of Object.entries(grounded.payload)) {
        if (!v) continue;
        if (k.startsWith('studyOutcomes.')) {
          const sub = k.slice('studyOutcomes.'.length) as keyof typeof studyOutcomes;
          studyOutcomes[sub] = v;
        } else {
          (payload as Record<string, unknown>)[k] = v;
        }
      }
      if (Object.keys(studyOutcomes).length) payload.studyOutcomes = studyOutcomes;

      /* --- 4) 确定性编码：模型给原文，编码由本地推导 --- */
      const isFieldValue = (v: unknown): v is FieldValue =>
        typeof v === 'object' && v !== null && 'raw' in v && 'evidence' in v;

      for (const { target, from } of CODE_SOURCES) {
        const src = payload[from];
        // 只有确为 FieldValue（而非嵌套结构 / Crossref 结果）才做编码推导
        if (!isFieldValue(src)) continue;
        const d = decode(String(target), src.raw);
        if (d.code) {
          (payload as Record<string, unknown>)[target] = {
            raw: src.raw,
            code: d.code,
            ...(d.meaning ? { legend: d.meaning } : {}),
            evidence: src.evidence,
            provenance: 'deterministic',
            confidence: 1,
          } satisfies FieldValue;
        } else {
          issues.push(warn(
            `字段 ${String(target)} 无法确定性编码：${d.note ?? '未知原因'}`,
            'CODE_DECODE_FAILED',
            { path: String(target), evidence: src.evidence },
          ));
        }
      }

      /* --- 5) DOI 形态校验（挡掉从正文正则捞到的脏值）--- */
      if (payload.doi) {
        const d = normalizeDoi(payload.doi.raw);
        if (isLikelyDoi(d)) {
          payload.doi = { ...payload.doi, raw: d, provenance: 'deterministic', confidence: Math.max(payload.doi.confidence, 0.9) };
        } else {
          issues.push(warn(`DOI 形态不合法，已丢弃：${payload.doi.raw}`, 'DOI_MALFORMED', { path: 'doi', evidence: payload.doi.evidence }));
          delete payload.doi;
        }
      }

      /* --- 6) Crossref 校验（并按需求把它作为最高置信度来源） --- */
      if (doVerify && ctx.crossref) {
        const pdfMeta: PdfMetaInput = {
          ...(payload.title ? { title: payload.title.raw } : {}),
          ...(payload.journal ? { journal: payload.journal.raw } : {}),
          ...(payload.publicationYear ? { year: payload.publicationYear.raw } : {}),
          ...(payload.firstAuthor ? { firstAuthor: payload.firstAuthor.raw } : {}),
          ...(payload.doi ? { doi: payload.doi.raw } : {}),
        };
        try {
          const v = await resolveAndVerify(ctx.crossref, pdfMeta);
          payload.crossref = v;
          if (v.verdict === 'mismatch') {
            issues.push(warn(
              `Crossref 校验不一致：${v.comparisons.filter((c) => c.verdict === 'mismatch').map((c) => c.field).join(', ')}`,
              'CROSSREF_MISMATCH',
              { path: 'crossref' },
            ));
          }
          for (const n of v.notes) issues.push(warn(n, 'CROSSREF_NOTE', { path: 'crossref' }));

          /* ---- 用 Crossref 的权威值覆盖 PDF 内抽到的元信息 ---- */
          const work = v.crossref;
          if (work) {
            const externalEvidence = (what: string): Evidence[] => [{
              kind: 'external',
              page: 1,
              bbox: null,
              quote: `Crossref ${what}：${work.doi}${work.issuedYear ? `（issued ${work.issuedYear}）` : ''}`,
            }];
            const override = (
              key: 'title' | 'journal' | 'publicationYear' | 'firstAuthor' | 'doi',
              raw: string | undefined,
              what: string,
            ): void => {
              if (!raw) return;
              const before = payload[key]?.raw;
              payload[key] = {
                raw,
                evidence: externalEvidence(what),
                provenance: 'external',
                confidence: 1,
              } satisfies FieldValue;
              if (before && before !== raw) {
                issues.push(warn(
                  `${key}：以 Crossref 为准 ${JSON.stringify(raw)}（PDF 内抽到的是 ${JSON.stringify(before)}）`,
                  'CROSSREF_OVERRIDE',
                  { path: key },
                ));
              }
            };
            override('title', work.title, 'title');
            override('journal', work.containerTitle, 'container-title');
            override('firstAuthor', work.authors?.[0], 'first author');
            // 发表年份不在这里覆盖：它另有专门规则（DOI 时间优先），见步骤 7
          }
        } catch (e) {
          // 网络失败不应让整个 SKILL 失败——降级为"未校验"
          issues.push(warn(`Crossref 校验失败（已降级）：${(e as Error).message}`, 'CROSSREF_ERROR', { path: 'crossref' }));
        }
      }

      /*
       * --- 6b) Europe PMC 复核（第二独立源：**只补题名 + 记冲突，不改其它值**）---
       *
       * 为什么在 Crossref 之后跑：Crossref 是 DOI 的权威方，能覆盖的就让它覆盖；
       * EPMC 只补 Crossref 够不着的那部分。实测在"题名没拿满分的 27 篇"里，
       * **20 篇（74%）Crossref 的题名比 EPMC 短**（缺副标题 `: A Randomized Trial`），
       * 而金标准用的是完整题名——这正是本源的价值所在。
       *
       * ⚠️ 它在接口上就**没有**"覆盖任意字段"的能力（`verifyWithEuropePmc` 只返回
       * comparisons + titleCompletion），这是刻意的：本源的期刊名与年份口径不如 Crossref，
       * 只适合当第二意见，不适合当权威。
       */
      if (doVerifyEpMc && ctx.europepmc && payload.doi?.raw) {
        try {
          const work = await ctx.europepmc.byDoi(payload.doi.raw);
          const v = verifyWithEuropePmc({
            ...(payload.title ? { title: payload.title.raw } : {}),
            ...(payload.journal ? { journal: payload.journal.raw } : {}),
            ...(payload.publicationYear ? { year: payload.publicationYear.raw } : {}),
          }, work);
          payload.europepmc = v;

          if (v.titleCompletion) {
            const before = payload.title?.raw;
            payload.title = {
              raw: v.titleCompletion.to,
              evidence: [{
                kind: 'external',
                page: 1,
                bbox: null,
                quote: `Europe PMC（PMID ${v.work?.pmid ?? '—'}）题名：${v.titleCompletion.to}`,
              }],
              provenance: 'external',
              confidence: 1,
            } satisfies FieldValue;
            issues.push(warn(
              `题名补全：Europe PMC 的题名更完整（原值 ${JSON.stringify(before)}）`,
              'EPMC_TITLE_COMPLETED',
              { path: 'title' },
            ));
          }
          for (const n of v.notes) issues.push(warn(n, 'EPMC_NOTE', { path: 'europepmc' }));
        } catch (e) {
          /* 网络失败不能让整个 SKILL 失败——降级为"未复核" */
          issues.push(warn(`Europe PMC 复核失败（已降级）：${(e as Error).message}`, 'EPMC_ERROR', { path: 'europepmc' }));
        }
      }

      /*
       * --- 7) 发表年份：以 DOI 的时间为准 ---
       *
       * 需求：年份以 DOI 的时间为准；Crossref 能拿到信息时，Crossref 是最高置信度来源。
       *
       * 为什么必须显式定规则：实测同一篇论文里三个"年份"互不相同——
       *   页脚引文 `Acupunct Med 2016;34:257–266`（卷期年，印刷年）
       *   页脚 `Accepted 23 December 2015 / Published Online First 15 February 2016`
       *   DOI `10.1136/acupmed-2015-010950`（2015）
       *   金标准填 2015 = DOI 里的年份。
       * 而 Crossref 对这篇的日期只有 created 2016-02-15 / issued 2016-08（没有 2015），
       * 所以"Crossref 优先"会答 2016 而与金标准不符。
       *
       * 因此优先级：**DOI 字符串里的年份 > Crossref issued 年 > PDF 正文/页脚年份**。
       * 依据：DOI 的年份是出版商在注册时写入的、与稿件本身绑定；
       * Crossref 的 issued 是"卷期出版时间"，会因在线优先/跨年而晚一年。
       */
      {
        const yearFromDoi = (doi: string | undefined): string | undefined => {
          if (!doi) return undefined;
          // 取 DOI 后缀里出现的第一个 19xx/20xx
          const m = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/.exec(doi);
          return m?.[1];
        };
        const doiYear = yearFromDoi(payload.doi?.raw);
        const crYear = payload.crossref?.crossref?.issuedYear;
        const cur = payload.publicationYear;
        const doiEvidence = payload.doi?.evidence?.length
          ? payload.doi.evidence
          : [{ kind: 'external' as const, page: 1, bbox: null, quote: `DOI ${payload.doi?.raw ?? ''}` }];

        if (doiYear) {
          if (doiYear !== cur?.raw) {
            issues.push(warn(
              `发表年份以 DOI 为准：${doiYear}（原值为 ${cur?.raw ?? '未抽到'}）`,
              'YEAR_FROM_DOI',
              { path: 'publicationYear', ...(cur?.evidence?.length ? { evidence: cur.evidence } : {}) },
            ));
          }
          payload.publicationYear = {
            raw: doiYear,
            evidence: doiEvidence,
            provenance: 'deterministic',
            confidence: 0.95,
          } satisfies FieldValue;
        } else if (crYear && crYear !== cur?.raw) {
          // DOI 字符串里没有年份（如 10.1177/0269215515578698）→ 以 Crossref 为准
          issues.push(warn(
            `发表年份以 Crossref 为准：${crYear}（原值为 ${cur?.raw ?? '未抽到'}）`,
            'YEAR_FROM_CROSSREF',
            { path: 'publicationYear', ...(cur?.evidence?.length ? { evidence: cur.evidence } : {}) },
          ));
          payload.publicationYear = {
            raw: crYear,
            evidence: [{ kind: 'external', page: 1, bbox: null, quote: `Crossref issued ${crYear}` }],
            provenance: 'external',
            confidence: 1,
          } satisfies FieldValue;
        } else if (!cur && crYear) {
          payload.publicationYear = {
            raw: crYear,
            evidence: [{ kind: 'external', page: 1, bbox: null, quote: `Crossref issued ${crYear}` }],
            provenance: 'external',
            confidence: 1,
          } satisfies FieldValue;
        }
      }

      /*
       * --- 8) 影响因子：查表，不让模型猜 ---
       *
       * 需求（用户）：影响因子从 `Datas/IF-SCI-2019.xlsx`（JCR 2019 SCIE）查询。
       * 为什么必须查表：论文里**没有**影响因子，模型只能凭记忆答——实测 224 篇错 172 篇，
       * 而"对"的 50 篇几乎都是双方都填 NR。查表后同一期刊的答案稳定且可追溯。
       *
       * 口径：
       *   · 期刊名优先用 Crossref 的 container-title（权威全称），退化到 PDF 里抽到的期刊名；
       *   · 归一后精确相等才算命中（放宽到 Dice ≥ 0.9 也只是差标点），**查不到就填 NR**，
       *     绝不退回模型的猜测值——填一个看起来合理但错的影响因子比留空更糟；
       *   · 表里查不到 ≠ 论文没写：给出 `IF_NOT_IN_TABLE` 警告，便于人工回查期刊名。
       */
      if (opts.ifLookup) {
        /*
         * 期刊名有**两个来源**，两个都要试：
         *   · Crossref 的 container-title（权威全称，最准）；
         *   · PDF 里抽到的期刊名（Crossref 没解析出来时兜底，且它常是全称/缩写混写）。
         * 只试一个会白丢字段：实测有 37 篇因为"Crossref 的名字查不到"而直接填 NR，
         * 而其中一部分用 PDF 里的名字是能查到的。
         *
         * ⚠️ 但当 Crossref 判定为 `mismatch`（DOI 指向的不是这篇）时，它的刊名不可信，
         * 此时**只信 PDF 里的刊名**——否则会拿别刊的影响因子（实测 2016-05 差点如此）。
         */
        const cr = payload.crossref?.crossref;
        /* Crossref 判定 mismatch 时说明 DOI 指的不是这篇，它的刊名不可信 */
        const crOk = payload.crossref?.verdict !== 'mismatch';
        const candidates = [
          ...(crOk && cr?.containerTitle ? [cr.containerTitle] : []),
          ...(payload.journal?.raw ? [payload.journal.raw] : []),
        ].filter((v, i, a) => v && a.indexOf(v) === i);

        const before = payload.impactFactor2019?.raw;
        let hit: ReturnType<NonNullable<ArticleMetaSkillOptions['ifLookup']>> = null;
        let usedName = '';
        for (const name of candidates) {
          const r = opts.ifLookup(name);
          if (r) { hit = r; usedName = name; break; }
        }

        if (hit) {
          if (before !== hit.jif) {
            issues.push(warn(
              `影响因子查表：${hit.jif}（期刊《${hit.journal}》${hit.how === 'exact' ? '精确匹配' : `近似匹配 ${hit.how}`}）`
                + (before ? `；原先填的是 ${before}，已按表更正` : ''),
              'IF_FROM_TABLE',
              { path: 'impactFactor2019' },
            ));
          }
          payload.impactFactor2019 = {
            raw: hit.jif,
            evidence: [{
              kind: 'external',
              page: 1,
              bbox: null,
              quote: `IF-SCI-2019.xlsx：${hit.journal} = ${hit.jif}`,
            }],
            provenance: 'external',
            confidence: 1,
          } satisfies FieldValue;
        } else if (candidates.length) {
          /*
           * 表里查不到 → 按工作表口径填 **0**，不是 NR。
           *
           * 依据：IF-SCI-2019.xlsx 是 **SCIE 全刊**表，查不到即"该刊 2019 年未进 SCIE"
           * （中文刊、ESCI 刊都属此列），而工作表对这一类的约定就是 0。
           * 实测金标准里"填 0"的 59 处，正是这类期刊；填 NR 反而全错。
           */
          issues.push(warn(
            `影响因子：期刊在 IF-SCI-2019.xlsx 里查不到（试过 ${candidates.map((c) => `《${c}》`).join('、')}）`
              + '→ 该刊 2019 年未进 SCIE，按工作表口径填 0'
              + (before && !/^(0|NR|NA|NE)$/i.test(before) ? `；模型原先填 ${before}，已按口径更正` : ''),
            'IF_NOT_IN_TABLE',
            { path: 'impactFactor2019' },
          ));
          payload.impactFactor2019 = {
            raw: '0',
            evidence: [{ kind: 'external', page: 1, bbox: null, quote: `IF-SCI-2019.xlsx（SCIE 2019）未收录《${candidates[0]}》→ 按口径填 0` }],
            provenance: 'external',
            confidence: 0.9,
          } satisfies FieldValue;
        }
        void usedName;
      }

      /*
       * --- 8b) 通讯作者邮箱的**确定性兜底** ---
       *
       * 补料段已经把"扫到的邮箱 + 页码/章节 + 是否带 correspondence 标记"给了模型，
       * 但仍可能有漏网的（2024-03 的那条邮箱在 PDF 里是 `lcohen@\nmdanderson.org` 跨行断开，
       * 正则若不容忍换行就扫不到——这个坑踩过一次）。这里再加一道确定性兜底：
       * 当模型答 NR/缺字段、且全文中**恰好只有一个**带 correspondence 标记的邮箱时，直接采用它，
       * 并把证据指向该邮箱真正所在的块（页码/bbox 都来自 MiniDoc，前端仍能框选）。
       * 出现两个及以上候选时**不猜**——那正是"多作者选谁"的判断，交回模型与人工。
       */
      const contactNow = payload.authorContact?.raw;
      if (!contactNow || /^(NR|NA|NE)$/i.test(contactNow.trim())) {
        const pick = pickCorrespondingEmail(ctx.doc);
        if (pick) {
          payload.authorContact = {
            raw: pick.email,
            evidence: [{
              kind: 'text',
              page: pick.block.page,
              bbox: pick.block.bbox ?? null,
              quote: pick.quote,
              blockId: `b${pick.block.index}`,
            }],
            provenance: 'deterministic',
            confidence: 0.85,
          } satisfies FieldValue;
          issues.push(warn(
            `通讯作者邮箱：模型答 ${contactNow ?? '（缺）'}，但全文只有一个带 correspondence 标记的邮箱`
              + `（p${pick.block.page}/${pick.block.section}）→ 按规则采用`,
            'CONTACT_FROM_SCAN',
            { path: 'authorContact' },
          ));
        }
      }

      return {
        skillId: skill.id,
        level: 'article',
        payload,
        unresolved: grounded.unresolved,
        issues: [...issues, ...grounded.issues.map((g) => warn(g.reason, 'GROUNDING_FAILED', { path: g.field }))],
      };
    },

    /* ------------------------- 确定性校验器 ------------------------- */
    validate(output: SkillOutput<ArticleMetaPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const p = output.payload;

      // 年份必须是 4 位数，且不应远早于语料年份
      if (p.publicationYear?.raw) {
        const y = Number(p.publicationYear.raw.match(/\d{4}/)?.[0]);
        if (!Number.isFinite(y) || y < 1900 || y > 2100) {
          issues.push(warn(`发表年份可疑：${p.publicationYear.raw}`, 'YEAR_IMPLAUSIBLE', { path: 'publicationYear' }));
        }
      }

      // 登记号格式
      if (p.registrationIds?.raw) {
        const ids = p.registrationIds.raw.split(/[,;]\s*/).filter(Boolean);
        for (const id of ids) {
          if (!/^(ISRCTN\d+|NCT\d{6,}|ChiCTR[-\w]+|UMIN\d+|IRCT[\w-]+|ACTRN\d+)/i.test(id.trim())) {
            issues.push(warn(`注册号格式不匹配已知注册库：${id}`, 'REG_ID_UNKNOWN_FORMAT', { path: 'registrationIds' }));
          }
        }
      }

      // 编码必须落在图例范围内（由 decode 保证，这里再确认一遍防回归）
      for (const f of ['conditionSystem', 'countryClass', 'journalClass', 'acuteOrSurgery'] as const) {
        const v = p[f];
        if (v?.code) {
          const d = decode(f, v.code);
          if (d.method === 'none') {
            issues.push(warn(`字段 ${f} 的编码 ${v.code} 不在图例内`, 'CODE_OUT_OF_LEGEND', { path: f }));
          }
        }
      }

      // Crossref 判定为 mismatch 时必须是 warning 级（供人工复核），并已在 run 里记录
      if (p.crossref?.verdict === 'mismatch') {
        issues.push(warn('Crossref 判定为不一致，请人工复核', 'CROSSREF_MISMATCH_CONFIRMED', { path: 'crossref' }));
      }

      return issues;
    },
  };

  return skill;
}

/**
 * 结构化输出的 JSON Schema。
 * 用最简子集（type/properties/required/additionalProperties/items/enum），
 * 以便兼容各家模型的结构化输出能力。
 */
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: Object.fromEntries(
    Object.keys(FIELD_MAP).map((k) => [
      k,
      k === 'funding'
        ? { type: 'array', items: { $ref: '#/$defs/claim' } }
        : { $ref: '#/$defs/claim' },
    ]),
  ),
  $defs: {
    claim: {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'quote', 'confidence'],
      properties: {
        value: { type: 'string' },
        quote: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
  },
} as const;
