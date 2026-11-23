/**
 * tools/lib/xlsxwrite.mjs — 零依赖 .xlsx **写入**
 *
 * 只实现本仓库需要的最小子集：
 *   · 多个工作表
 *   · 行内字符串（inlineStr）——不用 sharedStrings：导出的是"给人看的表"，
 *     重复文本少，省掉一个文件与一套索引维护更划算
 *   · 三种样式：表头（粗体+底纹）、正文（自动换行、顶端对齐）、**有分歧的行（红字红底）**
 *   · 冻结首行首列、列宽
 *
 * ⚠️ Excel 有三条硬限制，必须在写之前拦住——否则文件能生成但**打不开**，
 *    而且报错信息（"发现不可读取的内容"）完全指不到原因：
 *   1. 单元格文本 ≤ **32767** 字符
 *   2. XML 1.0 不允许控制字符（\u0000-\u0008 \u000B \u000C \u000E-\u001F）
 *      ——抽取证据里的 quote 直接来自 PDF，这类字符真的会出现
 *   3. 工作表名 ≤ 31 字符，且不能含 `: \ / ? * [ ]`
 */

import { indexToCol } from './xlsx.mjs';
import { zip } from './zipwrite.mjs';

/** 单元格样式索引（与 styles.xml 里的 cellXfs 顺序一一对应）。 */
export const STYLE = {
  DEFAULT: 0,
  HEADER: 1,
  /** 正文：自动换行 + 顶端对齐 */
  WRAP: 2,
  /** 有分歧：红字 + 浅红底，便于医生一眼找到要仲裁的行 */
  DISPUTED: 3,
};

const CELL_MAX = 32767;

/** XML 文本转义 + 去掉 XML 1.0 非法控制字符。 */
function esc(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 单元格文本按 Excel 上限截断（截断处留标记，免得被误当成完整内容）。 */
function clamp(s) {
  const t = String(s ?? '');
  return t.length > CELL_MAX ? `${t.slice(0, CELL_MAX - 12)}…[已截断]` : t;
}

/** 工作表名净化：去非法字符、截到 31 字符、空名兜底。 */
function safeSheetName(name, index) {
  const t = String(name ?? '').replace(/[:\\/?*[\]]/g, '_').trim().slice(0, 31);
  return t || `Sheet${index + 1}`;
}

/* ------------------------------ 各部件 XML ------------------------------ */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const contentTypes = (names) =>
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + names.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const workbookXml = (names) =>
  `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
  + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  + '</sheets></workbook>';

const workbookRels = (names) =>
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + names.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  + '</Relationships>';

/**
 * 样式表。cellXfs 的顺序必须与上面 `STYLE` 常量一致。
 *
 * fills 的第 0、1 项是 OOXML 的硬要求（none / gray125），不能省。
 */
const stylesXml = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="4">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF0F4"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFDECEA"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '</cellXfs>'
  // 必须显式声明一个 Normal 具名样式，否则 openpyxl 等严格读取器会告警
  // "Workbook contains no default style"（Excel 能开，但不干净）
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** 一格：字符串、数字槽 { v, s, t:'n' } 或普通对象 { v, s }。 */
const cellXml = (ref, cell) => {
  const isObj = cell !== null && typeof cell === 'object';
  const raw = isObj ? cell.v : cell;
  if (isObj && cell.t === 'n') {
    const n = Number(raw);
    const s = cell.s !== undefined ? cell.s : STYLE.DEFAULT;
    return Number.isFinite(n) ? `<c r="${ref}" s="${s}"><v>${n}</v></c>` : '';
  }
  const text = clamp(raw);
  if (text === '') return '';
  const s = isObj && cell.s !== undefined ? cell.s : STYLE.DEFAULT;
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
};

function sheetXml(sheet) {
  const { rows, widths, freeze = true } = sheet;
  const cols = widths?.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const view = freeze
    ? '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  const body = rows.map((row, r) => {
    const cells = row.map((c, i) => cellXml(`${indexToCol(i)}${r + 1}`, c)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  // 元素顺序是 schema 规定的：sheetViews → sheetFormatPr → cols → sheetData
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + view
    + '<sheetFormatPr defaultRowHeight="14"/>'
    + cols
    + `<sheetData>${body}</sheetData>`
    + '</worksheet>';
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 生成 .xlsx 字节。
 *
 * 首行一律按**表头样式**渲染（不要求调用方自己标）。
 *
 * @param {{ name: string, rows: (string | { v: string, s?: number })[][], widths?: number[], freeze?: boolean }[]} sheets
 * @returns {Buffer}
 */
export function buildXlsx(sheets) {
  if (!sheets?.length) throw new Error('buildXlsx：至少要有一个工作表');
  const names = sheets.map((s, i) => safeSheetName(s.name, i));
  const prepared = sheets.map((s) => ({
    ...s,
    rows: s.rows.map((row, r) => (r === 0
      ? row.map((c) => ({ v: String((c && typeof c === 'object' ? c.v : c) ?? ''), s: STYLE.HEADER }))
      : row)),
  }));

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes(names), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(names), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels(names), 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    ...prepared.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s), 'utf8'),
    })),
  ];
  return zip(entries);
}
