/**
 * 生成应用图标 `build/icon.png`（512×512）——不引任何依赖，自己画 + 自己编码 PNG。
 *
 * 为什么自己写：图标只用到 3 种图元（圆角矩形、圆环、胶囊），
 * 为此装 sharp/canvas 这类带原生二进制的包不划算（还要处理各平台预编译）。
 * 这里用**有符号距离场（SDF）+ 1px 抗锯齿**逐像素合成，再按 PNG 规范编码。
 *
 * 图形语义：墨色圆角方块（与界面主色一致）+ 琥珀色"文档"+ 放大镜
 * —— 对应"从 PDF 里定位证据"这件事。
 *
 * 用法：node tools/make_icon.mjs [输出路径]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';

const SIZE = 512;
const OUT = process.argv[2] ?? 'build/icon.png';

const INK = [27, 33, 43];
const AMBER = [212, 144, 63];
const AMBER_LIGHT = [250, 236, 216];

/* ------------------------------ SDF 图元 ------------------------------ */

const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
};

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/** 点到线段的距离 - 半径（胶囊/粗线）。 */
const sdSegment = (px, py, x1, y1, x2, y2, r) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - r;
};

/** 覆盖率：距离为负（内部）→ 1，跨过边缘 1px 内做线性过渡。 */
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d));

const mix = (dst, src, a) => {
  dst[0] = dst[0] * (1 - a) + src[0] * a;
  dst[1] = dst[1] * (1 - a) + src[1] * a;
  dst[2] = dst[2] * (1 - a) + src[2] * a;
};

/* ------------------------------ 逐像素合成 ------------------------------ */

const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const c = [0, 0, 0];
    let alpha = 0;

    // 1) 墨色圆角方块（整体底色，半径 108）
    const plate = cov(sdRoundRect(cx, cy, 256, 256, 224, 224, 108));
    if (plate > 0) { mix(c, INK, 1); alpha = plate; }

    // 2) 琥珀色"文档"（圆角矩形，略微倾斜感由圆角与位置体现）
    const doc = cov(sdRoundRect(cx, cy, 232, 244, 92, 122, 26));
    if (doc > 0) { mix(c, AMBER, doc); alpha = Math.max(alpha, doc); }

    // 3) 文档上的三条"文字线"（浅琥珀，末条更短）
    //    ⚠️ 每项 5 个值 [x1, y1, x2, y2, 半径]——少写一个会让半径变成 undefined，
    //    距离算出来是 NaN，`if (l > 0)` 恒假 → 线条静默消失（踩过）
    const lines = [
      [166, 202, 292, 202, 15],
      [166, 248, 292, 248, 15],
      [166, 294, 244, 294, 15],
    ];
    for (const [x1, y1, x2, y2, r] of lines) {
      const l = cov(sdSegment(cx, cy, x1, y1, x2, y2, r));
      if (l > 0) { mix(c, AMBER_LIGHT, l * 0.85); alpha = Math.max(alpha, l); }
    }

    // 4) 放大镜：白色圆环 + 手柄（叠在文档右下角，形成"在文档上找证据"的意象）
    const ring = Math.abs(sdCircle(cx, cy, 316, 336, 74)) - 16;
    const ringCov = cov(ring);
    if (ringCov > 0) { mix(c, AMBER_LIGHT, ringCov); alpha = Math.max(alpha, ringCov); }
    const handle = cov(sdSegment(cx, cy, 368, 388, 414, 434, 18));
    if (handle > 0) { mix(c, AMBER_LIGHT, handle); alpha = Math.max(alpha, handle); }

    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(c[0]);
    px[i + 1] = Math.round(c[1]);
    px[i + 2] = Math.round(c[2]);
    px[i + 3] = Math.round(alpha * 255);
  }
}

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
// 10..12 = compression/filter/interlace = 0

// 每行前加一个 filter 字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);
