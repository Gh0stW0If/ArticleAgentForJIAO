/**
 * @aa/skills — SKILL: 结局指标规划（outcome-plan）【上游】
 *
 * ===== 为什么需要它 =====
 *
 * 结局级是"条数未知"的一层：一篇论文到底有几个结局指标，得先数清楚。
 * 实测把"数条数"和"填数值"放在一次调用里，模型会去数**结果表里的每一行**——
 * 2015-01 因此报了 9 条（金标准 4 条）：多出 FIQ、压痛阈、压痛点计数、合并用药等
 * 只在结果表里出现的指标。多一条就多几十个错误字段。
 *
 * 金标准的依据是**论文自己声明的那句话**（方法学里的
 * `The primary outcome was … Secondary outcomes included …`）。
 * 因此本 SKILL 只做一件事：找出声明句，并逐条列出其上出现的结局指标；
 * **每条都必须带上声明句原文作为 anchor**——下游（以及本 SKILL 自己）据此核对，
 * 给不出 anchor、或 anchor 不在"声明句"所在块里的条目会被丢弃并记入 unresolved。
 *
 * 这样"多列"从提示词的祈使句变成了**可执行的规则**（不依赖模型自律）。
 */

import {
  type Evidence,
  type FieldValue,
  type Issue,
  type Skill,
  type SkillContext,
  type SkillOutput,
  type UnresolvedItem,
  warn,
} from '@aa/core';
import { PROMPTS } from './prompts.generated.ts';
import { collectMaterials } from './materials.ts';
import { groundField, type RawFieldClaim } from './grounding.ts';

export interface PlannedOutcome {
  name?: FieldValue;
  instrument?: FieldValue;
  /** 需求规定的六类结局类别码：1 疼痛 / 2 非疼痛症状 / 3 功能 / 4 生活质量 / 5 重要事件 / 6 死亡率 */
  outcomeClass?: FieldValue;
  /** 声明该结局的那句原文（核对用） */
  anchor?: FieldValue;
}

/** 需求规定的六类结局（只对这六类做自动抽取）。 */
export const OUTCOME_CLASSES: Readonly<Record<string, string>> = {
  '1': '疼痛类',
  '2': '非疼痛症状类结局',
  '3': '功能类结局',
  '4': '生活质量类结局',
  '5': '重要事件类结局',
  '6': '死亡率',
};

export interface OutcomePlanPayload {
  declarationFound?: FieldValue;
  /** 六类结局：会被逐条自动抽取数值 */
  outcomes: PlannedOutcome[];
  /**
   * 归不进六类的候选：**记录下来交人工判断是否纳入**，不自动抽数值。
   * 需求原文：「其他提取出的结局可以记录，最后交由人工判断是否纳入」。
   */
  otherOutcomes: PlannedOutcome[];
  /** 因未能对上声明句 / 属于资源使用类而被丢弃的条目（供人工复核） */
  rejected: { reason: string; name: string; evidence: readonly Evidence[] }[];
}

/** 认定"这是结局声明句"的判据（英文论文；大小写不敏感）。 */
const DECLARATION_RE = /\b(primary|secondary|main|co-?primary)\s+(outcome|endpoint|measure)|\boutcomes?\s+(were|was|included|assessed|measured)|\bendpoints?\s+(were|included|assessed)/i;

/**
 * "不算 primary/secondary 声明句"的判据。
 *
 * 实测这些句子会被朴素声明正则误判（它们也含 "main outcome" / "outcomes measured"）：
 *   · `Subsequent outcomes measured were …`（不是 primary/secondary）
 *   · `Finally, a stepwise forward multiple linear regression model was constructed,
 *      taking the main outcome variable (relative change in pain intensity T0-T1),
 *      and adjusting for age, baseline disease severity (PainVAS, FIQ and HDRS), pain threshold…`
 *     —— 这一句让 FIQ / 压痛阈 / 压痛点被误当成"声明的结局"（2015-01 因此多出 3 条）。
 */
const NON_PRIMARY_SENTENCE_RE = /\b(subsequent|subsequently|other|additional|exploratory|post[-\s]?hoc|secondary analys|further|regression|multivariate|univariate|adjust(?:ed|ing)? for|covariat|predictor|correlat|associat)\b/i;

/**
 * 资源使用/过程类指标（没有测量量表，属卫生经济学指标）。
 * 仅当该条目**没有量表**时按此排除——量表名与资源使用词同时出现时以量表为准。
 */
const RESOURCE_USE_RE = /\b(medication|drug|analgesic|rescue|visit|admission|hospitali[sz]|length of stay|cost|economic|adherence|compliance|dropout|withdrawal|consumption)\b/i;

/** 量表的形态特征：常见量表后缀或全大写缩写（VAS、HDRS、SF-12、FIQ、RQLQ…）。 */
const INSTRUMENT_RE = /\b(scale|questionnaire|index|score|inventory|questionnaire|VAS|HDRS|HADS|SF-?12|SF-?36|FIQ|RQLQ|BDI|BAI|FSS|EQ-?5D|NRS|MBI|SSA|SWAL|WHOQOL)\b/i;

export function createOutcomePlanSkill(options: { primaryHint?: FieldValue; explicitChange?: PlannedOutcome } = {}): Skill<OutcomePlanPayload> {
  const skill: Skill<OutcomePlanPayload> = {
    id: 'outcome-plan',
    version: '0.1.0',
    level: 'cross-cutting',
    description: '只找出论文自己声明的结局指标清单（每条带声明句原文作为锚），不抽数值',
    needs: ['abstract', 'methods'],
    needsTables: false,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<OutcomePlanPayload>> {
      const issues: Issue[] = [];
      const rejected: OutcomePlanPayload['rejected'] = [];
      const payload: OutcomePlanPayload = { outcomes: [], otherOutcomes: [], rejected };

      const materials = collectMaterials(ctx.doc, {
        sections: ['abstract', 'metadata', 'methods'],
        pages: [1],
        tables: false,
        figures: false,
        maxCharsPerBlock: 4000,
        maxTotalChars: 40_000,
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('摘要与方法学均无可用材料，无法找到结局声明', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'cross-cutting', payload, unresolved: [], issues };
      }

      const res = await ctx.llm.invoke({
        system: PROMPTS.outcomePlan + '\n逐项覆盖论文明确声明的主要结局。若声明比较“相对基线变化”，保留变化口径和主分析时间窗。可从声明中确认同一指标的缩写和全名。',
        user: `以下是该论文的摘要与方法学材料（不含表格）。请找出论文自己声明的结局指标清单。\n\n${materials.text}`
          + (options.explicitChange?.name ? `\n\n重点核对原文明确声明的变化量结局：${options.explicitChange.name.raw}` : ''),
        temperature: 0,
        tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
      });

      if (!res.json) {
        issues.push(warn('模型未返回结构化 JSON', 'NO_STRUCTURED_OUTPUT'));
        return { skillId: skill.id, level: 'cross-cutting', payload, unresolved: [], issues };
      }

      const raw = res.json as Record<string, unknown>;
      const unresolved: UnresolvedItem[] = [];

      /** 落地一个 claim（quote 必须能在材料里定位）。 */
      const claim = (path: string, v: unknown): FieldValue | undefined => {
        if (v === null || typeof v !== 'object') return undefined;
        const r = groundField(ctx.doc, path, v as RawFieldClaim, { kinds: ['text', 'title'] });
        if (r.field) return r.field;
        if (r.unresolved) unresolved.push(r.unresolved);
        if (r.issue) issues.push(warn(r.issue, 'GROUNDING_FAILED', { path }));
        return undefined;
      };

      const decl = claim('outcomePlan.declarationFound', raw.declarationFound);
      if (decl) payload.declarationFound = decl;

      const rawOutcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
      /*
       * 模型也会给出 `otherOutcomes`（归不进六类的候选）。
       * 需求：「其他提取出的结局可以记录，最后交由人工判断是否纳入」——
       * 因此它们**不做锚定/分类过滤**，原样记录（带证据）即可。
       */
      const rawOthers = Array.isArray(raw.otherOutcomes) ? raw.otherOutcomes : [];

      /*
       * 锚定校验的两级判据。
       *
       * 1) 文中有明确的 primary/secondary outcome 声明句 → 结局必须能在**声明句所在块**里找到
       *    （名称或工具出现在该块文本中，或模型给的 anchor 就落在该块）。
       * 2) 文中**完全没有**这类措辞（实测 2015-06 这类中文作者的英文论文就是如此）→
       *    退化为"证据必须落在摘要或方法学里"：这两处才是论文自己对"测了什么"的交代。
       *    实测该文的写法是 `The residual urine volume was detected by collecting …`（方法学），
       *    而结果表/结果段里的数值不算声明。
       *
       * 之所以要判块而不是只判字符串：模型给的 anchor 常常只是短片段，
       * groundField 会在全文里就近命中（可能落到结果段），单看字符串无法区分
       * "被声明的结局"与"结果表里的额外指标"。
       */
      const declBlocks = ctx.doc.blocks.filter(
        (b) => (b.section === 'abstract' || b.section === 'methods' || b.section === 'metadata') && DECLARATION_RE.test(b.text),
      );
      const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

      /** 按句号切句（保留句内分号，因为"次要结局"常写成 A; B; and C 一句）。 */
      const splitSentences = (text: string): string[] =>
        text.replace(/\s+/g, ' ').split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);

      /*
       * 只把**真正的 primary/secondary 声明句**当作依据。
       * `Subsequent outcomes measured were …` 这类句子也含 "outcomes measured"，
       * 会被朴素的声明正则误判成声明句——实测它正是 FIQ / 压痛阈被错误收录的原因。
       */
      const declSentences = declBlocks
        .flatMap((b) => splitSentences(b.text))
        .filter((s) => DECLARATION_RE.test(s) && !NON_PRIMARY_SENTENCE_RE.test(s));

      const hasDeclaration = declSentences.length > 0;


      /**
       * 结局名里的**通用词**，不用于判定。
       *
       * 不加这层过滤会出事：`change in fibromyalgia impact` 里的 "change" 在声明句
       * （"The primary outcome was **change** in pain intensity…"）里也有，
       * 于是 FIQ 会被误判成"被声明的结局"——实测 2015-01 因此多出 3 条。
       * 只有去掉通用词后的**特征词**（fibromyalgia / physical / mental / depression…）才算证据。
       */
      const GENERIC_WORDS = new Set([
        'change', 'changes', 'improvement', 'improved', 'level', 'levels', 'number', 'total',
        'patients', 'patient', 'participants', 'participant', 'outcome', 'outcomes', 'measure',
        'measured', 'measures', 'score', 'scores', 'value', 'values', 'week', 'weeks', 'month',
        'months', 'time', 'times', 'point', 'points', 'group', 'groups', 'after', 'before',
        'during', 'with', 'from', 'using', 'based', 'reported', 'assessment', 'assessed',
      ]);

      const distinctiveTokens = (s: string): string[] =>
        norm(s).split(' ').filter((w) => w.length >= 5 && !GENERIC_WORDS.has(w));

      /**
       * 缩写匹配：`quality of life` ↔ 声明句里的 `QoL`。
       *
       * ⚠️ 实测最贵的一次误杀（2015-02）：声明句是
       * `Secondary outcomes were QoL, global change, SAR-related medication usage, and adverse events.`
       * 模型给出的结局名是 `quality of life`——朴素子串匹配对不上（`qol` ≠ `quality`），
       * 于是**唯一的生活质量结局被 OUTCOME_NOT_ANCHORED 整条丢弃**；
       * 该篇 Sheet3 的 85 个漏（占当年全部漏的 91%）全部源于此。
       *
       * 判据：把名称的**首字母缩写**（保留 of/and 这类虚词，`quality of life` → `qol`）
       * 拿去按词边界匹配声明句。按词边界是必须的——否则 `qol` 会命中 `protocol` 之类的子串。
       */
      const acronymOf = (s: string): string =>
        norm(s).split(' ').filter(Boolean).map((w) => w[0]!).join('');

      const hayHasAcronym = (hay: string, rec: PlannedOutcome): boolean => {
        for (const raw of [rec.name?.raw, rec.instrument?.raw]) {
          if (!raw || raw.trim().length < 3) continue;
          const acr = acronymOf(raw);
          if (acr.length < 3) continue;
          if (new RegExp(`(^|[^\\p{L}\\p{N}])${acr}([^\\p{L}\\p{N}]|$)`, 'iu').test(hay)) return true;
        }
        return false;
      };

      const textHas = (hay: string, rec: PlannedOutcome): boolean => {
        const raw = [rec.name?.raw, rec.instrument?.raw].filter((s): s is string => Boolean(s && s.trim().length >= 4));
        if (!raw.length) return false;
        // 整串命中，或特征词命中
        if (raw.some((s) => hay.includes(norm(s)))) return true;
        const tokens = raw.flatMap(distinctiveTokens);
        if (tokens.length > 0 && tokens.some((t) => hay.includes(t))) return true;
        // 缩写 ↔ 全称（QoL ↔ quality of life）
        return hayHasAcronym(hay, rec);
      };

      /** 名称/工具必须出现在声明句里（不是"同一个段落里"）。 */
      const appearsInDeclaration = (rec: PlannedOutcome): boolean =>
        declSentences.some((s) => textHas(norm(s), rec));

      /**
       * 文中完全没有声明句时（实测 2015-06 这类中文作者的英文论文）退化为：
       * 名称/工具必须出现在**摘要或方法学**的文本里——那才是论文自己对"测了什么"的交代。
       */
      const appearsInAbstractOrMethods = (rec: PlannedOutcome): boolean =>
        ctx.doc.blocks
          .filter((b) => b.section === 'abstract' || b.section === 'methods')
          .some((b) => textHas(norm(b.text), rec));

      for (const [i, item] of rawOutcomes.entries()) {
        if (item === null || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const rec: PlannedOutcome = {};
        for (const [k, jsonKey] of [['name', 'outcomeName'], ['instrument', 'instrument'], ['outcomeClass', 'outcomeClass'], ['anchor', 'anchor']] as const) {
          const f = claim(`outcomePlan.outcomes[${i}].${k}`, o[jsonKey]);
          if (f) (rec as unknown as Record<string, unknown>)[k] = f;
        }
        if (!rec.name && !rec.instrument) continue;

        if (!rec.anchor) {
          rejected.push({ reason: '未提供声明句（anchor），无法确认是被声明的结局', name: rec.name?.raw ?? rec.instrument?.raw ?? '', evidence: [] });
          continue;
        }

        const anchorBlockId = rec.anchor.evidence[0]?.blockId;
        const anchorBlock = anchorBlockId ? ctx.doc.blocks.find((b) => `b${b.index}` === anchorBlockId) : undefined;

        /*
         * 通过条件（三者之一）：
         *   ① 名称/工具出现在声明句里（含缩写展开，见 textHas）；
         *   ② 没有声明句时，出现在摘要或方法学里；
         *   ③ **anchor 本身落在声明句所在的那一段**——这是错误信息里一直承诺、
         *      但之前没实现的一条（实测 anchorBlock 算出来却是死变量）。
         *      模型常把 anchor 指向"次要结局是……"那一段的整句，句级匹配会漏，段落级兜底能救回来。
         */
        const ok = hasDeclaration
          ? (appearsInDeclaration(rec)
            || Boolean(anchorBlock && declBlocks.some((b) => b.index === anchorBlock.index)))
          : appearsInAbstractOrMethods(rec);

        if (!ok) {
          rejected.push({
            reason: hasDeclaration
              ? '名称/工具既没出现在 primary/secondary outcome 声明句里，anchor 也不落在声明句所在段落（疑似结果表里的额外指标）'
              : '文中没有 outcome 声明句，且 anchor 不落在摘要或方法学里（疑似结果表里的额外指标）',
            name: rec.name?.raw ?? rec.instrument?.raw ?? '',
            evidence: rec.anchor.evidence,
          });
          continue;
        }

        /*
         * 六类过滤（需求：只找疼痛/非疼痛症状/功能/生活质量/重要事件/死亡率六类）。
         *
         * 模型给了 outcomeClass 码：
         *   1~6 → 六类之一，进 outcomes（自动抽数值）；
         *   0/空/其他 → 进 otherOutcomes，**记录下来交人工判断是否纳入**。
         * 另外资源使用类（合并用药/就诊次数/成本/依从性）即使被强行归了类也不收进六类。
         */
        const label = `${rec.name?.raw ?? ''} ${rec.instrument?.raw ?? ''}`;
        const cls = String(rec.outcomeClass?.raw ?? '').trim();
        const inSix = /^[1-6]$/.test(cls);
        const resourceUse = RESOURCE_USE_RE.test(label) && !INSTRUMENT_RE.test(rec.instrument?.raw ?? '');

        if (!inSix || resourceUse) {
          payload.otherOutcomes.push(rec);
          issues.push(warn(
            `结局「${rec.name?.raw ?? rec.instrument?.raw}」${resourceUse ? '属资源使用/过程类指标' : `未能归入六类（outcomeClass=${cls || '空'}）`}` +
            `，已记入 otherOutcomes 交人工判断`,
            'OUTCOME_NOT_IN_SIX_CLASSES',
            { path: 'otherOutcomes' },
          ));
          continue;
        }
        payload.outcomes.push(rec);
      }

      /* otherOutcomes：原样落地（记录用），同样要求证据可定位 */
      for (const [i, item] of rawOthers.entries()) {
        if (item === null || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const rec: PlannedOutcome = {};
        for (const [k, jsonKey] of [['name', 'outcomeName'], ['instrument', 'instrument'], ['outcomeClass', 'outcomeClass'], ['anchor', 'anchor']] as const) {
          const f = claim(`outcomePlan.otherOutcomes[${i}].${k}`, o[jsonKey]);
          if (f) (rec as unknown as Record<string, unknown>)[k] = f;
        }
        if (rec.name || rec.instrument) payload.otherOutcomes.push(rec);
      }

      /*
       * 去重：同一 (名称, 工具) 只保留一条。
       * 实测 2015-04 的清单里 FSS 出现了两次（"fatigue severity / FSS"），
       * 不去重就会多出一整条结局（每个时点 30 余个字段的错值）。
       */
      const seen = new Set<string>();
      const deduped: PlannedOutcome[] = [];
      for (const o of payload.outcomes) {
        const key = `${norm(o.name?.raw ?? '')}|${norm(o.instrument?.raw ?? '')}`;
        if (key === '|' || seen.has(key)) {
          if (key !== '|') {
            issues.push(warn(
              `结局「${o.name?.raw ?? o.instrument?.raw}」重复出现，已去重`,
              'OUTCOME_DUPLICATE',
              { path: 'outcomes' },
            ));
          }
          continue;
        }
        seen.add(key);
        deduped.push(o);
      }
      payload.outcomes = deduped;

      const hint = options.primaryHint?.raw.trim() ?? '';
      const aliases = hint.split(':').map(part => part.replace(/\s*\([^)]+\)\s*$/, '').trim())
        .filter(part => part.length >= 3 && !/^(?:NR|NA|NE)$/i.test(part));
      const hasAlias = (label: string) => aliases.some(alias => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:s\\b|$|[^\\p{L}\\p{N}])`, 'iu').test(label);
      });
      const primaryBlocks = declBlocks.filter(block =>
        /\bprimary\s+(?:outcome|end\s*point|measure)/i.test(block.text) && hasAlias(block.text.replace(/-\s*\r?\n/g, '')));
      const covered = deduped.some(outcome => hasAlias(`${outcome.name?.raw ?? ''} ${outcome.instrument?.raw ?? ''}`));
      if (!covered && primaryBlocks.length && !options.explicitChange && !RESOURCE_USE_RE.test(hint)) {
        const labels = ctx.doc.blocks.flatMap(block => (block.table?.grid ?? []).slice(1).flatMap(row =>
          (row.slice(0, 2).some(hasAlias) && row.some(cell => /\d/.test(cell))) ? [row.join(' | ')] : [],
        )).slice(0, 12);
        let recovered = false;
        if (labels.length) {
          try {
            const result = await ctx.llm.invoke({
              system: '只核对一个遗漏的主要结局。根据声明段和结果行确认该结局，保留原文统计口径和时间窗。输出 JSON，其中 outcomeName、instrument（如有）、anchor、outcomeClass 与结局清单使用相同的 {value,quote} 格式，outcomeClass 取 1–6，无法确认则输出 {}。',
              user: `主要结局候选：${hint}\n原文声明：\n${primaryBlocks.slice(0, 3).map(block => block.text).join('\n\n')}\n相关结果行：\n${labels.join('\n')}\n分类：${JSON.stringify(OUTCOME_CLASSES)}`,
              temperature: 0,
              tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}:primary-coverage`,
            });
            const candidate = (result.json ?? {}) as Record<string, unknown>;
            const name = claim('outcomePlan.primaryCoverage.name', candidate.outcomeName);
            const instrument = claim('outcomePlan.primaryCoverage.instrument', candidate.instrument);
            const anchor = claim('outcomePlan.primaryCoverage.anchor', candidate.anchor);
            const outcomeClass = claim('outcomePlan.primaryCoverage.outcomeClass', candidate.outcomeClass);
            const declared = anchor && primaryBlocks.some(block => `b${block.index}` === anchor.evidence[0]?.blockId);
            const label = `${name?.raw ?? ''} ${instrument?.raw ?? ''}`;
            if (name && declared && hasAlias(label) && /^[1-6]$/.test(outcomeClass?.raw ?? '') && !RESOURCE_USE_RE.test(label)) {
              payload.outcomes.push({ name, ...(instrument ? { instrument } : {}), anchor, ...(outcomeClass ? { outcomeClass } : {}) });
              recovered = true;
            }
          } catch (error) {
            issues.push(warn(`主要结局定向复核失败：${(error as Error).message}`, 'PRIMARY_COVERAGE_CALL_FAILED'));
          }
        }
        if (!recovered) {
          const reason = '主要结局声明尚未与结果行形成可验证的对应，请核对论文';
          issues.push(warn(reason, 'PRIMARY_COVERAGE_UNRESOLVED'));
          unresolved.push({ skillId: skill.id, raw: hint, evidence: options.primaryHint?.evidence ?? [], reason, confidence: 0 });
        }
      }

      if (payload.outcomes.length === 0) {        issues.push(warn(
          `未产出任何"可锚定"的结局指标（被丢弃 ${rejected.length} 条）；下游将无法抽取结局层`,
          'NO_ANCHORED_OUTCOMES',
        ));
      }
      for (const r of rejected) {
        issues.push(warn(`结局「${r.name}」被丢弃：${r.reason}`, 'OUTCOME_NOT_ANCHORED', { path: 'outcomes' }));
      }

      return { skillId: skill.id, level: 'cross-cutting', payload, unresolved, issues };
    },

    validate(output: SkillOutput<OutcomePlanPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const n = output.payload.outcomes.length;
      if (n === 0) return issues;   // run() 里已报 NO_ANCHORED_OUTCOMES
      if (n > 6) {
        issues.push(warn(
          `可锚定的结局有 ${n} 条，超出常见范围（2~6），请复核声明句是否被拆得过细`,
          'TOO_MANY_OUTCOMES',
          { path: 'outcomes' },
        ));
      }
      // 名称与工具不应是同义重复（如 name=PainVAS / instrument=VAS）
      for (const [i, o] of output.payload.outcomes.entries()) {
        const nm = (o.name?.raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const ins = (o.instrument?.raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (nm && ins && (nm === ins || nm.includes(ins))) {
          issues.push(warn(
            `outcomes[${i}]：名称与测量工具重复（name=${o.name?.raw} / instrument=${o.instrument?.raw}），` +
            `名称应回答"测的是什么"`,
            'NAME_INSTRUMENT_DUPLICATE',
            { path: `outcomes[${i}]` },
          ));
        }
      }
      return issues;
    },
  };

  return skill;
}
