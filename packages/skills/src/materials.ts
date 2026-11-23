/**
 * @aa/skills — 材料裁剪：把 MiniDoc 变成 SKILL 需要的证据材料
 *
 * 目的：
 *   1. 控制 token —— `_middle.json` 有 1.4MB，不可能整份喂给模型；
 *   2. 控制噪声 —— 结论段（discussion）里的数字不该被当作结局数据；
 *   3. **可定位** —— 每段材料都带 `[[b<index>|p<page>]]` 锚点，模型必须引用锚点
 *      作为 quote 来源，落地时再由本地 `locateEvidence()` 精确定位。
 */

import type { MiniDoc, MiniDocBlock, SectionRole } from '@aa/core';

export interface MaterialBlock {
  /** 块下标，用于锚点 b<index> */
  index: number;
  page: number;
  type: MiniDocBlock['type'];
  section: SectionRole;
  text: string;
  /** 表格的 Markdown 形式（若为表格块） */
  markdown?: string;
  hasGrid?: boolean;
}

export interface Materials {
  blocks: readonly MaterialBlock[];
  /** 渲染好的提示词片段 */
  text: string;
  /** 材料总字符数，用于观测 token 消耗 */
  chars: number;
  /** 被裁剪掉的块数（可审计） */
  trimmed: number;
}

export interface MaterialOptions {
  /** 需要的章节 */
  sections?: readonly SectionRole[];
  /** 是否需要表格 */
  tables?: boolean;
  /** 是否需要图（返回切图路径，供多模态） */
  figures?: boolean;
  /** 保留网格行号与列号，供数值层引用指定单元格。 */
  numberTableCells?: boolean;
  /** 额外包含的页码（如首页取 meta） */
  pages?: readonly number[];
  /** 单块最大字符数，超出截断（默认 2500） */
  maxCharsPerBlock?: number;
  /** 材料总字符上限（默认 60000），超出按优先级截断 */
  maxTotalChars?: number;
  /** 是否保留块内的表格 HTML（默认 false，用 Markdown 代替） */
  includeTableHtml?: boolean;
}

/**
 * 明显不是"内容"的章节：这些章节里的**非表格**内容一律不要
 * （实测：REFERENCES 里 MinerU 会把参考文献列表误判成 table，整块都是噪声）。
 *
 * ⚠️ 但**真表格不能因为章节被丢**：补充材料里的 `eTable 1` 常被排在参考文献之后，
 * MinerU 于是把它归到 `references`——实测 2015-02 的
 * `eTable 1 Symptom scores at baseline, at end of treatment…`（3300 字符的结局数据表）
 * 就是这样被整张丢掉的。因此真表格用 caption 特征单独放行（见 looksLikeRealTable）。
 */
const NON_CONTENT_SECTIONS: ReadonlySet<SectionRole> = new Set<SectionRole>([
  'references', 'acknowledgements', 'funding', 'conflict_of_interest',
]);

/** 真表格的 caption 特征：`Table 2` / `eTable 1` / `Supplementary Table 3`。 */
const REAL_TABLE_CAPTION_RE = /^\s*(?:e|s)?(?:supplementary\s+)?table\s*\d+\b/i;

/** 该块看起来是不是一张**真表格**（有正式 caption），而不是被误判成表的正文/参考文献。 */
const looksLikeRealTable = (b: MiniDocBlock): boolean =>
  REAL_TABLE_CAPTION_RE.test(b.table?.caption ?? '') || REAL_TABLE_CAPTION_RE.test(b.text ?? '');

const gridToMarkdown = (grid: readonly (readonly string[])[]): string => {
  if (!grid.length) return '';
  const cols = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out: string[] = [];
  out.push('| ' + Array.from({ length: cols }, (_, i) => esc(grid[0]![i] ?? '')).join(' | ') + ' |');
  out.push('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |');
  for (const row of grid.slice(1)) {
    out.push('| ' + Array.from({ length: cols }, (_, i) => esc(row[i] ?? '')).join(' | ') + ' |');
  }
  return out.join('\n');
};

/** 采集材料。 */
export function collectMaterials(doc: MiniDoc, opts: MaterialOptions = {}): Materials {
  const maxPerBlock = opts.maxCharsPerBlock ?? 2500;
  const maxTotal = opts.maxTotalChars ?? 60_000;
  const wantSections = opts.sections ? new Set(opts.sections) : null;
  const wantPages = opts.pages ? new Set(opts.pages) : null;

  const picked: MaterialBlock[] = [];
  let trimmed = 0;

  for (const b of doc.blocks) {
    if (b.dropped) continue;

    const sectionOk = wantSections ? wantSections.has(b.section) : true;
    const pageOk = wantPages ? wantPages.has(b.page) : false;

    // 类型过滤
    if (b.type === 'table' && !opts.tables) { trimmed++; continue; }
    if (b.type === 'figure' && !opts.figures) { trimmed++; continue; }

    /*
     * ⚠️ 表格的**章节归属不可信**，请求表格时不受章节过滤。
     *
     * 实测（2015-01，本层最贵的一次教训）：论文的核心结果表 `Table 2 Evaluation of outcome
     * measures` 里给出了全部结局的效应量与 95%CI，但 MinerU 的阅读顺序把它排到了 `DISCUSSION`
     * 标题之后，于是 `b.section` 是 `discussion`，被 `sections:['results','methods','abstract']`
     * 整块过滤掉——模型**根本看不到那张表**：SF-12 / HDRS 的疗程结束值只能答 `NR`，
     * 而后续审计技能再"核对"一遍，仍然只能说"正文中仅以文字描述方向性结果，未给出具体数值"
     * （它同样看不到表），最后 6 个金标准数值全判漏。
     *
     * 表格是**内容**，不是章节的附属物：除明显不是内容的章节外一律保留。
     *
     * ⚠️ 判据必须是"有没有任何可读内容"，且要覆盖 `text` 之外的三个来源：
     *   `text`（caption + 网格 + footnote）/ `grid`（结构）/ `html`（原始 body）/ `imagePath`（切图）。
     * MinerU 偶尔给出 `text=''` 但 `html` 有内容的表（实测 2015-01 第 5 页就有 text 为空、
     * 只有 bbox 的表块）——只看 `text` 会把这类表整张丢掉，**而上游明确要求表格与图片一张都不能丢**。
     */
    const tableHasContent = Boolean(
      b.text.trim().length > 0
      || b.table?.grid?.length
      || b.table?.html?.trim()
      || b.imagePath,
    );
    const tableKept = Boolean(opts.tables) && b.type === 'table'
      && tableHasContent
      && (looksLikeRealTable(b) || !NON_CONTENT_SECTIONS.has(b.section));

    // 章节或页码任一命中即可（页码用于"首页 meta"这类需求）
    if (!sectionOk && !pageOk && !tableKept && !(opts.figures && b.type === 'figure' && b.figureOcr)) {
      trimmed++; continue;
    }

    let text = b.text;
    if (text.length > maxPerBlock) text = text.slice(0, maxPerBlock) + ' …[截断]';

    const mb: MaterialBlock = {
      index: b.index,
      page: b.page,
      type: b.type,
      section: b.section,
      text,
      ...(b.type === 'table' && b.table?.grid?.length
        ? { markdown: opts.numberTableCells
          ? gridToMarkdown([
              ['行号', ...Array.from({ length: Math.max(...b.table.grid.map(row => row.length)) }, (_, i) => `列 ${i + 1}`)],
              ...b.table.grid.map((row, i) => [String(i + 1), ...row]),
            ])
          : gridToMarkdown(b.table.grid), hasGrid: true }
        : {}),
    };
    picked.push(mb);
  }

  // 渲染：带锚点，模型必须引用锚点
  const render = (): string => {
    const parts: string[] = [];
    for (const m of picked) {
      const anchor = `[[b${m.index}|p${m.page}]]`;
      const head = `${anchor} (${m.type}/${m.section})`;
      if (m.markdown) {
        parts.push(`${head}\n${m.text}\n\n表格内容:\n${m.markdown}`);
      } else {
        parts.push(`${head}\n${m.text}`);
      }
    }
    return parts.join('\n\n');
  };

  let text = render();
  /*
   * 总量超限时的裁剪顺序：**先丢正文块，表格与图片留到最后**。
   *
   * 原先的实现是"从后往前丢"，看似合理（后面的优先级低），但真实论文的最后往往正是
   * **补充材料**——实测 2015-02 的 `eTable 1`（结局数据表）排在参考文献之后，
   * 于是第一个被丢掉。上游明确要求"表格与图片一张都不能丢"：论文里最贵的信息就在表里，
   * 一段可以不要的正文（讨论、致谢）远比一张数据表廉价。
   */
  const isMedia = (m: MaterialBlock): boolean => m.type === 'table' || m.type === 'figure';
  while (text.length > maxTotal && picked.length > 1) {
    let dropAt = -1;
    for (let i = picked.length - 1; i >= 0; i--) {
      if (!isMedia(picked[i]!)) { dropAt = i; break; }
    }
    // 只剩媒体块了（材料几乎全是表/图）→ 只能继续丢，否则永远不收敛
    if (dropAt < 0) dropAt = picked.length - 1;
    picked.splice(dropAt, 1);
    trimmed++;
    text = render();
  }

  return { blocks: picked, text, chars: text.length, trimmed };
}

/** 取块号 → 块，便于把模型引用的锚点解析回块。 */
export function anchorIndex(doc: MiniDoc, blockIndex: number): MiniDocBlock | undefined {
  return doc.blocks.find((b) => b.index === blockIndex);
}

/** 从模型输出里解析它引用的锚点，用于审计"模型是否真的读了材料"。 */
export function parseAnchors(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[\[b(\d+)\|p\d+\]\]/g)) out.add(Number(m[1]));
  return [...out];
}
