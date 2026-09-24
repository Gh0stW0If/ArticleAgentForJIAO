/**
 * @aa/ingest — MinerU 产物 → MiniDoc
 *
 * ===== 数据源选择（重要，基于实测）=====
 *
 * MinerU 会给出两套可选产物，本项目**必须用 `_middle.json`**：
 *
 *   `_content_list.json`：条目扁平、字段友好，但【bbox 坐标系不可用】。
 *     实测 -2015-01 第 1 页 "Original paper"：
 *       _middle.json  bbox = [458, 18, 537, 30]   ← 页宽 595，自洽
 *       content_list  bbox = [769, 22, 902, 37]   ← x 超出页宽
 *     且各页的越界比例不一致（x 1.19~1.53 倍），无法用统一缩放系数还原。
 *     对"前端框选证据"来说这是致命的，因此弃用其几何信息。
 *
 *   `_middle.json`：几何信息可靠（所有 bbox 均落在页面内），且信息更全——
 *     - 块类型更细分：title / text / abstract / table / image / ref_text
 *     - 噪声单独放在 discarded_blocks（可审计，不混入正文）
 *     - 表格结构完整：table.blocks[] 内含 table_caption 与 table_body(HTML)
 *     - 公式以 span 形式内联（inline_equation），文本里已含 LaTeX
 *
 * 坐标系约定：bbox 为 [x0,y0,x1,y1]，原点页面左上角，位于 MinerU 的
 * canonical 页面框架。旋转页（page_size 宽>高）的也满足此约定（实测第 6 页
 * page_size=[793,595] 而 bbox 仍在 [595,793] 框架内）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseTableHtml,
  deLatex,
  articleIdOf,
  studyIdFromPdfName,
  type MiniDoc,
  type MiniDocBlock,
  type MiniDocPage,
  type BlockType,
  type SectionRole,
} from '@aa/core';

/* ----------------------------- MinerU 中间态类型 ----------------------------- */

interface MuSpan {
  type?: string;
  content?: string;
  html?: string;
  image_path?: string;
  bbox?: number[];
  score?: number;
}
interface MuLine {
  bbox?: number[];
  spans?: MuSpan[];
}
interface MuBlock {
  type?: string;
  bbox?: number[];
  index?: number;
  score?: number;
  blocks?: MuBlock[];
  lines?: MuLine[] | null;
}
interface MuPage {
  page_idx?: number;
  page_size?: number[];
  para_blocks?: MuBlock[];
  discarded_blocks?: MuBlock[];
}
interface MuMiddle {
  pdf_info?: MuPage[];
  _backend?: string;
  _version_name?: string;
}

/* ------------------------------ 类型与章节映射 ------------------------------ */

/** MinerU 块类型 → MiniDoc 块类型。 */
const BLOCK_TYPE_MAP: Readonly<Record<string, BlockType>> = {
  title: 'title',
  text: 'text',
  abstract: 'text',
  table: 'table',
  image: 'figure',
  figure: 'figure',
  equation: 'equation',
  interline_equation: 'equation',
  ref_text: 'text',
  index: 'text',
};

/* -------------------------------- 文本抽取 -------------------------------- */

/** 保留页眉/页脚/脚注的页数（实测这些块承载文章级元信息，见下方注释）。 */
const DISCARDED_KEEP_PAGES = 2;

/** 视为"章节标题"的 MinerU 类型（用于章节路由）。 */
const HEADING_TYPES = new Set(['title']);

/** 参考文献段落：按内容判定，因为这些块类型是 text。 */
const REFERENCE_LINE = /^\s*(\[\d+\]|\d+\.)\s+\S/;

const SECTION_PATTERNS: readonly [RegExp, SectionRole][] = [
  [/^abstract\b/i, 'abstract'],
  [/^(introduction|background)\b/i, 'introduction'],
  [/^(methods?|materials?\s+and\s+methods?|methodology|study\s+design|patients?\s+and\s+methods?|subjects?\s+and\s+methods?|statistical\s+(analysis|plan)|randomisation|randomization)\b/i, 'methods'],
  [/^(results?|findings)\b/i, 'results'],
  [/^(discussion|general\s+discussion)\b/i, 'discussion'],
  [/^(conclusions?|concluding\s+remarks?)\b/i, 'conclusion'],
  [/^(references?|bibliography)\b/i, 'references'],
  [/^(acknowledge?ments?)\b/i, 'acknowledgements'],
  [/^(funding|funding\s+statement|role\s+of\s+the\s+funder)\b/i, 'funding'],
  [/^(competing\s+interests?|conflicts?\s+of\s+interest|declaration\s+of\s+interests?)\b/i, 'conflict_of_interest'],
  [/^(supplementary|supporting\s+information|appendix|web\s+appendix|online\s+supplement)/i, 'supplementary'],
];

function sectionForHeading(text: string): SectionRole | null {
  const t = text.replace(/^\d+(\.\d+)*\.?\s*/, '').trim();
  for (const [re, role] of SECTION_PATTERNS) if (re.test(t)) return role;
  return null;
}

/* -------------------------------- 文本抽取 -------------------------------- */

/**
 * 把一个 MuBlock 的文本拼出来（递归进 blocks），并清洗 MinerU 的 LaTeX 噪声。
 *
 * `deLatex` 不能省：段落里的行内公式是**裸 LaTeX**（MinerU 不在 `content` 里放 `<eq>` 定界符），
 * 实测 2015-02 的段落里就躺着 `\overset { \cdot } { 2 } . 0 2 9 P = . 3 6 3`，
 * 不清洗的话模型看到的是被空格切碎的数字。
 */
function blockText(b: MuBlock): string {
  const out: string[] = [];
  const walk = (x: MuBlock): void => {
    if (x.lines?.length) {
      for (const ln of x.lines) {
        const t = (ln.spans ?? []).map((s) => s.content ?? '').join('');
        if (t.trim()) out.push(t);
      }
    }
    for (const c of x.blocks ?? []) walk(c);
  };
  walk(b);
  return deLatex(out.join('\n')).replace(/[ \t]+/g, ' ').trim();
}

/** 取表格的 caption / body(html) / footnote。 */
function tableParts(b: MuBlock): { caption?: string; html: string; footnote?: string; bodyImage?: string; captionBbox?: number[] } {
  let caption: string | undefined;
  let footnote: string | undefined;
  let html = '';
  let bodyImage: string | undefined;
  let captionBbox: number[] | undefined;

  for (const c of b.blocks ?? []) {
    const t = String(c.type ?? '');
    if (t === 'table_caption') {
      const s = blockText(c);
      if (s) { caption = caption ? `${caption} ${s}` : s; captionBbox = c.bbox; }
    } else if (t === 'table_footnote') {
      const s = blockText(c);
      if (s) footnote = footnote ? `${footnote} ${s}` : s;
    } else if (t === 'table_body') {
      for (const ln of c.lines ?? []) {
        for (const sp of ln.spans ?? []) {
          /* `<eq>…</eq>` 里的数字被 MinerU 的公式模块拆散了，这里还原成原文（见 core/latex.ts） */
          if (sp.html) html = html ? `${html}${deLatex(sp.html)}` : deLatex(sp.html);
          if (sp.image_path) bodyImage = sp.image_path;
        }
      }
    }
  }
  return { ...(caption ? { caption } : {}), html, ...(footnote ? { footnote } : {}), ...(bodyImage ? { bodyImage } : {}), ...(captionBbox ? { captionBbox } : {}) };
}

/** 递归查找块内第一个 image_path（image_path 可能嵌在多层 blocks 里）。 */
function findImagePath(b: MuBlock): string | undefined {
  const direct = (b.lines ?? []).flatMap((l) => l.spans ?? []).find((s) => s.image_path);
  if (direct?.image_path) return direct.image_path;
  for (const c of b.blocks ?? []) {
    const hit = findImagePath(c);
    if (hit) return hit;
  }
  return undefined;
}

/** 递归查找块内的 caption 子块文本。 */
function findCaptionText(b: MuBlock): string | undefined {
  for (const c of b.blocks ?? []) {
    if (String(c.type ?? '').includes('caption')) {
      const s = blockText(c);
      if (s) return s;
    }
    const deep = findCaptionText(c);
    if (deep) return deep;
  }
  return undefined;
}

/* --------------------------------- 主流程 --------------------------------- */

export interface IngestOptions {
  rootDir: string;
  year: string;
  /** 研究 ID（如 2015-01）；缺省时从产物文件名推导 */
  studyId?: string;
  /** 显式指定 `_middle.json` 路径 */
  middleFile?: string;
}

export interface IngestResult {
  doc: MiniDoc;
  /** MinerU 版本与后端，写入产物以便复现 */
  mineru: { backend?: string; version?: string };
  warnings: string[];
}

/** 定位某篇的 `_middle.json`。 */
export function findMiddleFile(rootDir: string, year: string, studyId: string): string | null {
  const base = join(rootDir, 'build', 'mineru', year);
  if (!existsSync(base)) return null;

  /*
   * ⚠️ 候选目录不止 `<studyId>` 一个——只认它会让整篇准确率掉到 0。
   *
   * MinerU 按"输入文件的主名"建输出目录，而 Datas 里同一篇可能同时有
   * `2023-19.pdf`（9 页正文）与 `2023-19.jpg`（一张图版）：两者主名相同，
   * MinerU 会把其中一个写成 `2023-19_2`，**谁占 `2023-19` 取决于处理顺序**。
   * 实测 `2023-19` / `2025-07` 的 `<id>` 目录里正是那张图版的解析（正文 300 余字符、1 页），
   * 真正的 9 页 / 14 页正文解析在 `<id>_2` 里 → 抽取阶段只拿到一张图，
   * 这两篇的 230 / 310 个字段全部记为"漏"（准确率 0.0% / 1.6%）。
   *
   * 因此把所有候选（`<id>`、`<id>_2`、`<id>_3`…、`-<id>`）都收进来，
   * 再按"页数多 → 正文字符多"挑最完整的一份。图版解析永远是最小的一份，不会被选中。
   */
  const stems = [studyId, `-${studyId}`];
  const candidates: string[] = [];
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === '_clean') continue;
    if (!stems.some((s) => s === d.name || new RegExp(`^${escapeRe(s)}_\\d+$`).test(d.name))) continue;
    for (const sub of readdirSync(join(base, d.name), { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const dir = join(base, d.name, sub.name);
      const hit = readdirSync(dir).find((f) => f.endsWith('_middle.json'));
      if (hit) candidates.push(join(dir, hit));
    }
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0]!;

  /* 多份候选：按页数、正文体量取最完整的一份（图版解析必然最小）。 */
  let best: { file: string; pages: number; chars: number } | null = null;
  for (const file of candidates) {
    let pages = 0; let chars = 0;
    try {
      const mid = JSON.parse(readFileSync(file, 'utf8')) as MuMiddle;
      pages = (mid.pdf_info ?? []).length;
      chars = (mid.pdf_info ?? []).reduce(
        (n, p) => n + (p.para_blocks ?? []).reduce((m, b) => m + JSON.stringify(b).length, 0), 0,
      );
    } catch { continue; }
    if (!best || pages > best.pages || (pages === best.pages && chars > best.chars)) best = { file, pages, chars };
  }
  return best?.file ?? candidates[0]!;
}

/** 正则转义（用于把 studyId 当成字面量拼进正则）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ingest(opts: IngestOptions): IngestResult {
  const warnings: string[] = [];
  const rootDir = resolve(opts.rootDir);

  const file = opts.middleFile ?? (opts.studyId ? findMiddleFile(rootDir, opts.year, opts.studyId) : null);
  if (!file) {
    throw new Error(
      `未找到 ${opts.year} 的 MinerU 产物（_middle.json）。请先运行：\n` +
      `  node tools/mineru_batch.mjs --year ${opts.year} --only ${opts.studyId ?? '<id>'}`,
    );
  }
  if (!existsSync(file)) throw new Error(`文件不存在: ${file}`);

  const mid = JSON.parse(readFileSync(file, 'utf8')) as MuMiddle;
  const pages = mid.pdf_info ?? [];
  if (!pages.length) throw new Error(`${file} 不含 pdf_info`);

  const stem = file.replace(/\\/g, '/').split('/').slice(-2)[0] ?? '';
  const studyId = opts.studyId ?? studyIdFromPdfName(stem);
  if (!studyId) throw new Error(`无法从 "${stem}" 推导研究 ID，请显式传 studyId`);

  const miniPages: MiniDocPage[] = pages.map((p, i) => {
    const s = p.page_size ?? [595.276, 841.89];
    const width = s[0] ?? 595.276;
    const height = s[1] ?? 841.89;
    return { page: i + 1, width, height, rotate: width > height ? 90 : 0 };
  });

  const blocks: MiniDocBlock[] = [];
  let droppedNoise = 0;
  let currentSection: SectionRole = 'unknown';
  let inReferences = false;
  let seenAbstract = false;
  /** 已保留的页眉/页脚文本（同一篇里每页页脚完全相同，去重避免污染材料） */
  const keptPageFurniture = new Set<string>();

  /** bbox 合法性校验（MinerU 已自洽，这里只做护栏并记录异常）。 */
  const checkBbox = (bbox: number[] | undefined, pageIdx: number): readonly [number, number, number, number] | null => {
    if (!bbox || bbox.length !== 4 || bbox.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
    const [x0, y0, x1, y1] = bbox as [number, number, number, number];
    const norm: [number, number, number, number] = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    const pg = miniPages[pageIdx];
    if (pg) {
      // canonical 框架：两个方向都不超过 max(宽,高)
      const maxDim = Math.max(pg.width, pg.height);
      if (norm[2] > maxDim + 2 || norm[3] > maxDim + 2) {
        warnings.push(`页 ${pageIdx + 1} bbox 超出 canonical 框架 ${maxDim}: ${JSON.stringify(norm)}`);
      }
    }
    return norm;
  };

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pg = pages[pageIdx]!;

    for (const b of pg.para_blocks ?? []) {
      const muType = String(b.type ?? '').toLowerCase();
      const type: BlockType = BLOCK_TYPE_MAP[muType] ?? 'text';
      if (!BLOCK_TYPE_MAP[muType]) warnings.push(`未知块类型 "${muType}"（页 ${pageIdx + 1}），按 text 处理`);

      const isHeading = HEADING_TYPES.has(muType);
      const rawText = blockText(b);

      // 章节推进
      if (isHeading) {
        const role = sectionForHeading(rawText);
        if (role) {
          currentSection = role;
          inReferences = role === 'references';
          if (role === 'abstract') seenAbstract = true;
        }
      }
      // ref_text 或疑似条目行 → references
      if (muType === 'ref_text' || (!isHeading && inReferences)) currentSection = 'references';
      if (!isHeading && REFERENCE_LINE.test(rawText) && currentSection === 'unknown') currentSection = 'references';

      let section: SectionRole = currentSection;
      if (!seenAbstract && currentSection === 'unknown' && pageIdx === 0) section = 'metadata';

      const block: MiniDocBlock = {
        index: blocks.length,
        type: isHeading ? 'title' : type,
        text: rawText,
        page: pageIdx + 1,
        bbox: checkBbox(b.bbox, pageIdx),
        section,
        ...(isHeading ? { level: 1 } : {}),
      };

      if (type === 'table') {
        const parts = tableParts(b);
        const parsed = parseTableHtml(parts.html);
        for (const w of parsed.warnings) warnings.push(`表格(页 ${pageIdx + 1}): ${w}`);
        if (!parts.html) warnings.push(`表格(页 ${pageIdx + 1}) 无 HTML body`);
        block.table = {
          html: parts.html,
          ...(parts.caption ? { caption: parts.caption } : {}),
          ...(parts.footnote ? { footnote: parts.footnote } : {}),
          grid: parsed.grid,
        };
        // 表格块 text = caption + 网格文本 + footnote，便于按原文定位证据
        block.text = [
          parts.caption,
          parsed.grid.map((r) => r.join('\t')).join('\n'),
          parts.footnote,
        ].filter(Boolean).join('\n');
        // caption 单独暴露，便于多模态与人工核对
        if (parts.bodyImage) block.imagePath = parts.bodyImage;
        // caption 的精确 bbox 优先（证据框选时更准）
        if (parts.captionBbox) {
          block.bbox = checkBbox(parts.captionBbox, pageIdx) ?? block.bbox;
        }
      } else if (type === 'figure') {
        const img = findImagePath(b);
        if (img) block.imagePath = img;
        const cap = findCaptionText(b);
        if (cap) block.text = cap;
      }

      blocks.push(block);
    }

    /*
     * 页眉 / 页脚 / 脚注：默认被 MinerU 丢进 discarded_blocks，但**它们不是噪声**。
     *
     * 实测 -2015-01 首页页脚：
     *   [page_footnote] "Correspondence to Dr Jorge Vas, …; jorgef.vas. sspa@juntadeandalucia.es"
     *   [page_footnote] "To cite: Vas J, … Acupunct Med 2016;34: 257–266."
     *   [footer]        "Vas J, et al. Acupunct Med 2016;34:257–266. doi:10.1136/acupmed-2015-010950"
     * 期刊名、卷期年份、DOI、通讯作者邮箱全在这里——丢弃它们会让 journal /
     * publicationYear / doi / authorContact 四个字段一律抽成 NR（这是实测到的）。
     *
     * 因此前 DISCARDED_KEEP_PAGES 页的页眉页脚保留为 section='metadata' 的块
     * （只有文章级 SKILL 会取该章节的材料，不会污染方法学/结果的材料）；
     * 页码丢弃（无信息量，且纯数字容易被 quote 误匹配）。
     */
    const discarded = pg.discarded_blocks ?? [];
    for (const b of discarded) {
      const muType = String(b.type ?? '').toLowerCase();
      if (pageIdx >= DISCARDED_KEEP_PAGES || muType === 'page_number') { droppedNoise++; continue; }
      const t = blockText(b);
      const key = t.replace(/\s+/g, ' ').trim();
      if (!t.trim() || keptPageFurniture.has(key)) { droppedNoise++; continue; }
      keptPageFurniture.add(key);
      blocks.push({
        index: blocks.length,
        type: 'text',
        text: t,
        page: pageIdx + 1,
        bbox: checkBbox(b.bbox, pageIdx),
        section: 'metadata',
      });
    }
  }

  const doc: MiniDoc = {
    schemaVersion: 'AA_MINIDOC/1.0',
    year: opts.year,
    articleId: articleIdOf(studyId),
    sourcePdf: `Datas/articles/${opts.year}/${stem}.pdf`,
    mineruDir: file.replace(rootDir + (process.platform === 'win32' ? '\\' : '/'), '').replace(/\\/g, '/'),
    pages: miniPages,
    blocks,
    stats: {
      totalBlocks: blocks.length,
      droppedNoise,
      tables: blocks.filter((b) => b.type === 'table').length,
      figures: blocks.filter((b) => b.type === 'figure').length,
      equations: blocks.filter((b) => b.type === 'equation').length,
      pagesCovered: new Set(blocks.map((b) => b.page)).size,
    },
    warnings,
  };

  return { doc, mineru: { ...(mid._backend ? { backend: mid._backend } : {}), ...(mid._version_name ? { version: mid._version_name } : {}) }, warnings };
}
