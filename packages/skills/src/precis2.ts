/**
 * @aa/skills — SKILL: PRECIS-2 九领域适用性评分（第二篇）
 *
 * 依据：`Datas/design/文章计划 整理 202609/05 PRECIS-2 agent.md`。
 * 这是**评分**技能，不是偏倚风险评价、不是质量打分、也不是疗效判断。
 *
 * 设计要点
 * --------
 * 1. **模型只给分数与逐字引文**，坐标由本地 `groundField()` 定位（与其它 SKILL 同一条
 *    防幻觉约定）；引文定位不到的，记 `grounded: false` 并挂 issue，**不伪造证据**。
 * 2. **3-U 允许没有引文**：它表达的是"报告不足/自相矛盾"，本来就没有可引的原句。
 *    此时要求模型把「哪一节/哪一页该有却没有」写进 `evidenceText`，供人工核。
 *    但除 3-U / N/A 外，**没有一条可定位引文的分数会被判为未接地**。
 * 3. 评分标签严格按 05：`1 / 2 / 3-B / 3-U / 4 / 5 / N/A / AS: …`。
 *    `3-B`（真正平衡）与 `3-U`（信息不足）**绝不能混用**——这条在 validate 里有专门检查。
 * 4. `N/A` 只允许出现在「灵活性：依从」且参与者没有有意义的依从行为时（05 §4.3）。
 *
 * 输出是"每篇研究一份"的九领域矩阵行，不含比较组/结局级的扇出。
 */

import {
  type Evidence,
  type Issue,
  type Skill,
  type SkillContext,
  type SkillOutput,
  warn,
} from '@aa/core';
import { collectMaterials } from './materials.ts';
import { groundField } from './grounding.ts';

export const PRECIS_DOMAINS = [
  { key: 'eligibility', en: 'Eligibility', zh: '纳排标准' },
  { key: 'recruitment', en: 'Recruitment', zh: '招募' },
  { key: 'setting', en: 'Setting', zh: '场所' },
  { key: 'organisation', en: 'Organisation', zh: '组织与资源' },
  { key: 'flex_delivery', en: 'Flexibility: delivery', zh: '灵活性（实施）' },
  { key: 'flex_adherence', en: 'Flexibility: adherence', zh: '灵活性（依从）' },
  { key: 'follow_up', en: 'Follow-up', zh: '随访' },
  { key: 'primary_outcome', en: 'Primary outcome', zh: '主要结局' },
  { key: 'primary_analysis', en: 'Primary analysis', zh: '主要分析' },
] as const;

export type PrecisDomainKey = (typeof PRECIS_DOMAINS)[number]['key'];

/** 归一化后的评分。 */
export interface NormalizedScore {
  /** 展示标签，严格取值见 05 §4 */
  label: string | null;
  /** 数值（3-B/3-U 记 3；N/A/AS 记 null） */
  numeric: number | null;
  /** 3-U：信息不足（**不是**真正平衡） */
  uncertain?: boolean;
  /** AS: …：按组分别评分，不进总分/均值 */
  armSpecific?: boolean;
  /** 不在 05 允许的取值里 */
  invalid?: boolean;
}

/**
 * 归一化一个 PRECIS-2 评分（模型输出与人工金标准共用）。
 *
 * 模型常见写法：`3B`、`3-U`、`NA`、`n/a`、数字 3、`"3"`、`AS: Acupressure=1; Exercise=3-B`。
 * 这里只做**形式**归一化，不替模型判断该给几档。
 */
export function normalizeModelScore(raw: unknown): NormalizedScore {
  const s = String(raw ?? '').trim();
  if (!s) return { label: null, numeric: null };

  if (/^n\/?a$/i.test(s) || s === '/') return { label: 'N/A', numeric: null };

  const arm = /^AS\s*[:：]\s*(.+)$/i.exec(s);
  if (arm) return { label: `AS: ${arm[1]!.trim()}`, numeric: null, armSpecific: true };

  const b = /^3\s*[-–—]?\s*B$/i.exec(s);
  if (b) return { label: '3-B', numeric: 3 };

  const u = /^3\s*[-–—]?\s*U$/i.exec(s);
  if (u) return { label: '3-U', numeric: 3, uncertain: true };

  if (/^[1-5]$/.test(s)) return { label: s, numeric: Number(s) };

  return { label: s, numeric: null, invalid: true };
}

/** 单个领域的评分结果。 */
export interface PrecisDomainResult {
  key: PrecisDomainKey;
  label: string | null;
  numeric: number | null;
  uncertain?: boolean;
  armSpecific?: boolean;
  invalid?: boolean;
  /** 模型回传的逐字引文（原文） */
  quotes: string[];
  /** 本地定位成功的证据（可能少于 quotes） */
  evidence: Evidence[];
  /** 模型写的证据摘要（英文，带页码/表号） */
  evidenceText: string;
  /** 模型写的评分依据（相对 usual care 的解释） */
  rationale: string;
  confidence: number;
  /** 是否至少有一条引文在文档中定位成功 */
  grounded: boolean;
  /** 3-U / N/A 这类本来就没有可引原句的情形 */
  absenceBased?: boolean;
}

export interface PrecisPayload {
  /** 必须先于评分交代的目标常规诊疗情境 */
  usualCareContext: string;
  domains: Partial<Record<PrecisDomainKey, PrecisDomainResult>>;
  /** 方法/流程图/表格/摘要互相冲突之处（05 §1.9 要求显式记录） */
  conflicts: string[];
}

/* ------------------------------- 提示词 ------------------------------- */

const DOMAIN_RULES = `
## 你必须评的九个领域（顺序固定）

1. eligibility（纳排标准）—— 入组者与常规诊疗人群有多像？
   解释性：窄年龄/严格严重度门槛/窄病程/排除常见合并症/洗脱期/读写或设备要求/强制证型分类/低危手术筛选。
   实用性：大多数常规患者都符合；排除项主要是常规禁忌；保留异质性。
   **常规禁忌不重罚**：单项常见排除（如既往针刺、某种合并用药）不应把分数压到 2 以下；
   只有多条限制叠加、明显把常规人群筛成"干净样本"时才给 1–2。

2. recruitment（招募）—— 超出常规诊疗路径的招募努力有多少？
   实用：连续/常规门诊住院识别，无广告/补偿/免费治疗。
   解释：媒体广告、群发邮件、登记库邮寄、社区外展、补偿、免费检查/治疗、专门筛查团队。
   筛选漏斗比例大只是佐证，**不能单凭比例判分**。
   **判定门槛要低**：只要出现"从某医院/门诊/病房/社区招募或筛查""由某科医生筛查""住院患者""门诊患者"
   这类来源线索，就视为**已描述常规识别路径 → 通常 4**；明确写连续/连续入组 → 5。
   **不要因为没写 consecutive、广告、补偿就给 3-U**——这些是"没有额外招募努力"的证据，不是信息缺失。
   3-U 只留给**通篇没有任何来源线索**（连从哪类机构/哪类患者来都没说）的论文。

3. setting（场所）—— 试验地点与目标常规使用场所有多像？
   解释：单一专科学术中心、针灸学校/实验室、非代表性的高度专门服务。
   实用：**多个普通临床点（含多家医院门诊）→ 4**；单一普通临床点 → 3（或 3-B）；
   医院/社区网络、真实诊疗现场、居家/远程（若这就是目标场景）→ 4–5。
   单一真实临床点**通常是 3-B**，不自动是 1 或 2。

4. organisation（组织与资源）—— 人员、专长、培训、设备、服务资源与常规诊疗有多像？
   降分：异常资深/高资质操作者、硕士级/专科专属、能力考核、大量方案培训、反复保真度监测、
   特殊假针装置、专有刺激仪、专用房间、额外研究助理/协调员、跨中心强化标准化、改变实施的实验/影像设备。
   提分：现有护士/临床医生/常规从业者实施；只需简短可迁移培训；便宜且常规可得的材料；不增加就诊。
   **不因**"操作者受过 300 小时培训/持证针灸师/多年经验"降分——这是该疗法的常规资质；
   降分只用于**超出常规执业**的专长或资源要求。假针装置属于对照臂实施，本身不降 Organisation。

5. flex_delivery（灵活性：实施）—— 操作者/参与者对"怎么实施"有多少裁量？
   解释：所有人固定穴位/深度/必须得气/固定电波形频率电流/固定时长/固定频次与总次数/固定相对手术或月经的时间/不许加穴或调整。
   实用：个体化选穴、辨证论治、随症加穴、弹性频次或时长、常规执业判断、按疼痛部位/合并症状/偏好调整。
   仅按耐受调强度 = 轻微裁剪，一般仍是 1 或 2；固定核心处方 + 少量预设可选穴 = 通常 2 或 3-B；
   真正的常规个体化针刺可以是 4 或 5。
   若选穴按辨证/个体化（而非固定处方），即使疗程、频次、留针时间固定，也**不低于 3-B、通常 4**——
   固定剂量不能抹掉个体化。不同臂差异大 → AS。

6. flex_adherence（灵活性：依从）—— 为保证参与者依从做了多少额外努力？
   解释：高就诊负担、每日多次自我治疗、密集监测、强制日记、主动提醒、因不依从排除、严格限制常规治疗。
   实用：普通门诊就诊预期、可选或最少监测的自我照护、弹性使用、无特殊强制。
   **常规疗程本身**（8–12 次门诊）通常 **3-B**：既不额外加码，也不是毫无负担；
   ≥20 次治疗/每日自我治疗/日记提醒/严格限制常规治疗 → 2；
   只有 1–2 次接触或单次住院操作 → 4–5。
   **若日记/问卷本身就是结局测量工具（如症状日记、VMS 日记），其负担记入 Follow-up，
   不因此重复扣 Adherence**；按需使用并记录的常规救援用药也属于常规诊疗，不单独降分。
   **N/A 只用于**：治疗由工作人员在一次不可避免的诊疗中完成、参与者没有有意义的依从行为
   （如围手术期单次、麻醉下治疗、ICU/昏迷/新生儿）。
   **需要多次门诊、自我治疗、家用设备、日记、遵守限制的，不能给 N/A。**

7. follow_up（随访）—— 随访接触与测量比常规诊疗多密集？判"强度"，不只判"时长"。
   解释：每日症状日记、反复化验/抽血、研究性影像/超声、活动记录仪、密集时点的生理监测、
   反复盲法/可信度/期望/满意度评估、大套问卷、常规诊疗结束后仍打研究电话。
   实用：常规病历、普通住院观察、一两次临床时点评估、常规出院/服务复查、适合常规实施的简短远程调查。
   长随访若与常规诊疗一致仍可实用；短随访若测量密集且研究专属仍可解释。
   **≥3 个研究时点且每个时点都有多套问卷/量表 + 体格测量/化验** → 通常 2；
   再加上研究护士专门随访、日记、影像/活动记录仪 → 1。

8. primary_outcome（主要结局）—— 主要结局对参与者有多直接重要？
   先定预设主要结局（方法/方案/注册/SAP）。5：疼痛、症状严重度、睡眠、疲乏、患者功能、生活质量、
   有意义的并发症、死亡、患者总体改善、临床可解释的应答标准。
   4：临床医生评定的功能性疾病指标、首次排气/排便时间、住院时长、临床相关康复里程碑、ACR20 类复合应答。
   降分：生物标志物、激素、化验/影像替代、纯机制性生理测量、无直接症状/功能相关性的结构指标。
   多个预设共同主要结局且都患者重要 → 作为一组评；**没有明确主结局或层级 → 3-U**；不得看结果后挑。
   **降低 3-U 门槛**：只要摘要/方法/注册中有一个被明确标为 primary/main outcome（或第一个报告的
   患者重要结局且全文围绕它），就评它；只有**多个并列结局且全文无任何主次线索**时才 3-U。

9. primary_analysis（主要分析）—— 主要分析在多大程度上保留随机分组？判**实际分析**，不判作者标签。
   **只判主要结局的主要分析**；次要结局、亚组、敏感性分析里的排除不影响本领域评分（除非主要分析本身也这么做）。
   **降低 3-U 门槛**：文中任何位置出现 ITT / intention-to-treat / 意向性分析 / 全分析集，
   且没有明确的 PP/完成者分析证据 → **至少 4**；写了全随机者纳入 + 可辩护缺失处理 → 5。
   只有**通篇找不到分析人群/缺失处理**的描述时才 3-U。
   5：全部随机者纳入、明确实施 ITT、缺失用 MI/无应答填补/混合模型/GEE 等可辩护的预设方法；
   敏感性分析是加分佐证，**不是 5 的必要条件**——ITT + 可辩护缺失处理即可给 5。
   4：几乎所有随机者保留、极少排除、基本完整的随机分析、稳健模型，但不是完美全 ITT。
   3-B：改良 ITT 排除无基线后数据者；小的完整病例损失但有有意义的敏感性分析；真正中间态。
   2：完整病例分析且有明显随机后失访；改良 ITT 有显著排除；无稳健缺失处理方法；明显但非极端偏离。
   1：PP/按实际接受治疗分析；大量完整病例损失；替换随机者；排除不依从者；因随机后并发症或换治疗排除；未能保留随机队列。
   文中声称 ITT 但表格/流程图只分析应答者/完成者 → 按实际分析评；随机/排除/分析人数对不上 → 只有当分析无法判断时才 3-U；
   若明显是完整病例或 PP，就给相应低分并把不一致写进 conflicts。

## 标签硬规则

- 3-B 只用于**设计本身就是中间态**；3-U 只用于**证据不足/自相矛盾**。两者绝不能混用。
- 3-U 必须同时说明"哪一节/哪一页缺了什么"。
- N/A 只按上面第 6 条。
- 同一领域不同活性臂差异实质 → 用 \`AS: 臂名=标签; 臂名=标签\`，不要强行给一个数。
- 证据层级：方案/SAP > 方法 > CONSORT 流程图 > 表图 > 结果正文 > 摘要。
  方法与正文冲突时，把冲突写进 conflicts，不要静默挑有利解释。
- 不得编造未报告的信息；不得因为"随机"两个字就认定真正随机；不得因为摘要说 pragmatic 就判实用。
`.trim();

const OUTPUT_SPEC = `
## 输出（只输出一个 JSON 对象，不要任何解释文字）

{
  "usualCareContext": "先用 2-3 句英文交代：该干预在真实世界针对什么人群、在什么场景、由谁实施、对照是什么。评分都相对这个情境。",
  "domains": {
    "eligibility": { "score": "2", "quotes": ["逐字原文 1", "逐字原文 2"], "evidence": "English, 1-3 sentences, cite page/table", "rationale": "English, why this score relative to usual care", "confidence": 0.8 },
    "recruitment": { ... }, "setting": { ... }, "organisation": { ... },
    "flex_delivery": { ... }, "flex_adherence": { ... }, "follow_up": { ... },
    "primary_outcome": { ... }, "primary_analysis": { ... }
  },
  "conflicts": ["methods 说随机 240 例，流程图 analysed 198 例（PDF p.4 vs Table 1）"]
}

规则：
- 九个 key 必须全部出现，顺序不限。
- \`score\` 只能是 "1" / "2" / "3-B" / "3-U" / "4" / "5" / "N/A" / "AS: …"。
- \`quotes\`：1-2 段**逐字**英文原文（从给定材料复制，不得改写/翻译/拼接；每段 ≥ 8 个字符）。
  除 3-U 与 N/A 外，**至少给 1 段**；3-U/N/A 可以给空数组，但 evidence 里必须写清"哪一节/哪一页缺什么"。
- \`evidence\` 与 \`rationale\` 用英文；evidence 写事实，rationale 写"为什么这个分数"，两者不要互相复制。
- 引文不要引用摘要作为唯一依据（05 §6.3）。
- 不确定就降低 confidence，不要编造。
`.trim();

const SYSTEM = `你是 PRECIS-2 评分员，只对**一篇**针刺/穴位相关随机对照试验做九领域适用性评分。
这不是偏倚风险评价，不是质量打分，也不是疗效判断。

${DOMAIN_RULES}

${OUTPUT_SPEC}`;

/* ------------------------------- 工具 ------------------------------- */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const clamp01 = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  return Math.min(1, Math.max(0, x));
};

const cleanQuotes = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out: string[] = [];
  for (const q of arr) {
    const s = str(q).replace(/\s+/g, ' ');
    if (s.length < 8) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
};

/** 领域键 → 中文/英文标签，供导出与报告。 */
export const domainLabel = (key: PrecisDomainKey): { en: string; zh: string } => {
  const d = PRECIS_DOMAINS.find((x) => x.key === key)!;
  return { en: d.en, zh: d.zh };
};

/**
 * 数值汇总（仅用于数据管理，**不是** PRECIS-2 官方总分）。
 * 排除 N/A 与 AS；3-B/3-U 按 3 计入，3-U 另记 uncertain 数。
 */
export function summarizeDomains(domains: Partial<Record<PrecisDomainKey, PrecisDomainResult>>): {
  scored: number;
  numericTotal: number | null;
  numericMean: number | null;
  uncertain: number;
  notApplicable: number;
  armSpecific: number;
  ungrounded: number;
} {
  let scored = 0;
  let total = 0;
  let uncertain = 0;
  let notApplicable = 0;
  let armSpecific = 0;
  let ungrounded = 0;
  for (const d of PRECIS_DOMAINS) {
    const r = domains[d.key];
    if (!r) continue;
    if (!r.grounded && !r.absenceBased) ungrounded++;
    if (r.label === 'N/A') { notApplicable++; continue; }
    if (r.armSpecific) { armSpecific++; continue; }
    if (r.numeric === null || r.numeric === undefined) continue;
    scored++;
    total += r.numeric;
    if (r.uncertain) uncertain++;
  }
  return {
    scored,
    numericTotal: scored ? total : null,
    numericMean: scored ? Number((total / scored).toFixed(4)) : null,
    uncertain,
    notApplicable,
    armSpecific,
    ungrounded,
  };
}

/* ------------------------------- SKILL ------------------------------- */

export function createPrecis2Skill(): Skill<PrecisPayload> {
  const skill: Skill<PrecisPayload> = {
    id: 'precis2',
    version: '0.3.0',
    level: 'cross-cutting',
    description: '按 05 规格对一篇 RCT 做 PRECIS-2 九领域评分（分数 + 逐字引文 + 依据）',
    needs: ['abstract', 'methods', 'results'],
    needsTables: true,
    needsFigures: false,

    async run(ctx: SkillContext): Promise<SkillOutput<PrecisPayload>> {
      const issues: Issue[] = [];
      const unresolved: SkillOutput<PrecisPayload>['unresolved'] = [];

      const materials = collectMaterials(ctx.doc, {
        sections: ['abstract', 'methods', 'results'],
        pages: [1],
        tables: true,
        figures: false,
        maxCharsPerBlock: 8000,
        maxTotalChars: 90_000,
      });

      if (materials.blocks.length === 0) {
        issues.push(warn('没有可用材料（摘要/方法/结果/表格均为空），无法评分', 'NO_MATERIAL'));
        return { skillId: skill.id, level: 'cross-cutting', payload: { usualCareContext: '', domains: {}, conflicts: [] }, unresolved, issues };
      }

      const res = await ctx.llm.invoke({
        system: SYSTEM,
        user: `以下是一篇针刺 RCT 的摘要、方法、结果与表格材料（每段带 [[b块号|p页码]] 锚点）。`
          + `请按 PRECIS-2 九领域规则评分，并给出逐字引文。\n\n${materials.text}`,
        temperature: 0,
        tag: `${skill.id}@${skill.version}:${ctx.doc.articleId}`,
      });

      if (!res.json || typeof res.json !== 'object') {
        issues.push(warn('模型未返回结构化 JSON', 'NO_STRUCTURED_OUTPUT'));
        return { skillId: skill.id, level: 'cross-cutting', payload: { usualCareContext: '', domains: {}, conflicts: [] }, unresolved, issues };
      }

      const raw = res.json as Record<string, unknown>;
      const rawDomains = (raw.domains && typeof raw.domains === 'object' ? raw.domains : raw) as Record<string, unknown>;
      const domains: Partial<Record<PrecisDomainKey, PrecisDomainResult>> = {};

      for (const meta of PRECIS_DOMAINS) {
        const key = meta.key;
        const node = rawDomains[key];
        if (!node || typeof node !== 'object') {
          issues.push(warn(`缺少领域 ${key} 的评分`, 'PRECIS_DOMAIN_MISSING', { path: key }));
          continue;
        }
        const rec = node as Record<string, unknown>;
        const score = normalizeModelScore(rec.score ?? rec.label);
        const quotes = cleanQuotes(rec.quotes ?? rec.quote);
        const evidence: Evidence[] = [];
        const foundQuotes: string[] = [];

        for (const [i, q] of quotes.entries()) {
          const g = groundField(ctx.doc, `precis2.${key}.quotes[${i}]`, { value: q, quote: q }, {
            kinds: ['text', 'table', 'title'],
          });
          if (g.field?.evidence?.length) {
            evidence.push(...g.field.evidence);
            foundQuotes.push(q);
          }
        }

        const absenceBased = score.label === '3-U' || score.label === 'N/A';
        const grounded = evidence.length > 0;
        if (!grounded && !absenceBased) {
          issues.push(warn(
            `${key} 的评分 ${score.label ?? '(空)'} 没有任何可定位的引文——按"无证据不入库"标为未接地，交人工复核`,
            'PRECIS_UNGROUNDED_SCORE',
            { path: key },
          ));
          unresolved.push({
            reason: '评分缺少可定位的逐字引文（疑似模型幻觉或引文转录偏差）',
            raw: quotes[0] ?? '',
            evidence: [],
            confidence: clamp01(rec.confidence),
          });
        }

        if (score.invalid) {
          issues.push(warn(`${key} 的评分「${score.label}」不在 05 允许的标签内`, 'PRECIS_INVALID_LABEL', { path: key }));
        }

        domains[key] = {
          key,
          label: score.label,
          numeric: score.numeric,
          ...(score.uncertain ? { uncertain: true } : {}),
          ...(score.armSpecific ? { armSpecific: true } : {}),
          ...(score.invalid ? { invalid: true } : {}),
          quotes: foundQuotes,
          evidence,
          evidenceText: str(rec.evidence),
          rationale: str(rec.rationale),
          confidence: clamp01(rec.confidence),
          grounded,
          ...(absenceBased ? { absenceBased: true } : {}),
        };

        if (score.invalid) {
          issues.push(warn(`${key} 的评分「${score.label}」不在 05 允许的标签内`, 'PRECIS_INVALID_LABEL', { path: key }));
        }
      }

      const conflicts = Array.isArray(raw.conflicts)
        ? raw.conflicts.map(str).filter(Boolean)
        : [];

      const payload: PrecisPayload = {
        usualCareContext: str(raw.usualCareContext),
        domains,
        conflicts,
      };

      // 材料被裁剪时留痕：评分可能因此偏向"报告不足"
      if (materials.trimmed > 0) {
        issues.push(warn(`材料跳过/裁剪 ${materials.trimmed} 块（最终 ${materials.chars} 字符，上限 90000）`, 'PRECIS_MATERIAL_TRIMMED'));
      }

      return { skillId: skill.id, level: 'cross-cutting', payload, unresolved, issues };
    },

    /* ------------------------- 确定性校验器 ------------------------- */
    validate(output: SkillOutput<PrecisPayload>): readonly Issue[] {
      const issues: Issue[] = [];
      const p = output.payload;

      for (const meta of PRECIS_DOMAINS) {
        const r = p.domains[meta.key];
        if (!r) {
          issues.push(warn(`领域 ${meta.key} 缺失`, 'PRECIS_DOMAIN_MISSING', { path: meta.key }));
          continue;
        }
        if (!r.label) {
          issues.push(warn(`领域 ${meta.key} 没有分数`, 'PRECIS_SCORE_EMPTY', { path: meta.key }));
          continue;
        }
        if (r.label === '3-B' && r.uncertain) {
          issues.push(warn(`${meta.key}: 3-B 与 3-U 冲突（3-B 不应带 uncertain）`, 'PRECIS_LABEL_CONFLICT', { path: meta.key }));
        }
        if (r.label === '3-U' && r.numeric !== 3) {
          issues.push(warn(`${meta.key}: 3-U 的数值应为 3（仅用于数据管理）`, 'PRECIS_3U_NUMERIC', { path: meta.key }));
        }
        if (r.armSpecific && !/^AS:\s*.+[=＝].+/.test(r.label)) {
          issues.push(warn(`${meta.key}: AS 标签缺少"臂=分数"`, 'PRECIS_AS_FORMAT', { path: meta.key }));
        }
        if (r.label === 'N/A' && meta.key !== 'flex_adherence') {
          issues.push(warn(`N/A 出现在 ${meta.key}（05 §4.3 只允许灵活性-依从）`, 'PRECIS_NA_OUTSIDE_ADHERENCE', { path: meta.key }));
        }
        if (!r.evidenceText && !r.absenceBased) {
          issues.push(warn(`${meta.key}: 缺少证据摘要`, 'PRECIS_EVIDENCE_TEXT_EMPTY', { path: meta.key }));
        }
        if (!r.rationale) {
          issues.push(warn(`${meta.key}: 缺少评分依据`, 'PRECIS_RATIONALE_EMPTY', { path: meta.key }));
        }
        if (!r.grounded && !r.absenceBased) {
          issues.push(warn(`${meta.key}: 分数没有可定位引文`, 'PRECIS_UNGROUNDED_SCORE', { path: meta.key }));
        }
      }

      if (!p.usualCareContext) {
        issues.push(warn('缺少目标常规诊疗情境（usualCareContext），评分缺少参照系', 'PRECIS_NO_USUAL_CARE'));
      }
      return issues;
    },
  };

  return skill;
}
