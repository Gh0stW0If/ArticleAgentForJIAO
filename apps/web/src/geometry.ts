/**
 * @aa/web — 坐标变换
 *
 * 前端要做的三件事都依赖这里的换算：
 *   1. 把 PDF 页渲染到 canvas（pdf.js viewport）
 *   2. 把 MiniDoc 的 bbox（canonical 未旋转坐标）叠加到画布上
 *   3. 把用户的框选矩形（屏幕像素）反算回 PDF 坐标，用于产出证据
 *
 * ===== 坐标约定（与 @aa/ingest 一致）=====
 *   MiniDoc bbox = [x0, y0, x1, y1]，原点 **页面左上角**，单位 pt，
 *   位于 MinerU 的 **canonical（未旋转）页面框架**。
 *
 * ===== 为什么不能直接用 pdf.js 的 viewport ====
 *   实测 `-2015-01` 第 6 页 `page.rotate = 90`、`page_size = [793, 595]`，
 *   而该页所有 bbox 仍落在 [595, 793] 的**未旋转**框架内。
 *   也就是说：**bbox 与 viewport 处于不同坐标系**，必须显式换算，
 *   否则叠加会整体偏移（实测偏差可达 199pt）。
 *
 * 换算策略（不依赖 pdf.js 的 rotation 参数，避免与其内部实现耦合）：
 *   把 bbox 看作"已随页面旋转"的坐标——即把 canonical 框架的
 *   (x, y) 按 rotate 映射到显示坐标系。这样叠加结果与页面视觉一致。
 */

export type Bbox = readonly [number, number, number, number];

export interface PageGeom {
  /** 1-based 页码 */
  page: number;
  /** canonical 框架尺寸（未旋转），来自 MiniDoc.pages */
  width: number;
  height: number;
  /** 0 / 90 / 180 / 270 */
  rotate: number;
  /** 渲染缩放（pt → px） */
  scale: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * canonical 框架尺寸（未旋转）。
 *
 * ⚠️ MiniDoc.pages 的 width/height 来自 MinerU 的 `page_size`，那是**显示尺寸**
 * （rotate:90 的页实测为 [793,595]）；而 bbox 位于**未旋转**的 canonical 框架（[595,793]）。
 * 因此这里必须按 rotate 反旋转回去，而不能简单取 min/max
 * （min/max 在非 A4 或自定义页面尺寸上会算错）。
 */
export const canonicalSize = (g: PageGeom): { width: number; height: number } => {
  const swapped = g.rotate === 90 || g.rotate === 270;
  return swapped
    ? { width: g.height, height: g.width }
    : { width: g.width, height: g.height };
};

/** 渲染后的画布尺寸（px）。 */
export const displaySize = (g: PageGeom): { width: number; height: number } => {
  const c = canonicalSize(g);
  const swapped = g.rotate === 90 || g.rotate === 270;
  const w = swapped ? c.height : c.width;
  const h = swapped ? c.width : c.height;
  return { width: w * g.scale, height: h * g.scale };
};

/**
 * canonical bbox → 屏幕矩形（px）。
 *
 * 旋转映射（以页面中心为基准）：
 *   0°   : (x, y)
 *   90°  : (H - y1, x0)   —— 顺时针旋转 90° 后，原 y 轴变为水平方向
 *   180° : (W - x1, H - y1)
 *   270° : (y0, W - x1)
 * 其中 W/H 为 canonical 宽高。
 */
export function bboxToScreen(bbox: Bbox, g: PageGeom): Rect {
  const { width: W, height: H } = canonicalSize(g);
  const [x0, y0, x1, y1] = bbox;
  let sx0: number, sy0: number, sx1: number, sy1: number;

  switch (g.rotate) {
    case 90:
      sx0 = H - y1; sy0 = x0; sx1 = H - y0; sy1 = x1;
      break;
    case 180:
      sx0 = W - x1; sy0 = H - y1; sx1 = W - x0; sy1 = H - y0;
      break;
    case 270:
      sx0 = y0; sy0 = W - x1; sx1 = y1; sy1 = W - x0;
      break;
    default:
      sx0 = x0; sy0 = y0; sx1 = x1; sy1 = y1;
  }

  return {
    x: sx0 * g.scale,
    y: sy0 * g.scale,
    width: (sx1 - sx0) * g.scale,
    height: (sy1 - sy0) * g.scale,
  };
}

/** 屏幕矩形（px）→ canonical bbox（pt）。bboxToScreen 的逆运算。 */
export function screenToBbox(rect: Rect, g: PageGeom): Bbox {
  const { width: W, height: H } = canonicalSize(g);
  const s = g.scale;
  const a0 = rect.x / s, b0 = rect.y / s;
  const a1 = (rect.x + rect.width) / s, b1 = (rect.y + rect.height) / s;

  let x0: number, y0: number, x1: number, y1: number;
  switch (g.rotate) {
    case 90:  x0 = b0; y0 = H - a1; x1 = b1; y1 = H - a0; break;
    case 180: x0 = W - a1; y0 = H - b1; x1 = W - a0; y1 = H - b0; break;
    case 270: x0 = W - b1; y0 = a0; x1 = W - b0; y1 = a1; break;
    default:  x0 = a0; y0 = b0; x1 = a1; y1 = b1;
  }
  return [
    Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1),
  ];
}

/* ------------------------------ 矩形工具 ------------------------------ */

export const rectFromPoints = (x0: number, y0: number, x1: number, y1: number): Rect => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  width: Math.abs(x1 - x0),
  height: Math.abs(y1 - y0),
});

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const rectArea = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

/** 交集面积占比较小者的比例（用于判断"框住了哪个块"）。 */
export function overlapRatio(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const denom = Math.min(rectArea(a), rectArea(b));
  return denom > 0 ? inter / denom : 0;
}
