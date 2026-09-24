// tools/make_deck.mjs — 生成《组会汇报》PPTX（零依赖：自写 OOXML + ZIP）
//
// 用法：node tools/make_deck.mjs
// 产物：build/deck/文章抽取Agent-组会汇报.pptx
//
// 为什么自写 ZIP：本仓库不引入额外依赖（与 docs/04 的工程决策一致）。
// 只用到 node:zlib 的 deflateRawSync —— 与 tools/lib/xlsx.mjs 读 xlsx 的做法对称。
// 幻灯片元素全部用 PowerPoint 原生形状（矩形/圆角矩形/椭圆/表格），因此在 PPT 里可继续编辑。

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'build', 'deck');
const OUT_FILE = resolve(OUT_DIR, '文章抽取Agent-组会汇报.pptx');

/* ================================================================== *
 * 1. 单位与设计系统
 * ================================================================== */

const PX = 9525;               // 1 px = 9525 EMU（96 DPI）
const px = (v) => Math.round(v * PX);
const pt = (v) => Math.round(v * 100);   // 字号用百分之一磅

const W = 1280, H = 720;

// 版面安全区
const M = 64;                  // 左右页边距
const HEAD_Y = 132;            // 内容起始
const FOOT_Y = 664;
const BODY_W = W - M * 2;      // 1152

const C = {
  ink: '0F172A',
  body: '1E293B',
  muted: '64748B',
  faint: '94A3B8',
  line: 'E2E8F0',
  panel: 'F8FAFC',
  white: 'FFFFFF',
  indigo: '4F46E5',
  teal: '0D9488',
  amber: 'D97706',
  rose: 'E11D48',
  green: '16A34A',
  violet: '7C3AED',
  sky: '0284C7',
};

// 四层架构配色
const LAYER = {
  parse: { c: C.sky, name: '解析层' },
  agent: { c: C.indigo, name: 'Agent 层' },
  verify: { c: C.teal, name: '校验层' },
  human: { c: C.amber, name: '人机层' },
};

const FONT = 'Arial';

/* ================================================================== *
 * 2. ZIP 写入（store / deflate，标准 ZIP 结构）
 * ================================================================== */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** entries: [{ name, data: Buffer }] */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 9 });
    // 压缩没收益就存原始（避免小文件反而变大）
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);           // mod time
    lh.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ================================================================== *
 * 3. DrawingML 构建原语
 * ================================================================== */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const xfrm = (x, y, w, h, rot) =>
  `<a:xfrm${rot ? ` rot="${Math.round(rot * 60000)}"` : ''}>` +
  `<a:off x="${px(x)}" y="${px(y)}"/>` +
  `<a:ext cx="${px(w)}" cy="${px(h)}"/>` +
  `</a:xfrm>`;

const solidFill = (hex, alpha) =>
  `<a:solidFill><a:srgbClr val="${hex}">${alpha === undefined ? '' : `<a:alpha val="${Math.round(alpha * 1000)}"/>`}</a:srgbClr></a:solidFill>`;

const lineXml = (hex, w) =>
  hex === null ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${px(w ?? 1)}"><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></a:ln>`;

const shadow = () => '<a:effectLst/>';

/** 形状几何：prstGeom + 可选 adjustment */
function geom(prst, adj) {
  const gd = adj === undefined ? '' : `<a:gd name="adj" fmla="val ${Math.round(adj * 100000)}"/>`;
  return `<a:prstGeom prst="${prst}"><a:avLst>${gd}</a:avLst></a:prstGeom>`;
}

/** 段落属性 */
function pPr({ align = 'l', size = 12, color = C.body, bold = false, italic = false, spaceBefore = 0, spaceAfter = 0, lh = 100 }) {
  const a = { l: 'l', c: 'ctr', r: 'r', j: 'just' }[align] ?? 'l';
  return (
    `<a:pPr algn="${a}" indent="0" marL="0">` +
    `<a:lnSpc><a:spcPct val="${Math.round(lh * 1000)}"/></a:lnSpc>` +
    (spaceBefore ? `<a:spcBef><a:spcPts val="${pt(spaceBefore)}"/></a:spcBef>` : '') +
    (spaceAfter ? `<a:spcAft><a:spcPts val="${pt(spaceAfter)}"/></a:spcAft>` : '') +
    `<a:buNone/>` +
    `<a:defRPr sz="${pt(size)}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}" kern="120">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/>` +
    `</a:defRPr>` +
    `</a:pPr>`
  );
}

function run(text, { size = 12, color = C.body, bold = false, italic = false, font = FONT }) {
  return (
    `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${pt(size)}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}" dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/>` +
    `</a:rPr><a:t>${esc(text)}</a:t></a:r>`
  );
}

/** 一个富文本段落：runs 为 [{t, size, color, bold, italic}] */
function para(runs, opts = {}) {
  const list = Array.isArray(runs) ? runs : [{ t: runs, ...opts }];
  const p = pPr(opts);
  const body = list.length
    ? list.map((r) => run(r.t, { size: opts.size ?? 12, color: opts.color ?? C.body, bold: r.bold ?? opts.bold, italic: r.italic ?? opts.italic, font: r.font ?? FONT })).join('')
    : '';
  return `<a:p>${p}${body}</a:p>`;
}

function txBody(paras, opts = {}) {
  const anchor = { t: 't', c: 'ctr', b: 'b' }[opts.anchor ?? 't'];
  const wrap = opts.wrap === false ? 'none' : 'square';
  return (
    `<p:txBody>` +
    `<a:bodyPr vert="horz" wrap="${wrap}" lIns="${px(opts.padX ?? 0)}" tIns="${px(opts.padY ?? 0)}" rIns="${px(opts.padX ?? 0)}" bIns="${px(opts.padY ?? 0)}" anchor="${anchor}" anchorCtr="0">` +
    `<a:noAutofit/>` +
    `</a:bodyPr>` +
    `<a:lstStyle/>` +
    paras.join('') +
    `</p:txBody>`
  );
}

/* --------------------------- 形状工厂 --------------------------- */

let SID = 0;
const nextId = () => ++SID;
function shape({ prst = 'rect', x, y, w, h, fill, line, lineW, adj, paras, anchor, padX, padY, rot, name }) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="${esc(name ?? 'Shape')}"/>` +
    `<p:cNvSpPr txBox="0"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(x, y, w, h, rot)}${geom(prst, adj)}` +
    `${fill ? solidFill(fill) : '<a:noFill/>'}${lineXml(line ?? null, lineW)}${shadow()}` +
    `</p:spPr>` +
    (paras ? txBody(paras, { anchor, padX, padY }) : '') +
    `</p:sp>`
  );
}

function textBox({ x, y, w, h, paras, anchor, padX = 0, padY = 0 }) {
  return shape({ prst: 'rect', x, y, w, h, fill: null, line: null, paras, anchor, padX, padY, name: 'Text' });
}

/** 纯文本（无形状边框） */
function label(text, x, y, w, h, opts = {}) {
  return textBox({
    x, y, w, h,
    anchor: opts.anchor ?? 't',
    paras: [para(Array.isArray(text) ? text : [{ t: text }], {
      size: opts.size ?? 13, color: opts.color ?? C.body, bold: opts.bold, align: opts.align ?? 'l', lh: opts.lh ?? 108,
    })],
  });
}

function hLine(x, y, w, hex = C.line, weight = 1) {
  return shape({ prst: 'rect', x, y, w, h: weight, fill: hex, line: null });
}

/* ================================================================== *
 * 4. 复合排版组件
 * ================================================================== */

/** 页眉：小色条 + 标题 + 副标题 */
function slideHeader({ title, kicker, accent = C.indigo, sub }) {
  const els = [];
  els.push(shape({ prst: 'roundRect', x: M, y: 62, w: 6, h: 34, adj: 0.5, fill: accent, line: null }));
  if (kicker) els.push(label(kicker, M + 18, 60, 900, 18, { size: 11.5, color: accent, bold: true }));
  els.push(label(title, M + 18, kicker ? 78 : 68, W - M * 2 - 18, 36, { size: 25, color: C.ink, bold: true }));
  const y = sub ? 122 : null;
  if (sub) els.push(label(sub, M + 18, 118, W - M * 2 - 18, 22, { size: 12.5, color: C.muted }));
  els.push(hLine(M, sub ? 146 : 136, W - M * 2, C.line, 1));
  return els.join('');
}

function footer(page, total, text = '文章抽取 Agent｜组会汇报') {
  return (
    label(text, M, FOOT_Y, 700, 18, { size: 10, color: C.faint }) +
    label(`${page} / ${total}`, W - M - 120, FOOT_Y, 120, 18, { size: 10, color: C.faint, align: 'r' })
  );
}

/** 圆角面板 */
function panel(x, y, w, h, { tint = C.panel, border = C.line, adj = 0.06, accent, accentW = 4 } = {}) {
  let s = shape({ prst: 'roundRect', x, y, w, h, adj, fill: tint, line: border, lineW: 1, name: 'Panel' });
  if (accent) s += shape({ prst: 'roundRect', x, y, w: accentW, h, adj: 0.5, fill: accent, line: null });
  return s;
}

/** 卡片：标题 + 正文 */
function card({ x, y, w, h, title, lines, accent = C.indigo, tint = C.white, titleSize = 14, bodySize = 11.5, tag }) {
  let s = panel(x, y, w, h, { tint, border: C.line, accent });
  const paras = [];
  if (tag) paras.push(para([{ t: tag }], { size: 10, color: accent, bold: true, spaceAfter: 3 }));
  paras.push(para([{ t: title }], { size: titleSize, color: C.ink, bold: true, spaceAfter: 5 }));
  for (const l of lines ?? []) {
    if (typeof l === 'string') paras.push(para([{ t: l }], { size: bodySize, color: C.body, spaceAfter: 3, lh: 118 }));
    else paras.push(para(l, { size: bodySize, color: C.body, spaceAfter: 3, lh: 118 }));
  }
  s += textBox({ x: x + 16, y: y + 13, w: w - 30, h: h - 22, paras });
  return s;
}

/** KPI 大数字 */
function kpi({ x, y, w, h, value, unit, caption, color = C.indigo, tint }) {
  let s = shape({ prst: 'roundRect', x, y, w, h, adj: 0.1, fill: tint ?? C.panel, line: C.line, lineW: 1 });
  const runs = [{ t: value, size: 32, color, bold: true }];
  if (unit) runs.push({ t: ` ${unit}`, size: 14, color: C.muted, bold: false });
  s += textBox({
    x: x + 14, y: y + 12, w: w - 28, h: h - 24,
    paras: [para(runs, { spaceAfter: 2 }), para([{ t: caption }], { size: 11, color: C.muted, lh: 118 })],
  });
  return s;
}

/** 横向条形图（原生矩形 + 标注），rows: [{label, value, note, color}] */
function barChart({ x, y, w, h, rows, max, unit = '%', labelW = 240, valueW = 74 }) {
  const els = [];
  const n = rows.length;
  const rowH = h / n;
  const barX = x + labelW;
  const barW = w - labelW - valueW;
  const scale = max ?? Math.max(...rows.map((r) => r.value));
  rows.forEach((r, i) => {
    const cy = y + i * rowH;
    const bh = Math.min(rowH - 10, 22);
    const by = cy + (rowH - bh) / 2;
    els.push(shape({ prst: 'rect', x, y: by, w: barW + valueW, h: bh, fill: C.panel, line: null, name: `Track${i}` }));
    const bw = Math.max(3, (r.value / scale) * barW);
    els.push(shape({ prst: 'roundRect', x: barX, y: by, w: bw, h: bh, adj: 0.35, fill: r.color ?? C.indigo, line: null, name: `Bar${i}` }));
    els.push(label(r.label, x, cy + (rowH - 16) / 2 - 1, labelW - 12, 18, { size: 12, color: C.body, align: 'r' }));
    els.push(
      label(
        [{ t: `${r.value}${unit}`, size: 12.5, color: r.color ?? C.indigo, bold: true }].concat(r.note ? [{ t: `  ${r.note}`, size: 10, color: C.faint }] : []),
        barX + barW + 6, cy + (rowH - 16) / 2 - 1, valueW + 90, 18, { size: 12.5 }
      )
    );
  });
  return els.join('');
}

/** 步骤/流程：横向等宽条 + 箭头 */
function flowRow({ x, y, w, h, steps, gap = 10 }) {
  const els = [];
  const n = steps.length;
  const bw = (w - gap * (n - 1)) / n;
  steps.forEach((s, i) => {
    const bx = x + i * (bw + gap);
    const color = s.color ?? C.indigo;
    els.push(shape({ prst: 'roundRect', x: bx, y, w: bw, h, adj: 0.1, fill: s.tint ?? C.panel, line: C.line, lineW: 1, name: `Step${i}` }));
    els.push(shape({ prst: 'rect', x: bx, y, w: bw, h: 4, fill: color, line: null }));
    els.push(
      textBox({
        x: bx + 10, y: y + 12, w: bw - 20, h: h - 20,
        paras: [
          para([{ t: s.title }], { size: 13, color: C.ink, bold: true, align: 'c', spaceAfter: 3 }),
          ...(s.lines ?? []).map((l) => para([{ t: l }], { size: 10.5, color: C.muted, align: 'c', spaceAfter: 1, lh: 116 })),
        ],
      })
    );
    if (i < n - 1) {
      els.push(shape({ prst: 'triangle', x: bx + bw + 1, y: y + h / 2 - 5, w: 8, h: 10, rot: 90, fill: C.faint, line: null }));
    }
  });
  return els.join('');
}

/** 简单表格 */
function table({ x, y, w, colW, header, rows, rowH = 30, headH = 32, headFill = C.ink, zebra = true, firstColAlign = 'l', size = 11 }) {
  const totalW = colW.reduce((a, b) => a + b, 0);
  const k = w / totalW;
  const cols = colW.map((c) => c * k);
  // 先放外框与底色（后放的会盖住先放的）
  let els = [shape({ prst: 'rect', x, y, w, h: headH + rows.length * rowH, fill: null, line: C.line, lineW: 1 })];
  let cx = x;

  // 表头
  cols.forEach((cw, j) => {
    els.push(shape({ prst: 'rect', x: cx, y, w: cw, h: headH, fill: headFill, line: null }));
    els.push(textBox({
      x: cx + 10, y: y + 4, w: cw - 20, h: headH - 6,
      paras: [para([{ t: header[j] }], { size: size, color: C.white, bold: true, align: j === 0 ? 'l' : 'c' })],
    }));
    cx += cw;
  });

  rows.forEach((r, i) => {
    const ry = y + headH + i * rowH;
    cx = x;
    const bg = zebra && i % 2 === 1 ? C.panel : C.white;
    els.push(shape({ prst: 'rect', x, y: ry, w, h: rowH, fill: bg, line: null }));
    els.push(hLine(x, ry + rowH, w, C.line, 1));
    cols.forEach((cw, j) => {
      const cell = r[j];
      const runs = Array.isArray(cell) ? cell : [{ t: cell }];
      const norm = runs.map((rr) => ({ t: rr.t, bold: rr.bold, color: rr.color ?? (j === 0 ? C.ink : C.body) }));
      els.push(textBox({
        x: cx + 10, y: ry + 3, w: cw - 20, h: rowH - 4,
        paras: [para(norm, { size: size, align: j === 0 ? firstColAlign : 'c', color: j === 0 ? C.ink : C.body })],
      }));
      cx += cw;
    });
  });
  return els.join('');
}

/* ================================================================== *
 * 5. 幻灯片装配
 * ================================================================== */

const slides = [];
function addSlide(build) {
  slides.push(build);
}

/** 统一页脚：页码从 1 开始，总页数在全部装配完后才知道 */
let TOTAL_PAGES = 0;
const withFooter = (body, page) => body + footer(page, TOTAL_PAGES);

/* --------------------------- 幻灯片 1：封面 --------------------------- */
addSlide(() => {
  let s = shape({ prst: 'rect', x: 0, y: 0, w: W, h: H, fill: C.ink, line: null });
  // 右侧装饰色带
  s += shape({ prst: 'rect', x: W - 300, y: 0, w: 300, h: H, fill: '16213B', line: null });
  s += shape({ prst: 'rect', x: W - 300, y: 0, w: 6, h: H, fill: C.indigo, line: null });
  s += shape({ prst: 'ellipse', x: W - 210, y: 120, w: 250, h: 250, fill: C.indigo, line: null });
  s += shape({ prst: 'ellipse', x: W - 150, y: 330, w: 150, h: 150, fill: C.teal, line: null });

  s += label('组会汇报', M, 150, 400, 22, { size: 13, color: C.teal, bold: true });
  s += label('从 PDF 研究论文到结构化数据', M, 182, 800, 56, { size: 38, color: C.white, bold: true });
  s += label('多 Agent 分层抽取流水线的设计、问题解决与准确率提升', M, 234, 820, 30, { size: 17, color: 'CBD5E1' });
  s += hLine(M, 296, 120, C.indigo, 3);

  s += label(
    [
      { t: 'evidence-first', size: 13, color: C.white, bold: true },
      { t: ' · ', size: 13, color: C.faint },
      { t: '模型只回 quote、坐标本地定位', size: 13, color: 'CBD5E1' },
      { t: ' · ', size: 13, color: C.faint },
      { t: '能判定的交给代码', size: 13, color: 'CBD5E1' },
    ],
    M, 318, 860, 24, { size: 13 }
  );

  const items = [
    ['2015–2025', '11 个年份 · 224 篇文章'],
    ['1 114', '金标准结局行'],
    ['7', 'SKILL · 3 层粒度'],
    ['72.5%', 'Sheet3 严格口径准确率'],
  ];
  items.forEach((it, i) => {
    const bx = M + i * 208;
    s += shape({ prst: 'roundRect', x: bx, y: 400, w: 190, h: 88, adj: 0.1, fill: '1B2942', line: '26374F', lineW: 1 });
    s += label(it[0], bx + 14, 414, 170, 32, { size: 22, color: i === 3 ? C.teal : C.white, bold: true });
    s += label(it[1], bx + 14, 448, 170, 34, { size: 10.5, color: '94A3B8', lh: 112 });
  });

  s += label('技术栈：MinerU 3.4.5（本地 GPU） · DeepSeek · TypeScript/pnpm workspace · React + pdf.js · Electron',
    M, 530, 1000, 40, { size: 11, color: '7A8AA3', lh: 130 });
  s += label('2026-09', M, 600, 300, 20, { size: 11, color: '7A8AA3' });
  return s;
});

/* --------------------------- 幻灯片 2：执行摘要 --------------------------- */
addSlide(() => {
  let b = '';
  b += kpi({ x: M, y: HEAD_Y + 4, w: 268, h: 92, value: '69.0%', caption: 'Sheet1 文章级 + 比较组（470/681）', color: C.indigo });
  b += kpi({ x: M + 292, y: HEAD_Y + 4, w: 268, h: 92, value: '75.0%', caption: 'Sheet2 结局分类（严格 19/19 + 语义）', color: C.violet });
  b += kpi({ x: M + 584, y: HEAD_Y + 4, w: 268, h: 92, value: '72.5%', caption: 'Sheet3 结局 × 时点（477/658）', color: C.teal });
  b += kpi({ x: M + 876, y: HEAD_Y + 4, w: 276, h: 92, value: '0', unit: '处', caption: '证据不变量违规：6/6 篇全部通过', color: C.green });

  b += card({
    x: M, y: 246, w: 560, h: 190, accent: C.indigo, title: '设计主线：三层粒度，一条硬不变量',
    lines: [
      [{ t: '三层粒度 ', bold: true }, { t: 'article（YYYY-NN）→ comparison（YYYY-NN-K）→ outcome（结局 × 时点），与金标准三张 Sheet 一一对应。' }],
      [{ t: '硬不变量 ', bold: true, color: C.rose }, { t: '任何进入结果的字段必须带原文证据；无证据只能进 unresolved，不得进 fields。' }],
      [{ t: '字段三元组 ', bold: true }, { t: '{ raw 逐字原文 · code 受控编码 · legend 编码含义 }——机器可评分，人可复核。' }],
      [{ t: '关键效果 ', bold: true, color: C.green }, { t: '字段级 page/bbox/quote 全部可回跳 PDF，人工复核有据可依。' }],
    ],
  });

  b += card({
    x: M + 584, y: 246, w: 568, h: 190, accent: C.teal, title: '三条方法论（被实测反复证明）',
    lines: [
      [{ t: '① 可判定的交给代码。', bold: true }, { t: '受控编码映射、坐标定位、DOI 形态、数值↔编码自洽、随访三件套补全——全部本地确定性完成。' }],
      [{ t: '② 模型只回 quote，坐标本地定位。', bold: true }, { t: '模型看不到页面坐标，让它给坐标必然编造；定位失败即拒收，不伪造。' }],
      [{ t: '③ 抽不出来先问「这句话在材料里吗」。', bold: true }, { t: 'measurement_range 全 0% 的根因是材料窗口缺 methods 章节，不是提示词问题。' }],
    ],
  });

  b += panel(M, 456, 1152, 168, { tint: C.panel, accent: C.ink });
  b += label('汇报结构', M + 20, 470, 300, 22, { size: 14, color: C.ink, bold: true });
  const agenda = [
    ['01', '背景与目标', '要解决什么问题'],
    ['02', '系统设计', '四层架构 · 7 个 SKILL'],
    ['03', '三个真实难题', '症状 → 根因 → 修法'],
    ['04', '准确率提升', '每一步都实测一次'],
    ['05', '数据快照', '2015 六篇当前水平'],
    ['06', '路线图', 'P1–P4 与验收标准'],
  ];
  agenda.forEach((a, i) => {
    const ax = M + 24 + i * 186;
    b += label(a[0], ax, 506, 60, 30, { size: 18, color: C.line, bold: true });
    b += label(a[1], ax, 540, 170, 20, { size: 12.5, color: C.ink, bold: true });
    b += label(a[2], ax, 558, 170, 50, { size: 10.5, color: C.muted, lh: 116 });
  });
  return withFooter(b, 2);
});

/* --------------------------- 幻灯片 3：背景 --------------------------- */
addSlide(() => {
  let b = '';
  b += card({
    x: M, y: HEADER_Y(), w: 372, h: 214, accent: C.rose, title: '要解决的问题', tag: 'PROBLEM',
    lines: [
      '系统评价 / 循证医学需要把针刺 RCT 论文里的方法学与结局数据录入结构化数据库。',
      '金标准是一套 11 个年份、224 篇文章、1114 行结局的 Excel，多数列是受控编码，证据是相邻列的原文。',
      '人工录入慢、易错，且最难发现的错误恰恰是「3 看成 5」这类编码误读。',
    ],
  });
  b += card({
    x: M + 402, y: HEADER_Y(), w: 372, h: 228, accent: C.indigo, title: '数据的三层粒度', tag: 'DATA SHAPE',
    lines: [
      [{ t: 'article ', bold: true }, { t: '每篇 1 条：PICO、期刊、国家、疾病系统…（Sheet1 文章字段 + Sheet2）' }],
      [{ t: 'comparison ', bold: true }, { t: '每个「试验组 vs 对照组」1 条：设计、针刺方案、分析人群' }],
      [{ t: 'outcome ', bold: true }, { t: '每个「结局 × 时点 × 比较组」1 条：效应量、CI、例数、事件数' }],
      [{ t: '含 K 个比较组的文章在 comparison/outcome 层展开为 K 行，article 层归约为 1 条。', italic: true, color: C.muted }],
    ],
  });
  b += card({
    x: M + 804, y: HEADER_Y(), w: 348, h: 214, accent: C.amber, title: '为什么不能「一把梭」', tag: 'CONSTRAINT',
    lines: [
      '一篇 PDF 的 MinerU 中间产物 1.4 MB，含大量中间态；Agent 不能直接读。',
      '一次调用要输出上百个带 quote 的对象就会撞输出上限，整层数据丢失（结局层与比较组层都栽过）。',
      '模型看不到坐标；金标准自身还有列错位、写散文、跨年 ID 笔误。',
    ],
  });

  b += panel(M, 366, 1152, 26, { tint: C.ink });
  b += label(
    '目标：在「可追溯到原文证据」的前提下，把 3 层 × 7 类 SKILL 的抽取准确率做到可量化、可回归、可人工复核的水平',
    M + 16, 370, 1120, 20, { size: 12, color: C.white, bold: true }
  );

  const goals = [
    { t: 'G1 证据可追溯', c: C.teal, l: ['每个字段带 page + bbox + quote', '前端点字段 → PDF 定位高亮', '人工框选可替换自动证据'] },
    { t: 'G2 准确率可量化', c: C.indigo, l: ['逐字段命中/错/漏/多 报告', '严格口径 + 语义判定双轨', '金标准异常先排除再评分'] },
    { t: 'G3 不产生幻觉', c: C.rose, l: ['模型只回 quote，本地定位', '定位失败即丢弃，不伪造坐标', '不确定就填 NR，不强行归类'] },
    { t: 'G4 可复现可回归', c: C.green, l: ['请求指纹缓存，改提示词自动失效', '录制/回放模型响应，离线评测', '205 个离线测试锁住行为'] },
    { t: 'G5 人机回环', c: C.amber, l: ['人工修改存覆盖层，不改产物', 'add / override / confirm 三态', '可算人工修正率'] },
  ];
  goals.forEach((g, i) => {
    const bx = M + i * 234;
    b += card({ x: bx, y: 410, w: 222, h: 214, accent: g.c, title: g.t, lines: g.l, titleSize: 13.5, bodySize: 11 });
  });
  return withFooter(b, 3);
});

/* --------------------------- 幻灯片 4：四层架构 --------------------------- */
addSlide(() => {
  let b = '';
  const y = 168;
  const layers = [
    {
      ...LAYER.parse, x: M, w: 430, h: 244,
      items: [
        'PDF → MinerU 3.4.5（本地 GPU，pipeline 后端）',
        '_middle.json（含几何与表格 HTML）',
        '清洗：去噪 24% · 合并续表伪影 · caption 保守修复',
        'MiniDoc：127 块 / 11 页，带章节归属与 bbox',
      ],
      note: '唯一输入：Agent 不读 1.4MB 原始中间态',
    },
    {
      ...LAYER.agent, x: M + 452, w: 340, h: 244,
      items: [
        '7 个 SKILL，按依赖拓扑顺序执行',
        '上游规划 → 下游抽取（清单带锚定校验）',
        '按比较组 / 按结局扇出，单次响应保持小',
        '材料按阶段裁剪，表格不受章节过滤',
      ],
      note: '关键：结构判断与细节抽取分开',
    },
    {
      ...LAYER.verify, x: M + 814, w: 338, h: 244,
      items: [
        'groundField：quote → bbox 本地定位',
        'legend：受控编码确定性解码',
        'timepoints：数值↔编码自洽推导',
        'Crossref：DOI / 题名 / 期刊 / 年份核验',
      ],
      note: '编码与坐标绝不交给模型',
    },
  ];
  layers.forEach((L) => {
    b += panel(L.x, y, L.w, L.h, { tint: C.white, accent: L.c });
    b += label(L.name, L.x + 18, y + 16, 200, 26, { size: 18, color: L.c, bold: true });
    b += label(L.note, L.x + 18, y + 44, L.w - 36, 20, { size: 11, color: C.muted });
    L.items.forEach((t, i) => {
      const iy = y + 74 + i * 38;
      b += shape({ prst: 'ellipse', x: L.x + 20, y: iy + 5, w: 6, h: 6, fill: L.c, line: null });
      b += label(t, L.x + 36, iy, L.w - 56, 34, { size: 11.5, color: C.body, lh: 122 });
    });
  });

  // 层间箭头
  [M + 434, M + 796].forEach((ax) => {
    b += shape({ prst: 'triangle', x: ax, y: y + 110, w: 14, h: 22, rot: 90, fill: C.faint, line: null });
  });

  // 人机层
  const hy = 442;
  b += panel(M, hy, 1152, 92, { tint: 'FFFBEB', border: 'FDE68A', accent: C.amber });
  b += label('人机层', M + 18, hy + 14, 200, 26, { size: 18, color: C.amber, bold: true });
  b += label('人工修改绝不写回产物', M + 18, hy + 42, 260, 20, { size: 11, color: C.muted });
  const hItems = [
    '前端：PDF 连续滚动 + 解析块/证据/人工证据三层叠加框选',
    '人工覆盖层 build/annotations/**：只记 {fieldPath, action, value, note}',
    'action 按「值是否变化」判定：add / override / confirm',
    '「待人工确认纳入」：非六类候选结局由人决定是否提升为正式行',
  ];
  hItems.forEach((t, i) => {
    const ix = M + 300 + i * 216;
    b += shape({ prst: 'ellipse', x: ix, y: hy + 30, w: 6, h: 6, fill: C.amber, line: null });
    b += label(t, ix + 14, hy + 22, 206, 60, { size: 10.5, color: C.body, lh: 126 });
  });

  b += panel(M, 552, 1152, 96, { tint: C.ink });
  b += label('贯穿四层的两条不变量', M + 20, 564, 400, 22, { size: 13, color: C.teal, bold: true });
  b += label(
    [
      { t: '① 证据前置：', bold: true, color: C.white, size: 12 },
      { t: 'makeField() 无证据直接抛 EvidenceRequiredError；auditEvidence() 递归审计整份结果。', color: 'CBD5E1', size: 12 },
    ],
    M + 20, 590, 1100, 24, { size: 12 }
  );
  b += label(
    [
      { t: '② 确定性优先：', bold: true, color: C.white, size: 12 },
      { t: '能用规则做对的一律本地做（编码映射 / 坐标 / DOI 形态 / 数值自洽），模型的产出必须落地成功才算数。', color: 'CBD5E1', size: 12 },
    ],
    M + 20, 616, 1100, 24, { size: 12 }
  );
  return withFooter(b, 4);
});

function HEADER_Y() { return 168; }

/* --------------------------- 幻灯片 5：三层粒度与字段契约 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('三层粒度与金标准一一对应，是评测对齐与扇出的基础', M, 162, 900, 22, { size: 13, color: C.muted });

  b += table({
    x: M, y: 192, w: 1152, colW: [130, 190, 150, 330, 170],
    header: ['层', '主键', '金标准来源', '内容', '展开规则'],
    rowH: 44,
    rows: [
      ['article', 'YYYY-NN', 'Sheet1 文章字段 + Sheet2', 'PICO、期刊/国家、疾病系统、结局分类', '每篇 1 条'],
      ['comparison', 'YYYY-NN-K', 'Sheet1 每行', '设计、针刺方案、分析人群、随机/盲法编码', 'K 个比较组 → K 条'],
      ['outcome', 'YYYY-NN-K', 'Sheet3 每行', '结局 × 时点（连续/二分类/等级资料三块）', 'K × 结局数 → 行'],
    ],
  });

  b += label('字段三元组：机器可评分，人可复核', M, 372, 600, 24, { size: 15, color: C.ink, bold: true });
  b += shape({ prst: 'roundRect', x: M, y: 402, w: 1152, h: 96, adj: 0.08, fill: C.ink, line: null });
  b += label(
    'interface FieldValue {\n  raw: string          // 逐字原文，绝不改写\n  code?: string        // 受控编码，如 "1" / "2/5"\n  legend?: string      // 编码含义，来自金标准图例行\n  evidence: Evidence[] // 至少一条，含 page / bbox / quote\n}',
    M + 24, 414, 660, 78, { size: 11.5, color: '93E6D2', lh: 132 }
  );
  b += label(
    '哨兵约定（三层统一）\n\nNR = 文中未报告\nNA = 不适用（如给穴位按压填进针深度）\nNE = 提到该指标但无法确定数值',
    M + 730, 414, 400, 78, { size: 11.5, color: 'CBD5E1', lh: 140 }
  );

  b += label('结局只找六类（需求明确的口径）', M, 522, 600, 24, { size: 15, color: C.ink, bold: true });
  const six = [['1', '疼痛类', C.rose], ['2', '非疼痛症状类', C.indigo], ['3', '功能类', C.teal], ['4', '生活质量类', C.violet], ['5', '重要事件类', C.amber], ['6', '死亡率', C.ink]];
  six.forEach((s, i) => {
    const bx = M + i * 132;
    b += shape({ prst: 'roundRect', x: bx, y: 552, w: 120, h: 52, adj: 0.14, fill: C.white, line: C.line, lineW: 1 });
    b += shape({ prst: 'rect', x: bx, y: 552, w: 120, h: 3, fill: s[2], line: null });
    b += label([{ t: `${s[0]}  `, size: 12, color: s[2], bold: true }, { t: s[1], size: 12, color: C.ink }], bx + 12, 574, 110, 26, { size: 12, lh: 110 });
  });
  b += card({
    x: M + 806, y: 546, w: 346, h: 80, accent: C.muted, tint: C.panel, titleSize: 10.5, bodySize: 9.5,
    title: '归不进六类 → otherOutcomes',
    lines: ['记录名称/工具/出处，不自动抽数值，交人工判断是否纳入'],
  });
  return withFooter(b, 5);
});

/* --------------------------- 幻灯片 6：分工原则 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('核心机制一：把能判定的事交给确定性代码，模型只做「读懂原文」', M, 160, 1000, 26, { size: 15, color: C.ink, bold: true });
  b += table({
    x: M, y: 194, w: 1152, colW: [300, 150, 430, 250],
    header: ['环节', '谁做', '为什么', '落地位置'],
    rowH: 40,
    rows: [
      ['读懂原文（期刊名、国家、疾病名）', [{ t: '模型', color: C.indigo, bold: true }], '自由文本理解，规则无法穷举', 'article-meta / comparison 提示词'],
      ['受控编码映射（"3" vs "5"）', [{ t: '本地确定性', color: C.teal, bold: true }], '两串长得太像，人工极难发现；恰是最能用规则做对的一环', 'legend.ts decode()'],
      ['证据坐标定位', [{ t: '本地', color: C.teal, bold: true }], '模型看不到页面坐标，给它坐标必然编造', 'grounding.ts locateEvidence()'],
      ['DOI 形态校验', [{ t: '本地', color: C.teal, bold: true }], '正文文本流会拼出 10.1136/…group.bmj.com 这类脏值', 'crossref isLikelyDoi()'],
      ['数值 ↔ 编码自洽（measurementType）', [{ t: '本地', color: C.teal, bold: true }], '能由自己产出推导的编码不该让模型猜', 'timepoints.ts inferMeasurementType()'],
      ['随访「数值 + 单位」补全', [{ t: '本地', color: C.teal, bold: true }], '描述里已能解析出数值与单位，缺格就地补', 'outcome.ts normalizeFollowUp()'],
      ['Crossref 一致性判定', [{ t: '本地', color: C.teal, bold: true }], '确定性比较，且只判定 + 记录，不自动「修正」', 'crossref verify.ts'],
    ],
  });

  b += panel(M, 500, 560, 150, { tint: 'FFF1F2', border: 'FECDD3', accent: C.rose });
  b += label('一个刻意的保守行为：解不出就承认解不出', M + 20, 512, 500, 24, { size: 13, color: C.rose, bold: true });
  b += label(
    'conditionSystem（疾病系统）的论文写的是具体疾病名（fibromyalgia），图例给的是系统类别（1=肌肉骨骼…）。把前者映射到后者需要医学知识，属语义映射，字符串匹配不可靠。\n\n解码器拒绝猜，如实记 CODE_DECODE_FAILED，字段留空交人工——而不是产出一个看似正确、实则可能错误的编码。测试把这个行为固定为规格。',
    M + 20, 540, 520, 100, { size: 10.5, color: C.body, lh: 128 }
  );

  b += panel(M + 592, 500, 560, 150, { tint: 'F0FDFA', border: '99F6E4', accent: C.teal });
  b += label('一个消除重复维护的决定', M + 612, 512, 500, 24, { size: 13, color: C.teal, bold: true });
  b += label(
    '图例有三份来源：自动提取、人工维护清单、解码器 LEGENDS——会各自漂移。\n\n审计发现解码器漏登记 18 个字段，导致 decode() 返回 none、编码推导静默失效且无任何报错。\n\n修法不是把 18 个字段再抄一遍（必然再次漂移），而是让 legendFor() 在未命中时自动回退到规范清单：编码表只有一处真源。',
    M + 612, 540, 520, 100, { size: 10.5, color: C.body, lh: 128 }
  );
  return withFooter(b, 6);
});

/* --------------------------- 幻灯片 7：SKILL 分层与编排 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('核心机制二：结构判断与细节抽取分开，两套长规则不共处一次调用', M, 160, 1050, 26, { size: 15, color: C.ink, bold: true });

  const stages = [
    { n: 'study-plan', t: '结构规划', l: ['几个组、几组比较', '谁 vs 谁'], c: C.violet, m: '摘要+方法' },
    { n: 'article-meta', t: '文章级', l: ['23 字段', 'Crossref 覆盖'], c: C.indigo, m: '摘要+首页页脚' },
    { n: 'comparison', t: '比较组级', l: ['逐比较组调用', '55 字段'], c: C.indigo, m: '方法+结果+表格' },
    { n: 'outcome-plan', t: '结局枚举', l: ['论文自己声明了哪些', '带声明句锚定'], c: C.violet, m: '摘要+方法' },
    { n: 'outcome', t: '结局自身字段', l: ['名称/工具/编码', '范围/方向/单位'], c: C.sky, m: '结果+表格' },
    { n: 'outcome-values', t: '结局 × 时点数值', l: ['效应量/变异值', '例数/事件数'], c: C.sky, m: '结果+表格' },
    { n: 'outcome-audit', t: '查漏补缺', l: ['先确定性清单', '再 1 次 LLM 核查'], c: C.teal, m: '全材料+已抽结果' },
  ];
  const bw = 154, gap = 10;
  stages.forEach((s, i) => {
    const bx = M + i * (bw + gap);
    const by = 200;
    b += shape({ prst: 'roundRect', x: bx, y: by, w: bw, h: 150, adj: 0.1, fill: C.white, line: C.line, lineW: 1 });
    b += shape({ prst: 'rect', x: bx, y: by, w: bw, h: 4, fill: s.c, line: null });
    b += label(s.n, bx + 8, by + 14, bw - 16, 34, { size: 11, color: s.c, bold: true, align: 'c', lh: 112 });
    b += label(s.t, bx + 8, by + 50, bw - 16, 20, { size: 12, color: C.ink, bold: true, align: 'c' });
    s.l.forEach((l, j) => {
      b += label(l, bx + 8, by + 74 + j * 22, bw - 16, 22, { size: 9.5, color: C.muted, align: 'c', lh: 116 });
    });
    b += label(s.m, bx + 8, by + 122, bw - 16, 20, { size: 9, color: C.faint, align: 'c' });
    if (i < stages.length - 1) {
      b += shape({ prst: 'triangle', x: bx + bw + 1, y: by + 72, w: 7, h: 9, rot: 90, fill: C.faint, line: null });
    }
  });

  b += label('上游规划 → 下游执行：清单先定下来，下游不再自己枚举（实测：4 条变 9 条、准确率掉 6 个点）',
    M, 358, 1100, 20, { size: 11, color: C.muted, italic: true });

  b += card({
    x: M, y: 392, w: 372, h: 258, accent: C.indigo, title: '为什么这样拆',
    lines: [
      [{ t: '结构 vs 细节。', bold: true }, { t: '一次调用既数条数又填字段，必然数错或填漏。' }],
      [{ t: '两套长规则不共处。', bold: true }, { t: '数值取列规则（3553 字符）与字段图例（3708 字符）合在一起会互相挤占，拆开后数值类命中 157 → 203、漏 74 → 27。' }],
      [{ t: '单次响应要小。', bold: true }, { t: '一个响应里带 quote 的对象超过约 100 个就会撞输出上限并整层丢失。' }],
      [{ t: '材料按阶段裁剪。', bold: true }, { t: '枚举阶段只看摘要+方法（表格会把模型引去数行，结局条数翻两三倍）。' }],
    ],
  });

  b += card({
    x: M + 390, y: 386, w: 372, h: 264, accent: C.teal, title: '调用与成本控制',
    lines: [
      [{ t: '逐「结局 × 比较组」取数。', bold: true }, { t: '多臂试验里同一结局在不同比较组取不同行（2015-04：比较组 1 取 A 行 −1.56、比较组 2 取 B 行 −2.34）。曾按「名称|工具」去重是静默错误。' }],
      [{ t: '材料在前、任务在后。', bold: true }, { t: '同篇多次调用共享前缀，命中服务端上下文缓存。' }],
      [{ t: '请求指纹缓存。', bold: true }, { t: 'tag + system + user + model；改提示词自动失效，重复运行不重复付费，评测可离线复现。' }],
      [{ t: '局部重跑不互相冲掉。', bold: true }, { t: 'outcome 与 outcome-values 各写一半。' }],
    ],
  });

  b += panel(M + 780, 392, 372, 258, { tint: C.panel, accent: C.rose });
  b += label('7 个真实缺陷（都有症状→根因→修法）', M + 800, 406, 336, 24, { size: 13, color: C.rose, bold: true });
  const bugs = [
    '首页页眉/页脚被当噪声丢弃 → 期刊名、DOI、通讯邮箱全部抽成 NR',
    'Sheet2 七个字段恒 0%：在清单里但没进提示词模板，也没进 FIELD_MAP → 静默丢弃',
    '结局层整层丢失（finish_reason=length）：一次调用要输出上百个对象',
    '40 次调用里 5 次 JSON 解析失败：模型把多行 quote 原样粘进字符串（裸换行）',
    '比较组 15 个字段恒 0%：金标准有这些列，规范清单里没有',
    '跨接错位：camelToSnake 遇连续大写断不开 → 评测与审计同时算错',
    '时点数值字段被静默丢弃：路径映射的键没带「类型」这一层',
  ];
  bugs.forEach((t, i) => {
    const iy = 432 + i * 34;
    b += label(`${i + 1}`, M + 800, iy, 16, 20, { size: 10.5, color: C.rose, bold: true });
    b += label(t, M + 818, iy, 322, 36, { size: 9.5, color: C.body, lh: 112 });
  });
  return withFooter(b, 7);
});

/* --------------------------- 幻灯片 8：难题 A 解析层 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('难题 A｜上游解析：几何不可信、媒体会丢、坐标系不一致', M, 160, 1000, 26, { size: 15, color: C.ink, bold: true });

  const rows = [
    {
      a: ['content_list 的 bbox 越界', '同一块 "Original paper"：_middle.json 给 [458,18,537,30]（页宽 595，自洽），content_list 给 [769,22,902,37]（x 超出页宽）。'],
      bb: ['各页越界比例不一致（x 方向 1.19~1.53 倍），无法用统一缩放系数还原。'],
      cc: ['只读 _middle.json。它还有更细的块类型（abstract / ref_text）、独立的 discarded_blocks（天然可审计）、table.blocks[] 带 image_path、inline_equation 已含 LaTeX。'],
    },
    {
      a: ['补充材料表被整张丢掉', '2015-02 的 eTable 1（3300 字符的结局数据表）凭空消失；审计发现两处独立原因。'],
      bb: ['① 补充材料常排在参考文献之后 → MinerU 归到 references 章节 → 被当噪声滤掉；② 超容量裁剪「从后往前丢」，而论文最后往往正是补充材料表。'],
      cc: ['表格用 caption 特征单独放行（Table 2 / eTable 1 / Supplementary Table 3），只排除无 caption 的窄网格伪表格；裁剪改为「先丢正文块，表格图片留到最后」。加了可复现审计 pnpm mineru:media，按篇逐层计数。'],
    },
    {
      a: ['旋转页坐标系错位', 'bbox 落在 canonical（未旋转）框架，page_size 却是显示方向的宽高互换。直接叠加会整体偏移 199pt。'],
      bb: ['连续三版「修复」都改错，根因是 top = height − y 用错了 height——即坐标框架没统一。'],
      cc: ['明确契约：bbox = 页面左上角原点的未旋转坐标系，单位 pt；rotate 记在 MiniDocPage 上。前端先按 rotate 旋转画布，再叠加 canonical 坐标。canonicalSize/bboxToScreen/screenToBbox 互为逆运算，13 个测试覆盖 rotate 0/90/180/270。'],
    },
  ];
  rows.forEach((r, i) => {
    const y = 196 + i * 156;
    b += panel(M, y, 1152, 144, { tint: C.white, accent: [C.sky, C.teal, C.amber][i] });
    b += shape({ prst: 'roundRect', x: M + 14, y: y + 14, w: 26, h: 26, adj: 0.25, fill: [C.sky, C.teal, C.amber][i], line: null });
    b += label(['A', 'B', 'C'][i], M + 20, y + 18, 20, 20, { size: 12, color: C.white, bold: true, align: 'c' });
    b += label(r.a[0], M + 52, y + 14, 420, 24, { size: 13, color: C.ink, bold: true });
    b += label(r.a[1], M + 52, y + 38, 480, 96, { size: 10.5, color: C.body, lh: 126 });
    b += shape({ prst: 'rect', x: M + 552, y: y + 16, w: 1, h: 112, fill: C.line, line: null });
    b += label('根因', M + 570, y + 14, 60, 20, { size: 10.5, color: C.rose, bold: true });
    b += label(r.bb[0], M + 570, y + 36, 260, 100, { size: 10, color: C.body, lh: 126 });
    b += label('修法', M + 848, y + 14, 60, 20, { size: 10.5, color: C.green, bold: true });
    b += label(r.cc[0], M + 848, y + 36, 290, 100, { size: 10, color: C.body, lh: 126 });
  });

  b += label('通用教训：同类分支出现不一致结果时，去打印真实数据，不要继续加启发式。', M, 634, 1100, 22, { size: 11.5, color: C.rose, bold: true, italic: true });
  return withFooter(b, 8);
});

/* --------------------------- 幻灯片 9：难题 B 幻觉 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('难题 B｜防幻觉：模型看不到坐标，也常把 quote写得「比原文更规范」', M, 160, 1100, 26, { size: 15, color: C.ink, bold: true });

  // 模型回传 → 本地定位 → 落地
  b += shape({ prst: 'roundRect', x: M, y: 200, w: 350, h: 108, adj: 0.1, fill: 'FEF2F2', line: 'FECDD3', lineW: 1 });
  b += label('模型回传（不含坐标）', M + 16, 212, 320, 20, { size: 11.5, color: C.rose, bold: true });
  b += label('{ value: "fibromyalgia",\n  quote: "diagnosed with fibromyalgia",\n  confidence: 0.95 }', M + 16, 236, 320, 64, { size: 11, color: C.body, lh: 132 });

  b += shape({ prst: 'triangle', x: M + 360, y: 246, w: 12, h: 18, rot: 90, fill: C.faint, line: null });
  b += label('本地', M + 378, 236, 50, 18, { size: 10, color: C.muted });
  b += label('groundField()', M + 378, 254, 130, 20, { size: 11.5, color: C.teal, bold: true });

  b += shape({ prst: 'roundRect', x: M + 512, y: 200, w: 640, h: 108, adj: 0.1, fill: 'F0FDFA', line: '99F6E4', lineW: 1 });
  b += label('落地（坐标由本地在 MiniDoc 中定位）', M + 528, 212, 600, 20, { size: 11.5, color: C.teal, bold: true });
  b += label('{ raw: "fibromyalgia",\n  evidence: [{ page: 1, bbox: [275,308,574,354], quote: "…" }], provenance: "model" }',
    M + 528, 236, 610, 64, { size: 11, color: C.body, lh: 132 });

  b += label('四道防幻觉闸门（grounding.ts）', M, 330, 600, 24, { size: 14, color: C.ink, bold: true });
  const gates = [
    { t: '① 无 quote → 直接拒收', d: '字段进 unresolved，不得进 fields。' },
    { t: '② quote 定位不到 → 判为幻觉', d: '拒绝入库，绝不伪造坐标。' },
    { t: '③ 三级降级匹配窗口', d: '整串 → 中间切片 → 后半段重试。' },
    { t: '④ 仍失败就放弃', d: '不会退回「用整块当证据」。' },
  ];
  gates.forEach((g, i) => {
    const bx = M + i * 292;
    b += shape({ prst: 'roundRect', x: bx, y: 362, w: 280, h: 86, adj: 0.1, fill: C.white, line: C.line, lineW: 1 });
    b += shape({ prst: 'rect', x: bx, y: 362, w: 4, h: 86, fill: [C.rose, C.rose, C.amber, C.green][i], line: null });
    b += label(g.t, bx + 16, 374, 254, 22, { size: 12, color: C.ink, bold: true });
    b += label(g.d, bx + 16, 400, 254, 42, { size: 10.5, color: C.muted, lh: 122 });
  });

  b += panel(M, 466, 560, 168, { tint: C.white, accent: C.amber });
  b += label('为什么需要「降级匹配窗口」', M + 20, 478, 500, 22, { size: 13, color: C.amber, bold: true });
  b += label(
    '原文里 DOI 因排版被拆成 http://dx.doi.org/10.1136/ acupmed-2015-010950（中间有空格），模型回传的是无空格版本——整串匹配必然失败。\n\n另外还有两类真实的定位失败：\n· PDF 跨行断词，MinerU 还原成 depres-\\nsion，模型给的是拼好的 depression\n· MinerU 内联标记 <sup>28</sup>，模型「逐字引用」时把标记去掉',
    M + 20, 506, 524, 120, { size: 10.5, color: C.body, lh: 130 }
  );

  b += panel(M + 592, 466, 560, 168, { tint: 'F8FAFC', accent: C.green });
  b += label('定位器的三级匹配（最终实现）', M + 612, 478, 500, 22, { size: 13, color: C.green, bold: true });
  b += label(
    '① 整串精确匹配\n② 去内联标签 + 去标点后近似匹配（提前 untag()）\n③ 去连字符 + 去标点后比对（要求 ≥8 字符，避免短串误命中）\n\n修完这两个定位缺陷，2015-01 的规划条目从「6 条因定位失败被丢弃」变成全部落地。',
    M + 612, 506, 524, 120, { size: 10.5, color: C.body, lh: 130 }
  );

  b += label('提示词里写死的硬约束：每条字段必须回传逐字 quote，不得改写/翻译/补全；材料里没有的信息不要猜；只依据所给材料作答，不得使用对该论文的既有记忆。',
    M, 646, 1130, 24, { size: 10.5, color: C.muted, italic: true, lh: 120 });
  return withFooter(b, 9);
});

/* --------------------------- 幻灯片 10：难题 C 评测对齐 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('难题 C｜评测与数据质量：当「判错」其实不是流水线的错', M, 160, 1000, 26, { size: 15, color: C.ink, bold: true });

  b += label('金标准自身的 5 类缺陷——先检测、再排除、全部记录，不改数据', M, 194, 900, 22, { size: 12.5, color: C.muted });
  const anom = [
    ['编码超出取值表（允许 1,2）', '99'],
    ['code 列写成了自由文本（疑似列错位）', '68'],
    ['值未在论文中出现（疑似错误金标准）', '46'],
    ['编码超出取值表（允许 1,2,3）', '40'],
    ['数值列写成了散文（疑似列错位）', '22'],
    ['年份非 4 位数字 / 其他', '31'],
  ];
  const maxA = 99;
  anom.forEach((r, i) => {
    const y = 228 + i * 30;
    const cw = (Number(r[1]) / maxA) * 330;
    b += label(r[0], M, y, 330, 18, { size: 10.5, color: C.body });
    b += shape({ prst: 'roundRect', x: M + 340, y: y + 3, w: Math.max(4, cw), h: 14, adj: 0.4, fill: C.rose, line: null });
    b += label(r[1], M + 340 + cw + 8, y, 60, 18, { size: 11, color: C.rose, bold: true });
  });
  b += label('全局 306 处（2015 年恰好 0 处，这也解释为什么 2015 的评测一直可信）',
    M, 410, 480, 20, { size: 10.5, color: C.muted, italic: true });

  b += panel(M + 560, 220, 592, 216, { tint: 'FFF7ED', border: 'FED7AA', accent: C.amber });
  b += label('取证式审计：金标准的值可能根本不在论文里', M + 580, 230, 556, 22, { size: 13, color: C.amber, bold: true });
  b += table({
    x: M + 580, y: 258, w: 552, colW: [120, 190, 242],
    header: ['文章', '金标准', '论文里的实际情况'],
    rowH: 36, headH: 26, headFill: C.amber, size: 10,
    rows: [
      ['2015-01', '42 weeks', [{ t: '全文没有 42 weeks；随访 10 周 / 6 个月 / 12 个月', size: 10 }]],
      ['2015-04', '7 weeks', [{ t: '论文写的是 13 weeks', size: 10 }]],
      ['2015-05', '（年份）', [{ t: 'DOI 是 2018、页脚 © 2018，按规则答 2018', size: 10 }]],
    ],
  });
  b += label('做法：全文检索该「数字+单位」组合，找不到才报告 → 记录并排除评分，评测输出单列「不参与评分」的字段。',
    M + 580, 380, 552, 46, { size: 10, color: C.body, lh: 126 });

  b += label('两条评分口径并行，避免「措辞差异」被误判成「抽错」', M, 450, 700, 24, { size: 14, color: C.ink, bold: true });
  b += card({
    x: M, y: 482, w: 366, h: 166, accent: C.indigo, title: '严格口径（可判定的）', bodySize: 11,
    lines: [
      '纯数值 / 编码 / 哨兵值走严格比较。',
      '准确率 =（命中 + 编码命中）/（命中 + 编码命中 + 错 + 漏）。',
      '「多」不计入分母，单列以示多抽。',
      '覆盖正文、设计、分析人群等所有确定性字段。',
    ],
  });
  b += card({
    x: M + 392, y: 482, w: 366, h: 166, accent: C.violet, title: '语义口径（自然语言字段）', bodySize: 11,
    lines: [
      'Sheet2 / Sheet3 的结局信息是无法标准化的自然语言，字符匹配不公平。',
      '改由 LLM 判定五档：完全一致 / 含义一致 / 包含正确信息 / 存在错误 / 完全不一致。',
      '权重 1 / 1 / 0.5 / 0 / 0；未判定单列；批量 8 组一次调用，结果按指纹缓存。',
    ],
  });
  b += card({
    x: M + 784, y: 482, w: 368, h: 166, accent: C.teal, title: '对齐口径（结局行配对）', bodySize: 11,
    lines: [
      '金标准是自然语言原样抄的行名，按下标硬对会每字段都判错。',
      '改按「名称 + 工具」相似度贪心配对；分词切开驼峰（PainVAS → pain + vas）。',
      '数值佐证会用到被评分的值本身，因此每次评测单独披露「靠数值配上的对数」。',
    ],
  });

  b += label('⚠ 披露纪律：任何会用答案本身影响判分的机制，都必须在报告里显式披露，否则准确率不可信。',
    M, 648, 1130, 22, { size: 11, color: C.rose, bold: true, lh: 120 });
  return withFooter(b, 10);
});

/* --------------------------- 幻灯片 11：准确率提升轨迹 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('提高准确率的纪律：每一步只改一处，改完实测一次；先问「症状」再定「修法」', M, 160, 1050, 25, { size: 15, color: C.ink, bold: true });

  b += label('Sheet3（结局 × 时点）严格口径：31.4% → 72.5%，13 轮迭代', M, 192, 900, 22, { size: 12.5, color: C.muted });

  const bars = [
    { label: '起点', value: 31.4, color: C.faint },
    { label: '② 表格不再受章节过滤', value: 42.2, color: C.amber },
    { label: '③ 变异值语义（SD vs CI）', value: 44.6, color: C.amber },
    { label: '④ 拆出 outcome-values SKILL', value: 52.5, color: C.sky },
    { label: '⑤ binary 块 = 组间效应量', value: 55.9, color: C.sky },
    { label: '⑥ 媒体保真（补充表不再丢）', value: 54.6, color: C.sky },
    { label: '⑦ 逐「结局 × 比较组」取数', value: 58.3, color: C.indigo },
    { label: '⑭ 结局枚举 + 分类编码', value: 72.5, color: C.teal },
  ];
  b += barChart({ x: M, y: 222, w: 840, h: 366, rows: bars, max: 80, unit: '%', labelW: 262, valueW: 70 });

  b += panel(M + 872, 222, 280, 366, { tint: C.ink });
  b += label('三个数字级的跃迁', M + 890, 236, 244, 22, { size: 13, color: C.teal, bold: true });
  const jumps = [
    ['+11.6', '材料窗口修对：measurement_range 0% → 40%', C.amber],
    ['+15.0', '数值层独立成 SKILL，长规则不再互相挤占', C.sky],
    ['+14.2', '结局枚举按论文自己的量表名 + 缩写匹配修校验误杀', C.green],
  ];
  jumps.forEach((j, i) => {
    const jy = 265 + i * 104;
    b += label(j[0], M + 890, jy, 120, 36, { size: 21, color: j[2], bold: true });
    b += label(j[1], M + 890, jy + 38, 246, 56, { size: 10.5, color: 'CBD5E1', lh: 124 });
    if (i < 2) b += hLine(M + 890, jy + 98, 244, '26374F', 1);
  });

  b += card({
    x: M, y: 588, w: 372, h: 80, accent: C.rose, titleSize: 11.5, bodySize: 9.5,
    title: '最容易被误诊的一类：校验器误杀',
    lines: ['2015-02 的 85 个漏（当年全部漏的 91%）源于一条校验把整条结局丢弃。'],
  });
  b += card({
    x: M + 390, y: 588, w: 372, h: 80, accent: C.amber, titleSize: 11.5, bodySize: 9.5,
    title: '最反直觉的一条：先查材料，再改提示词',
    lines: ['字段抽不出来时先问「这句话在材料里吗」——加了三版强制规则仍然全 NR。'],
  });
  b += card({
    x: M + 780, y: 588, w: 372, h: 80, accent: C.green, titleSize: 11.5, bodySize: 9.5,
    title: '最需要纪律的一条：覆盖必须可回退',
    lines: ['判据收紧后要能退回模型原答案 → 覆盖时把原答案存进 alternatives。'],
  });
  return withFooter(b, 11);
});

/* --------------------------- 幻灯片 12：关键因子表 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('关键干预与实测收益（2015 六篇，同一评测口径）', M, 160, 900, 25, { size: 15, color: C.ink, bold: true });
  b += table({
    x: M, y: 194, w: 1152, colW: [330, 250, 190, 190],
    header: ['症状（改前）', '根因', '修法', '效果'],
    rowH: 35, headH: 30, size: 9.5,
    rows: [
      ['期刊名/DOI/通讯邮箱全抽成 NR', 'MinerU 把首页页眉页脚放进 discarded_blocks', 'ingest 保留前 2 页页眉页脚为 metadata 章节', [{ t: '文章级 70.4 → 75.9%', color: C.green, bold: true }]],
      ['Sheet2 七个字段恒 0%', '字段在规范清单里，但没进提示词模板与 FIELD_MAP', '提示词加 Sheet2 段；FIELD_MAP 登记 7 个键', [{ t: 'Sheet2 45.0 → 47.5%', color: C.green, bold: true }]],
      ['结局层整层丢失（finish_reason=length）', '一次调用输出上百个带 quote 对象，撞输出上限', '结局改两阶段：先只列名称+工具，再逐个取值', [{ t: '不再截断', color: C.green, bold: true }]],
      ['40 次调用里 5 次 JSON 解析失败', '模型把多行 quote 粘进字符串（裸换行）', '只转义字符串内部控制字符 + 解析失败追加格式修正重试', [{ t: '解析失败 0', color: C.green, bold: true }]],
      ['missing_data_handling 9 条错 9 条', '规范清单抄漏取值表（5 个 vs 真实 13 个）', '按批注逐字补全；field_coverage 增加编码集审计', [{ t: '0/9 → 6/9', color: C.green, bold: true }]],
      ['measurement_range 15 组全 0%', '量表取值范围写在 methods，而结局 SKILL 材料只取 results+abstract', 'sections 改为 results + abstract + methods', [{ t: '0% → 40%', color: C.green, bold: true }]],
      ['两组之差（LSMD）39 个全漏', '提示词把 binary 块描述成「事件数/人数型」→ 模型对差值列视而不见', '改称「二分类 / 组间效应量」，要求填 differenceEstimate', [{ t: '0% → 91.7%', color: C.green, bold: true }]],
      ['比较组 2 复制了比较组 1 的值', '为省调用按「名称|工具」去重（多臂试验上是静默错误）', '逐「结局 × 比较组」行调用，并把干预 vs 对照写进提示词', [{ t: '数值类 71.5 → 81.2%', color: C.green, bold: true }]],
      ['ciLower/ciUpper 实为「变异值上下限」，随 varianceType 取单值或双边界', '按类型判定：单值只填 ciLower；ESTIMATE_OUTSIDE_CI 仅当 varianceType=2', [{ t: 'ci_lower 26.5 → 78.7%', color: C.green, bold: true }]],
      ['quality of life 结局被整条丢弃', '缩写 QoL 与全称用朴素子串匹配永远对不上；anchorBlock 是死变量', '缩写 ↔ 全称按词边界匹配 + 补上「锚点落在声明段落」兜底', [{ t: '2015-02 21.7 → 54.7%', color: C.green, bold: true }]],
    ],
  });
  b += label('说明：准确率口径为「（命中 + 编码命中）/（命中 + 编码命中 + 错 + 漏）」；「多」单列不计入分母。',
    M, 630, 1100, 20, { size: 10, color: C.muted, italic: true });
  return withFooter(b, 12);
});

/* --------------------------- 幻灯片 13：当前数据快照 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('2015 年六篇实测快照  ·  数据来源 build/eval/2015.json', M, 160, 900, 25, { size: 15, color: C.ink, bold: true });

  b += kpi({ x: M, y: 194, w: 276, h: 86, value: '6 / 6', caption: '篇文章全部成功 · 证据违规 0 处', color: C.green });
  b += kpi({ x: M + 292, y: 194, w: 276, h: 86, value: '0', caption: 'error 级 issue 之外的阻断错误（无截断、无 JSON 解析失败）', color: C.teal });
  b += kpi({ x: M + 584, y: 194, w: 276, h: 86, value: '2 640', caption: '抽取字段总数（549 / 250 / 287 / 816 / 381 / 425）', color: C.indigo });
  b += kpi({ x: M + 876, y: 194, w: 276, h: 86, value: '0', unit: '处', caption: '2015 年需要排除的金标准异常', color: C.violet });

  b += table({
    x: M, y: 300, w: 700, colW: [230, 110, 110, 90, 90],
    header: ['工作表', '准确率', '命中', '错', '漏'],
    rowH: 38, headH: 32, size: 11,
    rows: [
      ['Sheet1（文章级 + 比较组）', [{ t: '69.0%', bold: true, color: C.indigo }], '470 / 681', '211', '0'],
      ['Sheet2（结局分类）', [{ t: '75.0%', bold: true, color: C.violet }], '30 / 40', '0', '0'],
      ['Sheet3（结局 × 时点）', [{ t: '72.5%', bold: true, color: C.teal }], '477 / 658', '106', '52'],
      ['合计（三表聚合）', [{ t: '67.9%', bold: true, color: C.ink }], '936 / 1379', '317', '52'],
    ],
  });

  b += panel(M + 720, 300, 432, 182, { tint: C.white, accent: C.rose });
  b += label('仍然最大的缺口：多抽', M + 740, 312, 380, 22, { size: 13, color: C.rose, bold: true });
  b += label(
    'Sheet3「多」655 个：结局行粒度是（比较组 × 结局指标），我们的行数常多于金标准（金标准 22 行 / 我们 35 行）。\n\n多出来的进 extra，不计入分母，但需人工裁。\n\n漏 52 个里，一部分属金标准侧「部分选行」——金标准那句 Secondary outcomes included… 是 549 字符长句，同一句里收哪些不收哪些没有文本依据，属标注取舍差异。',
    M + 740, 340, 392, 136, { size: 10, color: C.body, lh: 126 }
  );

  b += panel(M, 500, 1152, 152, { tint: C.panel, accent: C.indigo });
  b += label('语义判定口径（Sheet2 / Sheet3 自然语言字段）', M + 20, 512, 600, 22, { size: 13, color: C.ink, bold: true });
  const verdicts = [
    ['完全一致', '21', C.green],
    ['含义一致', '27', C.teal],
    ['包含正确信息', '8', C.sky],
    ['存在错误', '8', C.amber],
    ['完全不一致', '21', C.rose],
  ];
  const total = 85;
  verdicts.forEach((v, i) => {
    const bx = M + 20 + i * 226;
    b += label(v[0], bx, 540, 200, 20, { size: 10.5, color: C.muted });
    b += label(v[1], bx, 560, 90, 30, { size: 20, color: v[2], bold: true });
    b += shape({ prst: 'roundRect', x: bx, y: 596, w: Math.max(4, (Number(v[1]) / total) * 200), h: 10, adj: 0.4, fill: v[2], line: null });
  });
  b += label('加权重 1 / 1 / 0.5 / 0 / 0 → 加权得分 61.2%；完全一致 + 含义一致 = 56.5%',
    M + 20, 618, 700, 22, { size: 11, color: C.body, bold: true });
  b += label('「含义一致」里要分无害与有害：补全缩写/去序号是无害的；把概念粒度放大（quality of life → health-related quality of life）或缩小（膀胱平衡 → 残余尿量）与「存在错误」是同一类毛病——抽取停在了比金标准更细或更粗的层级。',
    M + 740, 540, 392, 100, { size: 10, color: C.body, lh: 128 });
  return withFooter(b, 13);
});

/* --------------------------- 幻灯片 14：路线图 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('路线图：P1–P4', M, 158, 600, 25, { size: 15, color: C.ink, bold: true });
  b += label('每一阶段都有可执行的验收命令，不靠「感觉变好了」', M, 186, 800, 20, { size: 11, color: C.muted });

  const phases = [
    {
      id: 'P1', t: '把账对齐', sub: '评测可信化', c: C.sky, w: 268,
      goal: '解决「后 10 年不能评分」，把 224 篇变成可信的评测集',
      items: [
        '修复 Crossref HTTP 400（mailto / 请求参数）',
        '对 2016–2025 逐年跑 gold:anomalies，产出「不参与评分」清单',
        '交叉核对金标准列错位（68 + 22 处），给出源表修订建议',
        '按年报告：可评分字段数 / 被排除数 / 口径一致性',
      ],
      accept: '11 个年份均有可复现的评测报告；被排除项逐条可追溯到证据',
    },
    {
      id: 'P2', t: '把洞补上', sub: '架构缺口', c: C.indigo, w: 268,
      goal: '补齐编排器与回归防护，让改动不再互相打架',
      items: [
        '编排器：依赖拓扑排序 → 合并为 ExtractionDocument',
        '章节路由补强：未命中记 warning（当前是关键词启发式）',
        '旋转页标记：对 rotate 页显式标记供人工复核',
        '跨页表格真拼接（2015 未出现，后十年需验证）',
      ],
      accept: '编排器可一键全量运行；章节未命中 0 静默；新增 SKILL 不需改 llm_run',
    },
    {
      id: 'P3', t: '把量做上去', sub: '全量抽取 + 人机回环', c: C.teal, w: 268,
      goal: '从「6 篇跑通」到「224 篇可用」，并把人工修正率变成反馈信号',
      items: [
        '后十年全量抽取，逐年报告三层准确率',
        '结局行粒度规约：把「多」655 降下来（多抽才是人工负担）',
        '人工修正率闭环：覆盖层的 override 样本回流成提示词规约',
        '前端接入全量产物，支持按「未复核 / 已修改 / 有疑点」筛选',
      ],
      accept: '224 篇全部有抽取结果；人工修正率有量化基线并逐轮下降',
    },
    {
      id: 'P4', t: '把话说清楚', sub: '可信度与交付', c: C.violet, w: 268,
      goal: '让准确率这个数字经得起追问',
      items: [
        '消融实验：逐项关掉确定性模块，量化各自贡献',
        '成本 / 耗时报告：按层报告 token 与费用',
        '冻结评测集与回归基线，接 CI（pnpm check + 评测门槛）',
        '交付：桌面端 exe + 报告 + 数据字典',
      ],
      accept: '每个设计选择都有对应的消融数；新改动有自动回归门槛',
    },
  ];

  phases.forEach((p, i) => {
    const bx = M + i * 289;
    b += shape({ prst: 'roundRect', x: bx, y: 218, w: 268, h: 356, adj: 0.05, fill: C.white, line: C.line, lineW: 1 });
    b += shape({ prst: 'rect', x: bx, y: 218, w: 268, h: 44, fill: p.c, line: null });
    b += label(p.id, bx + 16, 228, 50, 28, { size: 19, color: C.white, bold: true });
    b += label(p.t, bx + 62, 224, 190, 22, { size: 14, color: C.white, bold: true });
    b += label(p.sub, bx + 62, 244, 190, 16, { size: 9.5, color: 'E2E8F0' });
    b += label(p.goal, bx + 16, 274, 236, 56, { size: 10, color: C.ink, lh: 124 });
    b += hLine(bx + 16, 336, 236, C.line, 1);
    p.items.forEach((it, j) => {
      b += shape({ prst: 'ellipse', x: bx + 16, y: 356 + j * 40 + 5, w: 5, h: 5, fill: p.c, line: null });
      b += label(it, bx + 30, 350 + j * 40, 224, 40, { size: 9, color: C.body, lh: 114 });
    });
    b += shape({ prst: 'roundRect', x: bx + 16, y: 512, w: 236, h: 54, adj: 0.14, fill: C.panel, line: null });
    b += label('验收', bx + 26, 518, 40, 16, { size: 9, color: p.c, bold: true });
    b += label(p.accept, bx + 26, 534, 216, 32, { size: 8, color: C.body, lh: 114 });
  });

  b += panel(M, 592, 1152, 62, { tint: C.ink });
  b += label('已完成的里程碑', M + 20, 602, 200, 20, { size: 12, color: C.teal, bold: true });
  b += label('M1 金标准三层归一化 ✅   M2 MinerU 本地 GPU 跑通 ✅   M3 契约层 + 7 个 SKILL ✅   M4 2015 端到端 + 评测闭环 ✅   M5 前端 PDF 框选证据 ✅   M6 Electron 单文件 exe ✅',
    M + 160, 602, 980, 46, { size: 10.5, color: 'CBD5E1', lh: 130 });
  return withFooter(b, 14);
});

/* --------------------------- 幻灯片 15：风险与开放问题 --------------------------- */
addSlide(() => {
  let b = '';
  b += label('风险、开放问题与明确不做的事', M, 152, 900, 25, { size: 15, color: C.ink, bold: true });

  b += table({
    x: M, y: 196, w: 1152, colW: [330, 300, 522],
    header: ['风险 / 开放问题', '现状', '对策'],
    rowH: 42, headH: 32, size: 10.5,    rows: [
      ['Crossref 全部返回 HTTP 400', '6 篇均降级为「未校验」，不影响其它字段', 'P1 修复 resolveAndVerify 的请求参数 / mailto；修复前把「未校验」显式标注，不静默'],
      ['金标准列错位（68 + 22 处）', '已检测并排除评分，不改数据', '向源表维护者提交逐单元格修订建议；键名沿用金标准以便评测对齐'],
      ['结局行粒度偏粗（多 655）', '多抽进 extra，不计入分母，但需人工裁', 'P3 定粒度规约；并行报告金标准结局行覆盖率（当前 17/22 = 77%）'],
      ['Sheet3 的 n 口径不一致', '2015-01 疗程结束取 PP 行、随访取 ITT 表头，两个数原文都有', '统一取 ITT 表头并记录；属金标准侧口径问题，已披露'],
      ['评价集只有 6 篇可信', '后 10 年未评分（异常未排除）', 'P1 完成后再谈全局准确率，避免拿被污染的分母下结论'],
      ['提示词规则持续变长', '已拆出 outcome-values 缓解', 'P4 做消融，删掉无收益的规则'],
    ],
  });

  b += panel(M, 496, 560, 158, { tint: 'F0FDF4', border: 'BBF7D0', accent: C.green });
  b += label('明确不做的事（判断标准已写下）', M + 20, 508, 500, 22, { size: 13, color: C.green, bold: true });
  b += label(
    '· 不自动「修正」金标准——真实存在跨年 ID 笔误这类问题，自动改写会掩盖问题且不可审计\n· 不过度拟合标注风格——金标准自身写法不统一，只能对齐其中的主导形式\n· 不反推「金标准为什么只挑第 ③ 个域」——没有文本依据的取舍差异，属过度拟合\n· 不用「整块当证据」兜底——宁可留空，也不把块内无关内容算作证据',
    M + 20, 534, 524, 110, { size: 9.5, color: C.body, lh: 130 }
  );

  b += panel(M + 592, 496, 560, 158, { tint: 'FEF2F2', border: 'FECDD3', accent: C.rose });
  b += label('两条硬判据（遇到分歧时回到这里）', M + 612, 508, 500, 22, { size: 13, color: C.rose, bold: true });
  b += label(
    '① 这个值能否在原文里找到？——找不到就不收，也不猜。\n\n② 金标准自身是否自相矛盾 / 口径不一致？——若是，先记录并排除评分，不在数据上做发明。',
    M + 612, 534, 524, 110, { size: 10, color: C.body, lh: 132 }
  );
  return withFooter(b, 15);
});

/* --------------------------- 幻灯片 16：结尾 --------------------------- */
addSlide(() => {
  let s = shape({ prst: 'rect', x: 0, y: 0, w: W, h: H, fill: C.ink, line: null });
  s += shape({ prst: 'rect', x: 0, y: 0, w: W, h: 6, fill: C.indigo, line: null });
  s += label('小结', M, 90, 400, 24, { size: 13, color: C.teal, bold: true });
  s += label('三条可复用的结论', M, 112, 900, 48, { size: 30, color: C.white, bold: true });

  const pts = [
    { n: '01', t: '证据前置不是「多存一个字段」，而是设计约束', d: '一旦要求每个字段都能定位到原文，模型就不能给坐标、不能改写 quote、不能猜——整条链路的行为被这一条不变量决定了。' },
    { n: '02', t: '把「能判定的」从模型手里拿走，是准确率最便宜的增长点', d: '编码映射、坐标定位、DOI 形态、数值↔编码自洽、随访补全全部本地化。coding 能做的，不要用钱和不确定性去换。' },
    { n: '03', t: '抽不出来先怀疑材料和评测，最后才怀疑提示词', d: 'measurement_range 的 0% 和 2015-02 的 85 个漏，根因都不在提示词；「存在错误」里也有一半是金标准列错位、值根本不在论文里。' },
  ];
  pts.forEach((p, i) => {
    const y = 190 + i * 122;
    s += shape({ prst: 'roundRect', x: M, y, w: 1152, h: 106, adj: 0.08, fill: '1B2942', line: '26374F', lineW: 1 });
    s += label(p.n, M + 24, y + 18, 70, 44, { size: 28, color: C.indigo, bold: true });
    s += label(p.t, M + 110, y + 16, 640, 30, { size: 15, color: C.white, bold: true });
    s += label(p.d, M + 110, y + 48, 1010, 50, { size: 11, color: 'CBD5E1', lh: 130 });
  });

  s += shape({ prst: 'rect', x: M, y: 566, w: 1152, h: 1, fill: '26374F', line: null });
  s += label('下一步', M, 584, 200, 22, { size: 13, color: C.teal, bold: true });
  s += label('P1 把账对齐（修复 Crossref + 后十年异常排除）→ P2 补编排器与回归防护 → P3 全量抽取与人机回环 → P4 消融实验与交付',
    M, 610, 1000, 24, { size: 12, color: 'CBD5E1' });
  s += label('谢谢，请提问', M, 648, 400, 26, { size: 16, color: C.white, bold: true });
  return s;
});

/* ================================================================== *
 * 6. OOXML 包骨架
 * ================================================================== */
/* 注意：本文件的幻灯片内容位于上方「5. 幻灯片装配」段落，此处只负责打包。 */

TOTAL_PAGES = slides.length;
const N_SLIDES = slides.length;
const slideMasterXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld name="Master"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="100000" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`;

const slideLayoutXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="100000" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sldLayout>`;

const themeXml = () => {
  const accent = ['4F46E5', '0D9488', '0284C7', 'D97706', '7C3AED', 'E11D48'];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ArticleAgent">
<a:themeElements>
<a:clrScheme name="ArticleAgent"><a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1E293B"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
${accent.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')}
<a:hlink><a:srgbClr val="4F46E5"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="ArticleAgent"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="ArticleAgent">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="15875" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
};

/*
 * 幻灯片根节点。注意：内容形状由 nextId() 从 1 开始编号，而 PowerPoint 在某些视图下
 * 会额外插入一个"幻灯片背景"形状（id=1）——曾因此在每张幻灯片上产生重复 id。
 * 因此根组形状固定占用 100000，把 1..999 让给内容形状。
 */
const slideXml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="100000" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

function buildPackage() {
  const files = [];
  const add = (name, content) => files.push({ name, data: Buffer.from(content, 'utf8') });

  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/sldMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/sldLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${Array.from({ length: N_SLIDES }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}
</Types>`);

  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  add('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>文章抽取 Agent — 组会汇报</dc:title>
<dc:creator>article-agent</dc:creator>
<cp:lastModifiedBy>article-agent</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-15T00:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-15T00:00:00Z</dcterms:modified>
</cp:coreProperties>`);

  add('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>article-agent</Application><Slides>${N_SLIDES}</Slides><Company></Company>
</Properties>`);

  add('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${Array.from({ length: N_SLIDES }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="${px(W)}" cy="${px(H)}"/><p:notesSz cx="${px(685)}" cy="${px(914)}"/>
</p:presentation>`);

  add('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="sldMaster1.xml"/>
${Array.from({ length: N_SLIDES }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n')}
</Relationships>`);

  add('ppt/sldMaster1.xml', slideMasterXml());
  add('ppt/sldLayout1.xml', slideLayoutXml());
  add('ppt/theme1.xml', themeXml());

  add('ppt/_rels/sldMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="sldLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme1.xml"/>
</Relationships>`);

  add('ppt/_rels/sldLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="sldMaster1.xml"/>
</Relationships>`);

  const slideBodies = slides.map((build) => {
    SID = 0;
    return build();
  });

  slideBodies.forEach((body, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slideXml(body));
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../sldLayout1.xml"/>
</Relationships>`);
  });

  return files;
}

/* ================================================================== *
 * 7. 写盘 + 结构自检
 * ================================================================== */

const files = buildPackage();
const buf = zip(files);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, buf);

// 自检：ZIP 结构可回读 + XML 标签平衡 + 形状 id 唯一
const cs = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const count = buf.readUInt16LE(cs + 10);
let cp = buf.readUInt32LE(cs + 16);
const entries = [];
for (let i = 0; i < count; i++) {
  const nameLen = buf.readUInt16LE(cp + 28);
  const extraLen = buf.readUInt16LE(cp + 30);
  const commentLen = buf.readUInt16LE(cp + 32);
  entries.push({
    name: buf.toString('utf8', cp + 46, cp + 46 + nameLen),
    method: buf.readUInt16LE(cp + 10),
    csize: buf.readUInt32LE(cp + 20),
    localOff: buf.readUInt32LE(cp + 42),
  });
  cp += 46 + nameLen + extraLen + commentLen;
}

const bad = [];
for (const ent of entries) {
  const src = files.find((f) => f.name === ent.name);
  if (!src) { bad.push(`${ent.name} (not in source list)`); continue; }
  const sig = buf.readUInt32LE(ent.localOff);
  if (sig !== 0x04034b50) { bad.push(`${ent.name} (bad local sig)`); continue; }
  const lnameLen = buf.readUInt16LE(ent.localOff + 26);
  const lextraLen = buf.readUInt16LE(ent.localOff + 28);
  const start = ent.localOff + 30 + lnameLen + lextraLen;
  const raw = buf.subarray(start, start + ent.csize);
  const data = ent.method === 0 ? raw : inflateRawSync(raw);
  if (!data.equals(src.data)) bad.push(`${ent.name} (content mismatch)`);
}
if (entries.length !== files.length) bad.push(`entry count ${entries.length} != ${files.length}`);

const xmlParts = entries.filter((n) => /\.(xml|rels)$/.test(n.name));
const xmlBad = [];
const idBad = [];
for (const n of xmlParts) {
  const s = files.find((f) => f.name === n.name).data.toString('utf8');
  const opens = (s.match(/<[a-zA-Z]/g) ?? []).length;
  const closes = (s.match(/<\//g) ?? []).length + (s.match(/\/>/g) ?? []).length;
  if (opens !== closes) xmlBad.push(`${n.name} (${opens} open / ${closes} close)`);
  if (/\/slides\/slide\d+\.xml$/.test(n.name)) {
    const ids = [...s.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    if (new Set(ids).size !== ids.length) idBad.push(`${n.name} (duplicate shape id)`);
  }
}

const xmlBytes = files.filter((f) => /\.(xml|rels)$/.test(f.name)).reduce((a, f) => a + f.data.length, 0);

console.log(`生成 ${OUT_FILE}`);
console.log(`  ZIP 条目        ${entries.length} 个`);
console.log(`  幻灯片          ${N_SLIDES} 张`);
console.log(`  文件大小        ${(buf.length / 1024).toFixed(1)} KB（XML 原始 ${(xmlBytes / 1024).toFixed(0)} KB）`);
console.log(`  回读一致性      ${bad.length === 0 ? '全部通过' : '失败 → ' + bad.slice(0, 5).join('; ')}`);
console.log(`  XML 标签平衡    ${xmlBad.length === 0 ? '全部通过' : '可疑 → ' + xmlBad.slice(0, 3).join('; ')}`);
console.log(`  形状 id 唯一    ${idBad.length === 0 ? '全部通过' : '重复 → ' + idBad.slice(0, 3).join('; ')}`);
if (bad.length || xmlBad.length || idBad.length) process.exitCode = 1;
