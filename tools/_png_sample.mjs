/**
 * 极简 PNG 像素采样（临时诊断工具）。
 *
 * 用途：把设计参考图里的**真实像素色值**取出来，避免"凭感觉猜配色"。
 * 只支持 8bit RGB/RGBA、非隔行——截图必然是这几种之一。
 * 解码 = zlib.inflate + 逐行反滤波（PNG 规范里的 5 种 filter）。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
      if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持 colorType=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

const [, , file, ...pairs] = process.argv;
const img = decodePng(readFileSync(file));
const scale = Number(process.env.SCALE ?? '1');
const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

console.log(`图像 ${img.width}x${img.height}（channels=${img.channels}），采样缩放 ×${scale}`);
for (const pair of pairs) {
  const [label, coord] = pair.split('=');
  const [px, py] = coord.split(',').map(Number);

  /* 区域模式：x0,y0,x1,y1:w,h → 取该矩形里出现最多的几种颜色（比单点猜坐标可靠得多） */
  if (coord.includes(':')) {
    const [rect, mins] = coord.split(':');
    const [x0, y0, x1, y1] = rect.split(',').map(Number);
    const [minX, minY, maxX, maxY] = [x0, y0, x1, y1].map((v) => Math.round(v * scale));
    const tally = new Map();
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const i = (y * img.width + x) * img.channels;
        const key = hex(img.data[i], img.data[i + 1], img.data[i + 2]);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(mins) || 6);
    const total = (maxX - minX) * (maxY - minY);
    console.log(`  ${label.padEnd(18)} 区域[${minX},${minY}→${maxX},${maxY}] ` +
      top.map(([c, n]) => `${c}(${Math.round((n / total) * 100)}%)`).join(' '));
    continue;
  }

  const [pxv, pyv] = [Math.round(px * scale), Math.round(py * scale)];
  const i = (pyv * img.width + pxv) * img.channels;
  console.log(`  ${label.padEnd(18)} (${String(pxv).padStart(4)},${String(pyv).padStart(4)})  ${hex(img.data[i], img.data[i + 1], img.data[i + 2])}`);
}

