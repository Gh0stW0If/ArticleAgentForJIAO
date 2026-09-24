/**
 * @aa/core — 表格网格解析
 *
 * MinerU 输出的 `table_body` 是含 `colspan`/`rowspan` 的 HTML（实测 22/22 完整）。
 * 但抽取结局数值时必须能按"行/列"定位单元格，因此需要转成规整的二维网格。
 *
 * 这里刻意不引入 DOM 解析库（Node 环境无 DOM，且 HTML 是本项目自产的受限子集），
 * 用一个小而严的解析器，并把 colspan/rowspan 展开成网格。
 */

import { deLatex } from './latex.js';

export interface ParsedTable {
  /** 展开后的二维网格，[row][col]，缺失单元格为 '' */
  grid: readonly (readonly string[])[];
  rows: number;
  cols: number;
  /** 带合并信息的单元格列表，便于回填 */
  cells: readonly TableCell[];
  warnings: readonly string[];
}

export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * 去掉内联标签但保留文本（<sub>u</sub> → u），并清洗 MinerU 的 LaTeX 噪声。
 *
 * `deLatex` 是必需的：MinerU 会把普通数字判成行内公式，单元格里存的是
 * `<eq>4 1 . 7 5 \pm 1 1 . 1 5</eq>`——只去标签的话，网格单元格就是
 * `4 1 . 7 5 \pm 1 1 . 1 5`，一个 `41.75` 被拆成四个孤立数字喂给模型。
 * 清洗后还原为 `41.75 ± 11.15`（详见 `latex.ts` 与 `tools/latex_noise.mjs` 的全库统计）。
 */
const stripTags = (s: string): string =>
  deLatex(decodeEntities(s.replace(/<[^>]*>/g, ''))).replace(/\s+/g, ' ').trim();

/**
 * 解析表格 HTML → 网格。
 *
 * 支持 `<table><tr><td|th colspan rowspan>...</td></tr></table>`。
 * 不支持的构造（嵌套表格）会被记录到 warnings，而不是静默丢弃。
 */
export function parseTableHtml(html: string): ParsedTable {
  const warnings: string[] = [];
  const src = String(html ?? '').trim();
  if (!src) return { grid: [], rows: 0, cols: 0, cells: [], warnings: ['空表格 HTML'] };

  if (/<table[\s>][\s\S]*<table[\s>]/i.test(src)) warnings.push('疑似嵌套表格，仅解析外层');

  // 取 <tr> ... </tr>（不处理跨 <table> 边界）
  const rowMatches = [...src.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rowMatches.length) return { grid: [], rows: 0, cols: 0, cells: [], warnings: [...warnings, '未找到 <tr>'] };

  const cells: TableCell[] = [];
  const rowsRaw: { cells: TableCell[] }[] = [];

  for (let r = 0; r < rowMatches.length; r++) {
    const inner = rowMatches[r]![1] ?? '';
    const cellMatches = [...inner.matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi)];
    const rowCells: TableCell[] = [];
    for (const cm of cellMatches) {
      const attrs = cm[2] ?? '';
      const body = cm[3] ?? '';
      const getNum = (name: string): number => {
        const m = new RegExp(`${name}\\s*=\\s*"?\\s*(\\d+)`, 'i').exec(attrs);
        const n = m ? Number(m[1]) : 1;
        return Number.isFinite(n) && n > 0 ? n : 1;
      };
      rowCells.push({
        row: r,
        col: -1, // 稍后按已占用位置分配
        rowSpan: getNum('rowspan'),
        colSpan: getNum('colspan'),
        text: stripTags(body),
      });
    }
    rowsRaw.push({ cells: rowCells });
  }

  // 展开为网格：处理 colspan / rowspan 的占位
  const occupied: boolean[][] = [];
  const isOccupied = (r: number, c: number): boolean => occupied[r]?.[c] === true;
  const mark = (r: number, c: number): void => {
    occupied[r] ??= [];
    occupied[r]![c] = true;
  };

  const grid: string[][] = [];
  const ensureRow = (r: number): string[] => {
    grid[r] ??= [];
    return grid[r]!;
  };

  for (let r = 0; r < rowsRaw.length; r++) {
    ensureRow(r);
    let c = 0;
    for (const cell of rowsRaw[r]!.cells) {
      while (isOccupied(r, c)) c++;
      cell.col = c;
      const gr = ensureRow(r);
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        const rr = r + dr;
        const grow = ensureRow(rr);
        for (let dc = 0; dc < cell.colSpan; dc++) {
          const cc = c + dc;
          // 合并区域的左上角放文本，其余留空占位
          grow[cc] = dr === 0 && dc === 0 ? cell.text : '';
          mark(rr, cc);
        }
      }
      c += cell.colSpan;
    }
  }

  const cols = grid.reduce((w, row) => Math.max(w, row.length), 0);
  for (const row of grid) {
    for (let i = 0; i < cols; i++) row[i] ??= '';
  }

  return { grid, rows: grid.length, cols, cells, warnings };
}

/** 把网格渲染成便于喂给 LLM 的 TSV/Markdown 形式。 */
export function gridToMarkdown(grid: readonly (readonly string[])[], opts: { maxRows?: number } = {}): string {
  const maxRows = opts.maxRows ?? 200;
  const rows = grid.slice(0, maxRows);
  if (!rows.length) return '';
  const cols = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines: string[] = [];
  lines.push('| ' + Array.from({ length: cols }, (_, i) => esc(rows[0]![i] ?? '')).join(' | ') + ' |');
  lines.push('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |');
  for (const row of rows.slice(1)) {
    lines.push('| ' + Array.from({ length: cols }, (_, i) => esc(row[i] ?? '')).join(' | ') + ' |');
  }
  if (grid.length > maxRows) lines.push(`\n…（共 ${grid.length} 行，已截断）`);
  return lines.join('\n');
}

/** 在表格里按行标签定位数值（部分匹配，忽略大小写与空白）。 */
export function findRowByLabel(
  table: ParsedTable,
  label: string,
  opts: { labelCols?: number } = {},
): { row: number; values: readonly string[] } | null {
  const labelCols = opts.labelCols ?? 2;
  const want = label.replace(/\s+/g, '').toLowerCase();
  for (let r = 0; r < table.grid.length; r++) {
    const row = table.grid[r]!;
    const head = row.slice(0, labelCols).join(' ').replace(/\s+/g, '').toLowerCase();
    if (head && (head === want || head.includes(want))) {
      return { row: r, values: row.slice(labelCols) };
    }
  }
  return null;
}
