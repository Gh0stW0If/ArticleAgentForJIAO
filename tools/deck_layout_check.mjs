// tools/deck_layout_check.mjs — 用无头 Chromium 真测量 PPTX 预览的版面溢出
//
// 用法：node tools/make_deck.mjs && node tools/deck_preview.mjs && node tools/deck_layout_check.mjs
//
// 为什么这样做：本机没有 PowerPoint / LibreOffice，无法把 PPTX 渲染成图片。
// deck_preview.mjs 把 PPTX 的每个形状按真实几何/字号复刻成绝对定位的 DIV，
// 这里再用真实浏览器测量「每个文字盒的 scrollHeight 是否超过它的高度」——
// 这是浏览器按真实字形度量换行的结果，比任何启发式公式可靠。
// 注意：预览用的字号/宽度与 PPT 一致，因此溢出结论可迁移；行高是近似值。

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW = join(ROOT, 'build', 'deck', 'preview.html');
if (!existsSync(PREVIEW)) {
  console.error('找不到 build/deck/preview.html，请先运行 node tools/deck_preview.mjs');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(pathToFileURL(PREVIEW).href, { waitUntil: 'load' });

const report = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('section').forEach((sec) => {
    const cap = sec.querySelector('.cap')?.textContent?.trim() ?? '';
    const slide = sec.querySelector('.slide');
    const over = [];
    slide.querySelectorAll(':scope > div').forEach((d) => {
      const cs = getComputedStyle(d);
      if (cs.overflow !== 'hidden' || d.children.length === 0) return;
      const sh = d.scrollHeight, ch = d.clientHeight;
      const sw = d.scrollWidth, cw = d.clientWidth;
      // 阈值 6px：浏览器给单行内联内容的 scrollHeight 会比 clientHeight 多出几个像素
      // 的行框余量，不构成真实溢出（真实溢出通常是一整行，≥15px）。
      if (sh > ch + 6 || sw > cw + 2) {
        const txt = (d.textContent ?? '').replace(/\s+/g, ' ').slice(0, 46);
        over.push({
          left: Math.round(parseFloat(cs.left)),
          top: Math.round(parseFloat(cs.top)),
          box: `${Math.round(d.clientWidth)}x${ch}`,
          need: `${sw}x${sh}`,
          txt,
        });
      }
    });
    out.push({ cap, over });
  });
  return out;
});

await browser.close();

let total = 0;
for (const s of report) {
  if (!s.over.length) {
    console.log(`${s.cap}  ✓`);
    continue;
  }
  total += s.over.length;
  console.log(`${s.cap}  ✗ ${s.over.length} 处溢出`);
  for (const o of s.over) {
    console.log(`    @(${o.left},${o.top}) 框 ${o.box} → 内容 ${o.need}  「${o.txt}」`);
  }
}
console.log(`\n合计溢出形状：${total}`);
process.exitCode = total ? 1 : 0;
