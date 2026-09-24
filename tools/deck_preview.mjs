// tools/deck_preview.mjs — 从生成的 PPTX 反解出 HTML 预览（用于人工检查版面）
//
// 用法：node tools/make_deck.mjs && node tools/deck_preview.mjs
// 产物：build/deck/preview.html
//
// 为什么需要它：本机没有 PowerPoint / LibreOffice，无法把 PPTX 渲染成图片来肉眼检查。
// 这个预览器直接读 pptx 里每张幻灯片 XML 的 <a:off>/<a:ext>/字号/颜色，
// 用绝对定位的 DIV 复刻同一版面——因此「字有没有出框、有没有压到下一页元素」在浏览器里可见。
// 它不是像素级渲染器（不做自动换行的精确度量），但足以审版面。

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECK_DIR = join(ROOT, 'build', 'deck');
const EMU = 9525;
const W = 1280, H = 720;

/* ---------- 读 ZIP（与 tools/lib/xlsx.mjs 同思路：只解 deflate） ---------- */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const localOff = buf.readUInt32LE(p + 42);
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + csize);
    out[name] = method === 0 ? raw : inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 从一个 <p:sp> 片段抽出几何与文字 */
function parseShape(sp) {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(sp);
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(sp);
  if (!off || !ext) return null;
  const rot = /<a:xfrm rot="(-?\d+)"/.exec(sp);
  const prst = /<a:prstGeom prst="([^"]+)"/.exec(sp);
  const fill = /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(sp);
  const ln = /<a:ln w="\d+"><a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(sp);
  const adj = /<a:gd name="adj" fmla="val (\d+)"\/>/.exec(sp);

  const paras = [];
  for (const pm of sp.matchAll(/<a:p>(.*?)<\/a:p>/g)) {
    const runs = [];
    for (const rm of pm[1].matchAll(/<a:r>(.*?)<\/a:r>/g)) {
      const t = /<a:t>(.*?)<\/a:t>/s.exec(rm[1]);
      const sz = /sz="(\d+)"/.exec(rm[1]);
      const col = /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rm[1]);
      const b = /<a:rPr[^>]*\bb="1"/.exec(rm[1]);
      const i = /<a:rPr[^>]*\bi="1"/.exec(rm[1]);
      if (!t) continue;
      runs.push({
        t: t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
        size: sz ? Number(sz[1]) / 100 : 12,
        color: col ? col[1] : '1E293B',
        bold: !!b,
        italic: !!i,
      });
    }
    const align = /<a:pPr algn="(l|ctr|r|just)"/.exec(pm[1]);
    const lh = /<a:spcPct val="(\d+)"/.exec(pm[1]);
    const aft = /<a:spcAft><a:spcPts val="(\d+)"/.exec(pm[1]);
    paras.push({
      runs,
      align: align ? { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[align[1]] : 'left',
      // spcPct 是"百分之一的百分数"（100000 = 100% = 1.0），别当成百分比数字
      lh: lh ? Number(lh[1]) / 100000 : 1,
      spaceAfter: aft ? Number(aft[1]) / 100 : 0,
    });
  }
  return {
    x: Number(off[1]) / EMU, y: Number(off[2]) / EMU,
    w: Number(ext[1]) / EMU, h: Number(ext[2]) / EMU,
    rot: rot ? Number(rot[1]) / 60000 : 0,
    prst: prst ? prst[1] : 'rect',
    fill: fill ? fill[1] : null,
    line: ln ? ln[1] : null,
    adj: adj ? Number(adj[1]) / 100000 : null,
    paras,
  };
}

function renderShape(s) {
  if (!s) return '';
  const st = [
    `left:${s.x}px`, `top:${s.y}px`, `width:${s.w}px`, `height:${s.h}px`,
  ];
  if (s.fill) st.push(`background:#${s.fill}`);
  if (s.line) st.push(`border:1px solid #${s.line}`);
  if (s.prst === 'roundRect') st.push(`border-radius:${Math.min(s.h / 2, (s.h * (s.adj ?? 0.16667)) + (s.w < 40 ? 2 : 6))}px`);
  if (s.prst === 'ellipse') st.push('border-radius:50%');
  if (s.rot) {
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    st.push(`transform:rotate(${s.rot}deg)`, `transform-origin:${cx - s.x}px ${cy - s.y}px`);
  }
  if (s.prst === 'triangle') {
    st.push('background:transparent', 'width:0', 'height:0', 'border-style:solid',
      `border-width:${s.h / 2}px 0 ${s.h / 2}px ${s.w}px`,
      `border-color:transparent transparent transparent #${s.fill ?? '94A3B8'}`);
  }
  const inner = s.paras
    .map((p) => {
      const runs = p.runs.length
        ? p.runs.map((r) => `<span style="font-size:${r.size}pt;color:#${r.color};${r.bold ? 'font-weight:700;' : ''}${r.italic ? 'font-style:italic;' : ''}">${esc(r.t)}</span>`).join('')
        : '&nbsp;';
      return `<div style="text-align:${p.align};line-height:${p.lh};${p.spaceAfter ? `margin-bottom:${p.spaceAfter}px;` : ''}">${runs}</div>`;
    })
    .join('');
  return `<div style="position:absolute;${st.join(';')};overflow:hidden;box-sizing:border-box;">${inner}</div>`;
}

/* ---------- 主流程 ---------- */
if (!existsSync(DECK_DIR)) mkdirSync(DECK_DIR, { recursive: true });
const pptx = readdirSync(DECK_DIR).filter((f) => f.endsWith('.pptx'))[0];
if (!pptx) {
  console.error('找不到 pptx，请先运行 node tools/make_deck.mjs');
  process.exit(1);
}
const files = unzip(readFileSync(join(DECK_DIR, pptx)));
const slideNames = Object.keys(files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

const slidesHtml = slideNames.map((n, i) => {
  const xml = files[n].toString('utf8');
  // 只取 spTree 内部的内容形状（跳过根 grpSpPr）
  const body = xml.slice(xml.indexOf('<p:grpSpPr/>') + '<p:grpSpPr/>'.length, xml.indexOf('</p:spTree>'));
  const shapes = [];
  for (const m of body.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const s = parseShape(m[0]);
    if (s) shapes.push(s);
  }
  // 溢出检查：文字行总高 vs 形状高（粗估）
  const warnings = [];
  for (const s of shapes) {
    if (!s.paras.length) continue;
    let need = 0;
    for (const p of s.paras) {
      const maxSize = Math.max(...p.runs.map((r) => r.size), 8);
      const chars = p.runs.reduce((a, r) => a + r.t.length, 0);
      // 中文按 1em、西文按 0.55em 估宽
      const cjk = p.runs.reduce((a, r) => a + (r.t.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length, 0);
      const ltr = chars - cjk;
      const lineW = cjk * maxSize * 1.34 + ltr * maxSize * 0.74;
      const lines = Math.max(1, Math.ceil(lineW / Math.max(20, s.w)));
      need += lines * maxSize * 1.34 * p.lh + p.spaceAfter;
    }
    if (need > s.h + 3) {
      warnings.push(`${Math.round(s.x)},${Math.round(s.y)} 需≈${Math.round(need)}px / 框高${Math.round(s.h)}px`);
    }
  }
  return { i, shapes, warnings };
});

const totalWarn = slidesHtml.reduce((a, s) => a + s.warnings.length, 0);
const body = slidesHtml
  .map(
    (s) => `
<section>
  <div class="cap">第 ${s.i + 1} 张 · ${s.shapes.length} 个形状${s.warnings.length ? ` · <b class="w">${s.warnings.length} 处疑似出框</b>` : ''}</div>
  ${s.warnings.map((x) => `<div class="warn">⚠ ${esc(x)}</div>`).join('')}
  <div class="slide">${s.shapes.map(renderShape).join('')}</div>
</section>`
  )
  .join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>PPTX 预览 — ${esc(pptx)}</title>
<style>
  :root { --line:#E2E8F0; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:#EEF2F7; font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif; }
  h1 { font-size:19px; color:#0F172A; margin:0 0 6px; }
  .meta { font-size:12.5px; color:#475569; margin-bottom:22px; }
  section { margin-bottom:30px; }
  .cap { font-size:12.5px; color:#475569; margin-bottom:6px; font-weight:600; }
  .slide { position:relative; width:${W}px; height:${H}px; background:#fff;
           box-shadow:0 2px 14px rgba(15,23,42,.14); border-radius:3px; overflow:hidden; }
  .warn { font-size:11.5px; color:#B91C1C; background:#FEF2F2; border-left:3px solid #E11D48;
          padding:3px 8px; margin-bottom:4px; border-radius:3px; }
  .w { color:#B91C1C; }
</style></head><body>
<h1>PPTX 预览：${esc(pptx)}</h1>
<div class="meta">${slideNames.length} 张幻灯片 · 由 PPTX XML 反解复刻版面 · 共 ${totalWarn} 处疑似文字出框${
  totalWarn ? '（列在每页上方）' : '（未检出）'
}</div>
${body}
</body></html>`;

writeFileSync(join(DECK_DIR, 'preview.html'), html, 'utf8');
console.log(`生成 ${join(DECK_DIR, 'preview.html')}`);
console.log(`  幻灯片    ${slideNames.length} 张`);
console.log(`  疑似出框  ${totalWarn} 处` + (totalWarn ? '（见预览页内提示）' : ''));
