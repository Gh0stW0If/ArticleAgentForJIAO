/**
 * @aa/europepmc — 与已抽取 meta 的比对
 *
 * 定位：**第二校验源**，与 `@aa/crossref` 的 `resolveAndVerify` 同构，但策略更保守——
 * Europe PMC 只做两件事：
 *
 *   1. **题名补全**（`titleCompletion`）：当自己抽到的题名是 EPMC 题名的**前缀**时，
 *      说明抽漏了副标题（实测 74% 的题名失分是这个形态：金标准 `… Constipation A Randomized Trial`，
 *      我们只抽到 `… Constipation`）。此时以 EPMC 为准补全。
 *   2. **冲突记录**（`conflicts`）：题名/期刊/年份明显对不上时**只报告不改值**——
 *      本源没有 Crossref 那样的"DOI 权威性"论证，贸然覆盖风险更大。
 *
 * ⚠️ 不做的事：**不碰 `authorContact`**。理由见 `client.ts` 文件头的实测数据。
 */

import type { EuropePmcWork } from './client.js';

export type EpMcField = 'title' | 'journal' | 'pubYear';
export type EpMcVerdict = 'match' | 'mismatch' | 'epmc_missing' | 'pdf_missing';

export interface EpMcComparison {
  field: EpMcField;
  verdict: EpMcVerdict;
  /** 我们抽到的值（PDF 路径的结果） */
  ours?: string;
  /** Europe PMC 的值 */
  theirs?: string;
}

export interface EuropePmcVerification {
  work: EuropePmcWork | null;
  /** DOI 是否取到了记录 */
  found: boolean;
  comparisons: readonly EpMcComparison[];
  /**
   * 题名补全：`ours` 是 EPMC 题名的前缀 → 用 EPMC 的完整题名替换。
   * 没有可补全的情形时为 undefined。
   */
  titleCompletion?: { from: string; to: string };
  /** 供日志/前端展示的说明 */
  notes: readonly string[];
}

/** 归一化用于比较：小写、非字母数字一律折成单空格（题名里的标点/大小写差异不算错）。 */
export function normalizeForCompare(s: string | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
}

/** 年份取四位数比较（`2016`、`2016-02-15`、`Published 2016` 都归到 2016）。 */
function yearOf(s: string | undefined): string | undefined {
  return String(s ?? '').match(/\d{4}/)?.[0];
}

/**
 * 判断我们抽到的题名是否是 EPMC 题名的**真前缀**（且 EPMC 明显更完整）。
 *
 * 只在"前缀"这一种形态上补全，是为了避免把"两个不同来源的不同题名"混进来：
 * 只有"我们的更短、且是对方的开头"才能确定是**抽漏了后半段**，而不是抽错了论文。
 */
export function titlePrefixGain(ours: string | undefined, theirs: string | undefined): boolean {
  const a = normalizeForCompare(ours);
  const b = normalizeForCompare(theirs);
  if (a.length < 12 || b.length < 12) return false;
  if (a === b) return false;
  /* 我们的是对方的前缀，且对方至少多出 8 个字符（排除仅标点差异） */
  return b.startsWith(a) && b.length - a.length >= 8;
}

export function verifyWithEuropePmc(
  ours: { title?: string; journal?: string; pubYear?: string },
  work: EuropePmcWork | null,
): EuropePmcVerification {
  const notes: string[] = [];
  if (!work) {
    return {
      work: null,
      found: false,
      comparisons: [
        { field: 'title', verdict: 'epmc_missing' },
        { field: 'journal', verdict: 'epmc_missing' },
        { field: 'pubYear', verdict: 'epmc_missing' },
      ],
      notes: ['Europe PMC 未收录该 DOI，本源无贡献'],
    };
  }

  const cmp = (field: EpMcField, a: string | undefined, b: string | undefined, equal: (x: string, y: string) => boolean): EpMcComparison => {
    if (!b) return { field, verdict: 'epmc_missing', ...(a ? { ours: a } : {}) };
    if (!a) return { field, verdict: 'pdf_missing', theirs: b };
    return equal(a, b) ? { field, verdict: 'match', ours: a, theirs: b } : { field, verdict: 'mismatch', ours: a, theirs: b };
  };
  const textEq = (x: string, y: string): boolean => normalizeForCompare(x) === normalizeForCompare(y);

  const comparisons: EpMcComparison[] = [
    /* 题名的"一致"放宽为"一方是另一方前缀"——副标题有无不算错，由 titleCompletion 单独处理 */
    cmp('title', ours.title, work.title, (x, y) => {
      const a = normalizeForCompare(x); const b = normalizeForCompare(y);
      return a === b || b.startsWith(a) || a.startsWith(b);
    }),
    cmp('journal', ours.journal, work.journal, textEq),
    cmp('pubYear', ours.pubYear, work.pubYear, (x, y) => yearOf(x) === yearOf(y)),
  ];

  let titleCompletion: EuropePmcVerification['titleCompletion'];
  if (titlePrefixGain(ours.title, work.title)) {
    titleCompletion = { from: String(ours.title), to: String(work.title) };
    notes.push(`题名补全：Europe PMC 的题名更完整（多 ${normalizeForCompare(work.title).length - normalizeForCompare(ours.title).length} 字符），以 EPMC 为准`);
  }

  for (const c of comparisons) {
    if (c.verdict === 'mismatch') notes.push(`Europe PMC 与本地取值不一致：${c.field}（本地「${c.ours}」 vs EPMC「${c.theirs}」）`);
  }
  return { work, found: true, comparisons, ...(titleCompletion ? { titleCompletion } : {}), notes };
}
