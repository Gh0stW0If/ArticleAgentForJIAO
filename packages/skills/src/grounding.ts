/**
 * @aa/skills — 把模型输出"落地"为带证据的 FieldValue
 *
 * 这是整套设计里最关键的一环，理由：
 *
 *   ⚠️ 模型看不到页面坐标，让它给坐标必然编造。
 *
 * 因此约定模型只回传：
 *   { value: "<归一化值>", quote: "<支撑该值的原文片段>", confidence: 0-1 }
 *
 * 本模块负责：
 *   1. 用 `locateEvidence()` 在 MiniDoc 里定位 quote → 得到 page + bbox；
 *   2. 定位失败 → 该字段**拒绝入库**，转入 unresolved（不伪造坐标）；
 *   3. 用 `makeField()` 构造 FieldValue，强制执行"必须有证据"的不变量。
 *
 * 另外提供确定性的 quote 校验：quote 必须真的出现在被引用的块里，
 * 否则视为模型幻觉（常见于模型"记得"某篇论文的内容而不是真的读到了）。
 */

import {
  makeField,
  locateEvidence,
  normalizeWhitespace,
  type Evidence,
  type FieldValue,
  type MiniDoc,
  type MiniDocBlock,
  type UnresolvedItem,
  type BlockType,
} from '@aa/core';

/** 模型对单个字段的原始回传。 */
export interface RawFieldClaim {
  /** 归一化后的值（可能为空字符串表示"确实报告了但没有值"） */
  value?: string | null;
  /** 支撑该值的原文片段，必须逐字来自文档 */
  quote?: string | null;
  /** 模型自评置信度 0~1 */
  confidence?: number;
  /** 受控编码（若模型能确定，如 "1"、"2/5"）；通常留空由本地解码器补 */
  code?: string | null;
  /** 其它候选 */
  alternatives?: { value: string; confidence: number }[];
}

/** 模型对整份输出的回传结构。 */
export type RawSkillResponse = Record<string, RawFieldClaim | RawFieldClaim[] | undefined>;

export interface GroundOptions {
  /** 该 SKILL 期望的块类型（限制证据来源，避免从参考文献里取证） */
  kinds?: readonly BlockType[];
  /** 优先在这些页找（如前 2 页取 meta） */
  preferPages?: readonly number[];
  /** 每个字段要求的最低置信度，低于则转入 unresolved。默认 0 */
  minConfidence?: number;
  /** 找不到 quote 时是否仍以"整块"作为证据。默认 false（严格） */
  allowBlockFallback?: boolean;
}

export interface GroundResult<TPayload> {
  /** 成功落地的字段（键名对应 SKILL 声明的字段） */
  payload: TPayload;
  /** 未能落地的候选，交人工复核 */
  unresolved: UnresolvedItem[];
  /** 落地过程中的问题 */
  issues: { field: string; reason: string; raw: string }[];
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * 校验 quote 是否真的出现在指定块里（防幻觉）。
 * 返回命中的块，或 null。
 */
function verifyQuoteInBlock(block: MiniDocBlock, quote: string): boolean {
  const hay = block.type === 'table'
    ? [block.text, block.table?.caption, block.table?.footnote, block.table?.html].filter(Boolean).join('\n')
    : block.text;
  const a = normalizeWhitespace(hay);
  const b = normalizeWhitespace(quote);
  if (b.length >= 3 && a.includes(b)) return true;
  // 容忍 OCR 标点差异
  const strip = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const bs = strip(quote);
  return bs.length >= 5 && strip(hay).includes(bs);
}

/** 把定位到的块转成 Evidence。 */
function toEvidence(block: MiniDocBlock, quote: string, kind: Evidence['kind']): Evidence {
  return {
    kind,
    page: block.page,
    bbox: block.bbox,
    quote: normalizeWhitespace(quote),
    blockId: `b${block.index}`,
  };
}

function evidenceKindOf(block: MiniDocBlock): Evidence['kind'] {
  if (block.type === 'table') return 'table';
  if (block.type === 'figure') return 'figure';
  return 'text';
}

/**
 * 定位统计：模型回传的 `quote` **是否逐字命中材料**。
 *
 * 为什么要单独统计：提示词里已经要求"quote 逐字复制、不短于 6 字符"，但模型
 * 经常回传"比原文更规范"的版本（去掉排版空格、把全角转半角、把 `41.75 ± 11.15`
 * 缩成 `41.75`）。严格匹配会失败并走降级窗口，降级窗口再失败就**整条字段被丢弃**。
 * `exact` 与 `degraded*` 的比例就是"提示词有没有被听进去"的直接读数——
 * 改完提示词后这个比例应当上升，`notFound` 应当下降。
 */
export const groundingStats = {
  /** 整串逐字命中 */
  exact: 0,
  /** 降级 1：取中间切片命中（模型首尾加料） */
  degradedMid: 0,
  /** 降级 2：取后半段命中（模型前面补了前缀） */
  degradedTail: 0,
  /** 三种都失败 → 字段被丢弃 */
  notFound: 0,
  /** 模型没给 quote → 直接拒绝入库 */
  noQuote: 0,
};

/** 清零统计（每次运行抽取前调用，保证读数是本次运行的口径）。 */
export function resetGroundingStats(): void {
  groundingStats.exact = 0;
  groundingStats.degradedMid = 0;
  groundingStats.degradedTail = 0;
  groundingStats.notFound = 0;
  groundingStats.noQuote = 0;
}

/**
 * 定位 quote，带**降级窗口**。
 *
 * 为什么需要降级：模型经常回传"比原文更规范"的 quote，例如原文里
 * DOI 因排版被拆成 `http://dx.doi.org/10.1136/ acupmed-2015-010950`（中间有空格），
 * 而模型回传的是无空格的 `http://dx.doi.org/10.1136/acupmed-2015-010950`。
 * 严格子串匹配会失败，但核心内容其实在文档里。
 *
 * 因此：先整串匹配；失败则用 quote 的前/后半段（去掉两端）再试；
 * 仍失败就放弃——**不会退回"整块"当证据**，避免把块内无关内容算作证据。
 */
function locateWithFallback(
  doc: MiniDoc,
  quote: string,
  opts: { kinds?: readonly BlockType[]; preferPages?: readonly number[] },
): { block: MiniDocBlock; exact: boolean; usedQuote: string } | null {
  const tryQuote = (q: string): { block: MiniDocBlock; exact: boolean } | null => {
    const s = normalizeWhitespace(q);
    if (s.length < 6) return null;
    return locateEvidence(doc, s, opts as Parameters<typeof locateEvidence>[2]);
  };

  const whole = tryQuote(quote);
  if (whole) { groundingStats.exact++; return { ...whole, usedQuote: quote }; }

  // 降级 1：取中间切片（模型常首尾加料）
  const n = normalizeWhitespace(quote).length;
  if (n >= 24) {
    const mid = normalizeWhitespace(quote).slice(Math.floor(n * 0.15), Math.floor(n * 0.85));
    const hit = tryQuote(mid);
    if (hit) { groundingStats.degradedMid++; return { ...hit, usedQuote: mid }; }
  }
  // 降级 2：取后半段（模型常在前面补 URL/前缀）
  if (n >= 16) {
    const tail = normalizeWhitespace(quote).slice(Math.floor(n * 0.4));
    const hit = tryQuote(tail);
    if (hit) { groundingStats.degradedTail++; return { ...hit, usedQuote: tail }; }
  }
  groundingStats.notFound++;
  return null;
}

/**
 * 单字段落地。
 *
 * @param fieldPath 形如 'article.condition'，用于错误信息与 unresolved 记录
 */
export function groundField(
  doc: MiniDoc,
  fieldPath: string,
  claim: RawFieldClaim,
  opts: GroundOptions = {},
): { field?: FieldValue; unresolved?: UnresolvedItem; issue?: string } {
  const rawValue = claim.value ?? '';
  const quote = claim.quote ?? '';
  const confidence = typeof claim.confidence === 'number' ? Math.min(1, Math.max(0, claim.confidence)) : 0.5;

  // 无 quote：直接拒绝（核心不变量）
  if (!quote.trim()) {
    groundingStats.noQuote++;
    if (!opts.allowBlockFallback) {
      return {
        unresolved: {
          skillId: fieldPath,
          reason: '模型未提供支撑原文（quote），按不变量拒绝入库',
          raw: rawValue,
          evidence: [],
          confidence,
        },
      };
    }
    return { issue: `${fieldPath}: 缺少 quote 且未启用块回退` };
  }

  const found = locateWithFallback(doc, quote, {
    ...(opts.kinds ? { kinds: opts.kinds } : {}),
    ...(opts.preferPages ? { preferPages: opts.preferPages } : {}),
  });

  if (!found) {
    return {
      unresolved: {
        skillId: fieldPath,
        reason: '所提供的 quote 无法在文档中定位（疑似模型幻觉或转录偏差）',
        raw: rawValue || quote,
        evidence: [],
        confidence,
      },
    };
  }

  // 用实际命中的片段作为证据原文（保证 quote 真的在文档里）
  const evidenceQuote = found.usedQuote;

  if (opts.minConfidence !== undefined && confidence < opts.minConfidence) {
    return {
      unresolved: {
        skillId: fieldPath,
        reason: `置信度 ${confidence} 低于阈值 ${opts.minConfidence}`,
        raw: rawValue || quote,
        evidence: [toEvidence(found.block, evidenceQuote, evidenceKindOf(found.block))],
        confidence,
      },
    };
  }

  const evidence = toEvidence(found.block, evidenceQuote, evidenceKindOf(found.block));

  const field = makeField(fieldPath, {
    raw: rawValue || evidenceQuote,
    evidence: [evidence],
    provenance: 'model',
    confidence,
    ...(claim.code ? { code: claim.code } : {}),
    ...(claim.alternatives?.length
      ? { alternatives: claim.alternatives.map((a) => ({ raw: a.value, confidence: a.confidence })) }
      : {}),
  });

  return { field };
}

/**
 * 嵌套结构的落地。
 *
 * 用途：outcome SKILL 的输出是嵌套的（`{ outcomeName: {...}, baseline: {...} }`）。
 * 数组元素由调用方逐个传入，因此需要 `rawPrefix` 把行内路径补全成映射表的键。
 *
 * @param raw 模型回传的**单个元素的**对象
 * @param pathMap 以「含下标的完整输入路径」为键，如
 *        `{ 'outcomes.0.baseline.estimateType': 'outcomes.0.timepoints.baseline.continuous.estimateType' }`
 * @param rawPrefix 本次元素在数组中的前缀，如 `outcomes.0`
 */
export function groundNested<TPayload extends Record<string, unknown>>(
  doc: MiniDoc,
  raw: unknown,
  pathMap: Readonly<Record<string, string>>,
  opts: GroundOptions = {},
  rawPrefix = '',
): GroundResult<TPayload> {
  const payload: Record<string, unknown> = {};
  const unresolved: UnresolvedItem[] = [];
  const issues: { field: string; reason: string; raw: string }[] = [];

  const setDeep = (path: string, value: unknown): void => {
    if (process.env.AA_DEBUG) console.error('[setDeep]', JSON.stringify(path));
    const parts = path.split('.');
    let cur: Record<string, unknown> = payload;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      // 数字段必须建数组，否则会得到 { outcomes: { 0: … } } 而非数组。
      // 判据用「类型」而不是 === undefined：稀疏数组的槽位读出来是 undefined，
      // 但 typeof undefined !== 'object'，所以必须按类型判断才会补建。
      const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
      const want = nextIsIndex ? 'array' : 'object';
      const got = Array.isArray(cur[k]) ? 'array' : typeof cur[k];
      if (got !== want) cur[k] = nextIsIndex ? [] : {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  };

  const walk = (node: unknown, prefix: string): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return;
    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const localPath = prefix ? `${prefix}.${key}` : key;
      const fullPath = rawPrefix ? `${rawPrefix}.${localPath}` : localPath;

      const isClaim =
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ('value' in (value as object) || 'quote' in (value as object) || 'confidence' in (value as object));

      if (isClaim) {
        const canonical = pathMap[fullPath];
        if (!canonical) continue;
        const r = groundField(doc, canonical, value as RawFieldClaim, opts);
        if (r.field) setDeep(canonical, r.field);
        if (r.unresolved) unresolved.push(r.unresolved);
        if (r.issue) issues.push({ field: canonical, reason: r.issue, raw: '' });
        continue;
      }

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, localPath);
      }
    }
  };

  walk(raw, '');
  return { payload: payload as TPayload, unresolved, issues };
}

/**
 * 批量落地：按 `fieldMap`（JSON 键 → 规范字段名）把模型回传转成 payload。
 *
 * @param fieldMap 例如 { title: 'title', journal: 'journal', condition: 'condition' }
 */
export function groundResponse<TPayload extends Record<string, unknown>>(
  doc: MiniDoc,
  raw: RawSkillResponse,
  fieldMap: Readonly<Record<string, string>>,
  opts: GroundOptions = {},
): GroundResult<TPayload> {
  const payload: Record<string, unknown> = {};
  const unresolved: UnresolvedItem[] = [];
  const issues: { field: string; reason: string; raw: string }[] = [];

  for (const [jsonKey, canonical] of Object.entries(fieldMap)) {
    const claims = asArray(raw[jsonKey]);
    if (!claims.length) continue;

    const landed: FieldValue[] = [];
    for (const claim of claims) {
      const r = groundField(doc, canonical, claim, opts);
      if (r.field) landed.push(r.field);
      if (r.unresolved) unresolved.push(r.unresolved);
      if (r.issue) issues.push({ field: canonical, reason: r.issue, raw: claim.value ?? '' });
    }

    if (landed.length === 0) continue;
    // 多值字段（如多个资助）：保留主值 + 其余进 alternatives
    if (landed.length === 1) {
      payload[canonical] = landed[0];
    } else {
      const [first, ...rest] = landed;
      payload[canonical] = {
        ...first!,
        alternatives: [
          ...(first!.alternatives ?? []),
          ...rest.map((f) => ({ raw: f.raw, confidence: f.confidence })),
        ],
        evidence: [...first!.evidence, ...rest.flatMap((f) => f.evidence)],
      } satisfies FieldValue;
    }
  }

  return { payload: payload as TPayload, unresolved, issues };
}
