/**
 * @aa/crossref — 元信息校验：PDF 内取值 vs Crossref 权威记录
 *
 * 需求 4：用 Crossref 验证文章 meta 信息是否准确。
 *
 * 设计要点：
 *
 *  1. **不自动"修正"**，只给出一致性判定与差异明细。
 *     实测教训（docs/02-gold-schema.md）：数据里真实存在跨年份 ID 笔误这类问题，
 *     自动改写会掩盖问题、且不可审计。因此校验结果只做判定 + 记录。
 *
 *  2. **容错比较**：期刊名大小写/缩写、标题标点、作者名单缩写差异很常见，
 *     必须做规范化后比较，否则会产生大量假阳性。
 *
 *  3. **PDF 内 DOI 的可靠性分级**：实测从正文正则捞 DOI 会得到脏值
 *     （如 `10.1136/acupmed-2015-010950group.bmj.com`），因此调用方应同时提供
 *     "从何处取得该 DOI"的信息，便于判断可信度。
 */

import type { CrossrefWork } from '@aa/core';
import { normalizeDoi, isLikelyDoi } from './client.ts';

export type ConsistencyVerdict = 'match' | 'mismatch' | 'partial' | 'unverifiable';

export interface FieldComparison {
  field: 'title' | 'journal' | 'year' | 'authors' | 'doi';
  verdict: ConsistencyVerdict;
  /** PDF 内取值 */
  pdfValue?: string;
  /** Crossref 取值 */
  crossrefValue?: string;
  /** 相似度 0~1（仅对有可比性的字段给出） */
  similarity?: number;
  note?: string;
}

export interface MetaVerification {
  verdict: ConsistencyVerdict;
  /** 用于校验的 DOI（若为空则只能靠标题反查） */
  resolvedDoi?: string;
  /** DOI 是否由调用方提供（而非本次反查得到） */
  doiProvided: boolean;
  crossref?: CrossrefWork;
  comparisons: readonly FieldComparison[];
  /** 供人工复核的说明 */
  notes: readonly string[];
}

/* ------------------------------ 文本规范化 ------------------------------ */

const stripDiacritics = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * 通用规范化：小写、去变音符、删除省略符号、压缩空白、其余标点转空格。
 *
 * ⚠️ 必须先删除撇号类字符再替换其它标点。
 * 否则 `Sjögren's` → `sjogren s`（撇号变空格）会多出一个单字母 token，
 * 破坏期刊名/作者名的相似度比较（实测发现的真实问题）。
 * 注意 `’`(U+2019) 与 `'`(U+0027) 都要处理。
 */
export function normText(s: string): string {
  return stripDiacritics(String(s ?? ''))
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 期刊名规范化。
 * 实测痛点：金标准里写 `Acupuncture in medicine`，Crossref 可能是
 * `Acupuncture in Medicine`；另有 ISO 缩写形式（`Acupunct Med`）。
 * 这里额外产出"缩写签名"（取各词首字母）用于兜底比较。
 */
export function journalSignature(s: string): { full: string; abbrev: string } {
  const full = normText(s);
  const words = full.split(' ').filter((w) => w && !['of', 'the', 'and', 'in', 'for', 'on'].includes(w));
  const abbrev = words.map((w) => w[0]).join('');
  return { full, abbrev };
}

/** 词集合的 Dice 相似度。 */
export function diceTokens(a: string, b: string): number {
  const A = new Set(normText(a).split(' ').filter(Boolean));
  const B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 字符二元组 Dice 相似度（对拼写差异更宽容）。 */
export function diceChars(a: string, b: string): number {
  const norm = (s: string) => normText(s).replace(/ /g, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const grams = (s: string): Set<string> => {
    const o = new Set<string>();
    for (let i = 0; i + 2 <= s.length; i++) o.add(s.slice(i, i + 2));
    if (!o.size) o.add(s);
    return o;
  };
  const GA = grams(A), GB = grams(B);
  let inter = 0;
  for (const g of GA) if (GB.has(g)) inter++;
  return (2 * inter) / (GA.size + GB.size);
}

/** 标题相似度：取词级与字符级的较大值。 */
export const titleSimilarity = (a: string, b: string): number =>
  Math.max(diceTokens(a, b), diceChars(a, b));

const MATCH_T = 0.9;
const PARTIAL_T = 0.65;

function verdictOf(sim: number): ConsistencyVerdict {
  if (sim >= MATCH_T) return 'match';
  if (sim >= PARTIAL_T) return 'partial';
  return 'mismatch';
}

/* -------------------------------- 校验主体 -------------------------------- */

export interface PdfMetaInput {
  title?: string;
  journal?: string;
  year?: string;
  firstAuthor?: string;
  /** 从 PDF 内取得的 DOI（可信度由调用方保证） */
  doi?: string;
}

export interface VerifyOptions {
  /** 标题模糊匹配阈值，默认 0.9 */
  titleThreshold?: number;
}

/**
 * 用 Crossref 记录校验 PDF 内元信息。
 *
 * @param pdf PDF 内抽到的元信息
 * @param work Crossref 记录（调用方已取到；本函数不发网络请求，便于测试）
 */
export function verifyAgainstCrossref(
  pdf: PdfMetaInput,
  work: CrossrefWork | null,
  opts: VerifyOptions = {},
): MetaVerification {
  const notes: string[] = [];
  const comparisons: FieldComparison[] = [];
  const tT = opts.titleThreshold ?? MATCH_T;

  if (!work) {
    return {
      verdict: 'unverifiable',
      doiProvided: Boolean(pdf.doi),
      comparisons: [],
      notes: ['Crossref 未返回记录，无法校验'],
    };
  }

  /* --- DOI --- */
  const pdfDoi = pdf.doi ? normalizeDoi(pdf.doi) : undefined;
  if (pdfDoi) {
    const same = pdfDoi === normalizeDoi(work.doi);
    comparisons.push({
      field: 'doi',
      verdict: same ? 'match' : 'mismatch',
      pdfValue: pdfDoi,
      crossrefValue: work.doi,
      ...(same ? {} : { note: 'PDF 内 DOI 与 Crossref 记录不一致，可能抓到了参考文献里的 DOI' }),
    });
    if (!same) notes.push('DOI 不一致：实测从正文正则捞 DOI 容易误抓到参考文献的 DOI，请人工确认');
  } else {
    notes.push('PDF 内未取得 DOI，已按标题反查');
  }

  /* --- 标题 --- */
  if (pdf.title || work.title) {
    if (!pdf.title) {
      notes.push('PDF 内未取得标题');
    } else if (!work.title) {
      comparisons.push({ field: 'title', verdict: 'unverifiable', pdfValue: pdf.title, note: 'Crossref 未提供标题' });
    } else {
      const sim = titleSimilarity(pdf.title, work.title);
      comparisons.push({
        field: 'title',
        verdict: sim >= tT ? 'match' : verdictOf(sim),
        pdfValue: pdf.title,
        crossrefValue: work.title,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }

  /* --- 期刊 --- */
  if (pdf.journal || work.containerTitle) {
    if (!pdf.journal) notes.push('PDF 内未取得期刊名');
    else if (!work.containerTitle) comparisons.push({ field: 'journal', verdict: 'unverifiable', pdfValue: pdf.journal });
    else {
      const a = journalSignature(pdf.journal), b = journalSignature(work.containerTitle);
      let sim = diceChars(a.full, b.full);
      let note: string | undefined;
      // 缩写兜底：Acupunct Med ↔ Acupuncture in Medicine
      if (sim < MATCH_T && a.abbrev && b.abbrev) {
        const abbrevHit =
          a.abbrev === b.abbrev ||
          b.full.split(' ').map((w) => w[0]).join('') === a.abbrev ||
          a.full.split(' ').map((w) => w[0]).join('') === b.abbrev;
        if (abbrevHit) { sim = MATCH_T; note = '按期刊缩写形式匹配'; }
      }
      comparisons.push({
        field: 'journal',
        verdict: verdictOf(sim),
        pdfValue: pdf.journal,
        crossrefValue: work.containerTitle,
        similarity: Number(sim.toFixed(3)),
        ...(note ? { note } : {}),
      });
    }
  }

  /* --- 年份 --- */
  if (pdf.year || work.issuedYear) {
    if (!pdf.year) notes.push('PDF 内未取得年份');
    else if (!work.issuedYear) comparisons.push({ field: 'year', verdict: 'unverifiable', pdfValue: pdf.year });
    else {
      const py = String(pdf.year).match(/\d{4}/)?.[0];
      const same = py === work.issuedYear;
      comparisons.push({
        field: 'year',
        verdict: same ? 'match' : 'mismatch',
        pdfValue: pdf.year,
        crossrefValue: work.issuedYear,
        ...(same ? {} : { note: '注意：语料目录年份可能与发表年份不同（实测 -2015-05 的期刊 DOI 是 2018 年的）' }),
      });
      if (!same) notes.push('年份不一致：语料归类年份 ≠ 发表年份，这是已知情况，不应据此判为抽取错误');
    }
  }

  /* --- 第一作者 --- */
  const crAuthor = work.authors?.[0];
  if (pdf.firstAuthor && crAuthor) {
    const sim = Math.max(
      ...work.authors!.map((a) => diceChars(pdf.firstAuthor!, a)),
      titleSimilarity(pdf.firstAuthor, crAuthor),
    );
    const surnameHit = normText(crAuthor).split(' ').some((w) => w && normText(pdf.firstAuthor!).includes(w));
    const v: ConsistencyVerdict = sim >= MATCH_T || surnameHit ? 'match' : verdictOf(sim);
    comparisons.push({
      field: 'authors',
      verdict: v,
      pdfValue: pdf.firstAuthor,
      crossrefValue: crAuthor,
      similarity: Number(sim.toFixed(3)),
      ...(v === 'match' && sim < MATCH_T ? { note: '按姓氏匹配' } : {}),
    });
  }

  /* --- 总判定 --- */
  const scored = comparisons.filter((c) => c.verdict === 'match' || c.verdict === 'partial' || c.verdict === 'mismatch');
  let verdict: ConsistencyVerdict;
  if (!scored.length) verdict = 'unverifiable';
  else if (scored.some((c) => c.verdict === 'mismatch')) {
    verdict = scored.some((c) => c.verdict === 'match') ? 'partial' : 'mismatch';
  } else if (scored.some((c) => c.verdict === 'partial')) verdict = 'partial';
  else verdict = 'match';

  return {
    verdict,
    resolvedDoi: work.doi,
    doiProvided: Boolean(pdfDoi),
    crossref: work,
    comparisons,
    notes,
  };
}

/**
 * 从标题反查的候选里挑最可信的一个。
 *
 * 判据（按优先级）：
 *   1. 标题相似度最高
 *   2. 同分时年份一致者优先
 * 返回 null 表示都不够可信——此时不应"随便选一个"，而应报无法核验。
 */
export function pickBestCandidate(
  title: string,
  candidates: readonly CrossrefWork[],
  opts: { year?: string; minSimilarity?: number } = {},
): { work: CrossrefWork; similarity: number } | null {
  const min = opts.minSimilarity ?? 0.85;
  const scored = candidates
    .filter((c) => c.title)
    .map((c) => {
      const sim = titleSimilarity(title, c.title!);
      const yearBonus = opts.year && c.issuedYear === opts.year ? 0.05 : 0;
      return { work: c, similarity: sim, score: sim + yearBonus };
    })
    .filter((s) => s.similarity >= min)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best ? { work: best.work, similarity: Number(best.similarity.toFixed(3)) } : null;
}

/** 供 SKILL 调用：给定 PDF meta 与可选 DOI，完成取数 + 校验。 */
export async function resolveAndVerify(
  client: { byDoi(doi: string): Promise<CrossrefWork | null>; byTitle(t: string, o?: { year?: string }): Promise<readonly CrossrefWork[]> },
  pdf: PdfMetaInput,
  opts: VerifyOptions & { minSimilarity?: number } = {},
): Promise<MetaVerification> {
  let work: CrossrefWork | null = null;
  const notes: string[] = [];

  if (pdf.doi && isLikelyDoi(pdf.doi)) {
    work = await client.byDoi(pdf.doi);
    if (!work) notes.push(`DOI ${normalizeDoi(pdf.doi)} 在 Crossref 查无记录`);
  }
  if (!work && pdf.title) {
    const cands = await client.byTitle(pdf.title, pdf.year ? { year: pdf.year } : {});
    const picked = pickBestCandidate(pdf.title, cands, {
      ...(pdf.year ? { year: pdf.year } : {}),
      ...(opts.minSimilarity !== undefined ? { minSimilarity: opts.minSimilarity } : {}),
    });
    if (picked) {
      work = picked.work;
      notes.push(`按标题反查命中（相似度 ${picked.similarity}）`);
    } else if (cands.length) {
      notes.push(`按标题反查得到 ${cands.length} 个候选但均低于阈值，判定为无法核验`);
    } else {
      notes.push('按标题反查无结果');
    }
  }

  const v = verifyAgainstCrossref(pdf, work, opts);
  return { ...v, notes: [...notes, ...v.notes] };
}
