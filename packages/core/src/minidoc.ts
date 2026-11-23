/**
 * @aa/core — 解析文档表示（Agent 的输入）
 *
 * 这是 MinerU 规范化产物（`build/mineru/<year>/_clean/<stem>.json`）的类型化表示。
 * Agent 只应读这个结构，不要直接读 MinerU 的 `_middle.json`（1.4MB，含大量无用中间态）。
 */

/** 解析块类型，与 MinerU `content_list` 的 type 对齐并做了收敛。 */
export type BlockType = 'title' | 'text' | 'list' | 'table' | 'figure' | 'equation';

/** 文档结构中的章节归属（由章节路由确定）。 */
export type SectionRole =
  | 'title'
  | 'abstract'
  | 'introduction'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'references'
  | 'acknowledgements'
  | 'funding'
  | 'conflict_of_interest'
  | 'supplementary'
  | 'metadata'
  | 'unknown';

export interface MiniDocBlock {
  /** 在文档内的稳定下标（排序后），用作 blockId */
  index: number;
  type: BlockType;
  /** 正文文本。表格块为解析后的可读文本（见 table） */
  text: string;
  /** 1-based 页码 */
  page: number;
  /** [x0,y0,x1,y1]，原点为页面左上角，未旋转坐标系；缺失为 null */
  bbox: readonly [number, number, number, number] | null;
  /** 标题层级（仅 title 有） */
  level?: number;
  /** 章节归属 */
  section: SectionRole;
  /** 表格专用 */
  table?: {
    /** 原始 HTML（含 colspan/rowspan），可直接解析为网格 */
    html: string;
    caption?: string;
    footnote?: string;
    /** 由 HTML 解析出的二维网格，便于数值定位 */
    grid?: readonly (readonly string[])[];
    captionSource?: string;
    mergedFrom?: readonly { pageIdx: number; note: string }[];
  };
  /** 图片专用：切图路径（相对 MinerU 输出目录），供多模态使用 */
  imagePath?: string;
  /** 表头块等噪声已被上游剔除，这里保留标记以便审计 */
  dropped?: boolean;
}

export interface MiniDocPage {
  /** 1-based */
  page: number;
  width: number;
  height: number;
  /** PDF 原生旋转角（0/90/180/270）。坐标已归一化为未旋转，此项仅作提示 */
  rotate: number;
}

export interface MiniDoc {
  schemaVersion: 'AA_MINIDOC/1.0';
  /** 以 (year, articleId) 为主键 */
  year: string;
  articleId: string;
  sourcePdf: string;
  /** MinerU 输出目录（相对仓库根），便于取切图 */
  mineruDir: string;
  pages: readonly MiniDocPage[];
  blocks: readonly MiniDocBlock[];
  stats: {
    totalBlocks: number;
    droppedNoise: number;
    tables: number;
    figures: number;
    equations: number;
    /** 页码覆盖数，用于检测漏抽 */
    pagesCovered: number;
  };
  warnings: readonly string[];
}

/* ------------------------------ 查询辅助 ------------------------------ */

/** 按页码取块（保持阅读顺序）。 */
export const blocksOnPage = (doc: MiniDoc, page: number): readonly MiniDocBlock[] =>
  doc.blocks.filter((b) => b.page === page);

/** 取所有表格块。 */
export const tables = (doc: MiniDoc): readonly MiniDocBlock[] =>
  doc.blocks.filter((b) => b.type === 'table');

/** 取所有图块（含切图路径，供多模态）。 */
export const figures = (doc: MiniDoc): readonly MiniDocBlock[] =>
  doc.blocks.filter((b) => b.type === 'figure');

/** 按章节取块。 */
export const blocksInSection = (doc: MiniDoc, section: SectionRole): readonly MiniDocBlock[] =>
  doc.blocks.filter((b) => b.section === section);

/**
 * 把一段原文在文档里定位到证据。
 * 用于把模型给出的 quote 转成带坐标的 Evidence——这是"框选证据"的关键一步。
 *
 * 匹配策略（从严到宽）：
 *   1. 规范化空白后精确子串匹配
 *   2. 去标点后匹配（容忍 OCR 标点差异）
 *   3. **去连字符 + 去标点**后匹配
 *
 * 第 3 级是实测加的：PDF 正文常有跨行断词，MinerU 还原成 `depres-\nsion` 这种形式，
 * 而模型给的是拼好的 `depression`；前两级都会失败，
 * 症状是"quote 无法在文档中定位"，字段整片丢失（实测 2015-01 的次要结局就因此全丢）。
 *
 * 找不到则返回 null，调用方必须据此拒绝该字段（不得伪造坐标）。
 */
export function locateEvidence(
  doc: MiniDoc,
  quote: string,
  opts: { preferPages?: readonly number[]; kinds?: readonly BlockType[] } = {},
): { block: MiniDocBlock; exact: boolean } | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  /*
   * ⚠️ MinerU 会在正文里内联标记（`HDRS,<sup>28</sup> at 10 weeks`）。
   * 模型做"逐字引用"时通常把标记去掉写成 `HDRS,28 at 10 weeks`，
   * 于是 `strip` 之后一边是 `thehdrsup28supat10weeks`、另一边是 `thehdrs28at10weeks`，
   * 反而**不相等**——实测这一条就让 2015-01 的次要结局全部落地失败。
   * 因此宽容匹配时先去掉内联标签。
   */
  const untag = (s: string) => s.replace(/<\/?[a-z][^>]*>/gi, '');
  const strip = (s: string) => norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  /** 先去掉"行末连字符 + 换行"，再抹掉所有非字母数字 */
  const dehyphen = (s: string): string => strip(s.replace(/[-‐‑]\s*\n\s*/g, '').replace(/[-‐‑]\s+/g, ''));

  const q = norm(quote);
  if (q.length < 2) return null;
  const qs = strip(untag(quote));
  const qd = dehyphen(untag(quote));

  const hayOf = (b: MiniDocBlock): string =>
    b.type === 'table' ? [b.text, b.table?.caption, b.table?.html].filter(Boolean).join(' \n ') : b.text;

  const pool = doc.blocks.filter((b) => {
    if (b.dropped) return false;
    if (opts.kinds && !opts.kinds.includes(b.type)) return false;
    return true;
  });
  const ordered = opts.preferPages?.length
    ? [...pool].sort((a, b) => {
        const ai = opts.preferPages!.indexOf(a.page);
        const bi = opts.preferPages!.indexOf(b.page);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      })
    : pool;

  for (const b of ordered) {
    if (norm(hayOf(b)).includes(q)) return { block: b, exact: true };
  }
  for (const b of ordered) {
    if (strip(untag(hayOf(b))).includes(qs)) return { block: b, exact: false };
  }
  // 断词还原：要求足够长，避免短串在"抹掉所有标点"后误命中
  if (qd.length >= 8) {
    for (const b of ordered) {
      if (dehyphen(untag(hayOf(b))).includes(qd)) return { block: b, exact: false };
    }
  }
  return null;
}
