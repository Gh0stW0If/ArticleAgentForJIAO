/**
 * @aa/core — 研究 ID 语法
 *
 * 实测（见 docs/02-gold-schema.md）：
 *   article     YYYY-NN          每篇 1 条
 *   comparison  YYYY-NN-K        试验组/对照组配对，K 为两位比较组序号
 *   outcome     YYYY-NN-K        结局 × 时点
 *
 * ⚠️ 两条实测教训，直接影响正确性：
 *   1. 跨年份重名：2022 表里曾出现 `2024-05`（实为 `2022-05` 的笔误），
 *      而 2024 文件里的 `2024-05` 是【另一篇】。
 *      → 任何跨年份合并必须以 (year, articleId) 为主键，不能只用 articleId。
 *   2. 归约文章号不能用"剪掉最后一段"：`2015-01` 剪成 `2015`。必须用完整正则。
 */

/** 研究 ID 正则：YYYY-NN 或 YYYY-NN-K（各段 1~2 位数字）。 */
const STUDY_ID_RE = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/;

export interface ParsedStudyId {
  year: string;
  /** 文章序号（字符串，保留前导零），如 '01' */
  articleNo: string;
  /** 比较组序号（无则 null），如 '01' */
  comparisonNo: string | null;
}

/** 解析研究 ID；非法返回 null。 */
export function parseStudyId(id: string): ParsedStudyId | null {
  // 容忍 2015 这类数据集的文件名前导连字符（实测 `-2015-01.pdf`）
  const m = STUDY_ID_RE.exec(id.trim().replace(/^-+/, ''));
  if (!m) return null;
  return { year: m[1]!, articleNo: m[2]!, comparisonNo: m[3] ?? null };
}

export const isStudyId = (id: string): boolean => STUDY_ID_RE.test(id.trim().replace(/^-+/, ''));

/**
 * 研究 ID → 文章 ID。
 * `2015-01` → `2015-01`（不变）；`2015-04-01` → `2015-04`；`-2015-01` → `2015-01`。
 * 非法输入原样返回（去掉前导连字符后），便于把问题暴露在调用方而不是静默丢失。
 */
export function articleIdOf(id: string): string {
  const cleaned = id.trim().replace(/^-+/, '');
  const p = parseStudyId(cleaned);
  return p ? `${p.year}-${p.articleNo}` : cleaned;
}

/** 比较组 ID → 保持原样；仅做合法性校验。 */
export const comparisonIdOf = (id: string): string => id.trim();

/** 组装研究 ID。 */
export function makeStudyId(year: string, articleNo: string, comparisonNo?: string | null): string {
  return comparisonNo ? `${year}-${articleNo}-${comparisonNo}` : `${year}-${articleNo}`;
}

/** 跨年份唯一键，用于任何合并/索引场景。 */
export const primaryKey = (year: string, articleId: string): string => `${year}::${articleId}`;

/**
 * 从文件名推导研究 ID。
 * 实测 2015 的文件名是 `-2015-01.pdf`（前面有个多余连字符），需容忍。
 */
export function studyIdFromPdfName(fileName: string): string | null {
  const base = fileName.replace(/\.pdf$/i, '').replace(/^-+/, '');
  const m = /(\d{4}-\d{1,2}(?:-\d{1,2})?)/.exec(base);
  return m ? m[1]! : null;
}

/**
 * 把一整套 PDF 文件名映射成"要跑哪些研究"。
 *
 * ⚠️ 为什么要专门写这个函数（实测事故）：
 *
 * `Datas/articles/<year>/` 里除了正文 PDF，还会有**同一篇的附件/分册**：
 *   `2024-12.pdf`（9 页正文）+ `2024-12-01.pdf` … `2024-12-04.pdf`（各 1 页附件）
 *   `2022-06-sup.pdf`（补充材料）、`2024-24-sup.pdf`（同上）
 *
 * 早先的实现是"从文件名里正则捞第一个像研究号的串"，于是：
 *   · `2024-12-01` 被当成独立研究 → ingest 解析它的 1 页附件，
 *     但 `articleIdOf('2024-12-01')` 归约成 **`2024-12`**（把 `-01` 当比较组序号），
 *     于是它写进了**正文那篇的产物文件**；
 *   · 运行顺序按 id 排序，`2024-12` 在前、四个附件在后 → **附件把正文覆盖掉**。
 *     实测 2024-12 因此只剩 1 页材料：结局计划为空（模型老实回答"这篇没有结局声明"）、
 *     26 行金标准只配上 2 行，准确率 **5.1%**（全语料倒数第一）。
 *
 * 判据：**只有"整串就是 YYYY-N"的文件才算一篇研究**；
 * 带 `-01`/`-sup` 等后缀的一律视为附件，不单独跑（它们的内容由正文那一篇覆盖）。
 * 返回值保持输入顺序去重，便于日志里核对"漏了哪篇没跑"。
 */
/**
 * 一篇正文 PDF 的清单条目。
 *
 * `file` 保留**真实文件名**（2015 的数据集里是 `-2015-01.pdf`，带前导连字符），
 * 因为服务端要用它去定位 PDF 文件；`studyId` 才是规范研究号。
 * 早先只回研究号、让调用方自己拼 `${studyId}.pdf`，结果 2015 全部读不到文件。
 */
export interface PdfStudyEntry {
  studyId: string;
  file: string;
}

export function studiesFromPdfNames(fileNames: readonly string[]): { studies: PdfStudyEntry[]; skipped: string[] } {
  const studies: PdfStudyEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const f of fileNames) {
    if (!f.toLowerCase().endsWith('.pdf')) continue;
    const base = f.replace(/\.pdf$/i, '').replace(/^-+/, '');
    const exact = /^(\d{4}-\d{1,2})$/.exec(base);
    if (exact) {
      const studyId = exact[1]!;
      if (!seen.has(studyId)) { seen.add(studyId); studies.push({ studyId, file: f }); }
      continue;
    }
    skipped.push(f);   // `2024-12-01.pdf` / `2024-24-sup.pdf` / `txt.pdf` …
  }
  return { studies, skipped };
}

