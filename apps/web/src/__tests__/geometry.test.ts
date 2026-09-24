import { describe, it, expect } from 'vitest';
import {
  bboxToScreen, screenToBbox, canonicalSize, displaySize,
  rectFromPoints, overlapRatio, rectsIntersect,
  type PageGeom,
} from '../geometry.ts';

/** 实测数据：-2015-01。第 1 页竖版、第 6 页 rotate:90（page_size=[793,595]）。 */
const portrait: PageGeom = { page: 1, width: 595, height: 793, rotate: 0, scale: 1 };
const landscape: PageGeom = { page: 6, width: 793, height: 595, rotate: 90, scale: 1 };

describe('geometry — canonical 尺寸', () => {
  it('竖版页：canonical 即页面尺寸', () => {
    expect(canonicalSize(portrait)).toEqual({ width: 595, height: 793 });
  });

  it('rotate:90 页：canonical 为未旋转框架（bbox 所在的坐标系）', () => {
    // 实测：page_size=[793,595] 但 bbox 落在 [595,793] 内
    // canonical 由 page_size 反旋转得到：width←height(595)、height←width(793)
    expect(canonicalSize(landscape)).toEqual({ width: 595, height: 793 });
  });

  it('显示尺寸按缩放放大', () => {
    expect(displaySize({ ...portrait, scale: 2 })).toEqual({ width: 1190, height: 1586 });
  });

  it('rotate:90 的显示尺寸是高宽互换后的', () => {
    // canonical 595×793 → 显示 793×595（横向）
    expect(displaySize(landscape)).toEqual({ width: 793, height: 595 });
  });
});

describe('geometry — bbox ↔ 屏幕 往返一致', () => {
  const bbox = [100, 200, 300, 400] as const;

  it('竖版页往返无损', () => {
    const r = bboxToScreen(bbox, portrait);
    expect(r).toEqual({ x: 100, y: 200, width: 200, height: 200 });
    expect(screenToBbox(r, portrait)).toEqual([100, 200, 300, 400]);
  });

  it('rotate:90 往返无损', () => {
    const r = bboxToScreen(bbox, landscape);
    const back = screenToBbox(r, landscape);
    // 允许浮点误差
    back.forEach((v, i) => expect(v).toBeCloseTo(bbox[i]!, 6));
  });

  it('rotate:180 与 270 往返无损', () => {
    for (const rotate of [180, 270]) {
      const g: PageGeom = { ...portrait, rotate };
      const r = bboxToScreen(bbox, g);
      const back = screenToBbox(r, g);
      back.forEach((v, i) => expect(v).toBeCloseTo(bbox[i]!, 6));
    }
  });

  it('缩放参与换算', () => {
    const g: PageGeom = { ...portrait, scale: 1.5 };
    const r = bboxToScreen(bbox, g);
    expect(r.x).toBeCloseTo(150, 6);
    const back = screenToBbox(r, g);
    back.forEach((v, i) => expect(v).toBeCloseTo(bbox[i]!, 6));
  });

  it('rotate:90 下 canonical bbox 会被映射进横向画布内（不越界）', () => {
    // 这是"框选能否对准"的核心：canonical x 最大 595、y 最大 793，
    // 映射后必须落在显示尺寸 793×595 内
    for (const b of [[0, 0, 595, 793], [500, 700, 595, 793], [0, 0, 10, 10]] as const) {
      const r = bboxToScreen(b, landscape);
      expect(r.x).toBeGreaterThanOrEqual(-0.01);
      expect(r.y).toBeGreaterThanOrEqual(-0.01);
      expect(r.x + r.width).toBeLessThanOrEqual(793 + 0.01);
      expect(r.y + r.height).toBeLessThanOrEqual(595 + 0.01);
    }
  });
});

describe('geometry — 矩形工具', () => {
  it('任意两点构造规整矩形', () => {
    expect(rectFromPoints(300, 400, 100, 200)).toEqual({ x: 100, y: 200, width: 200, height: 200 });
  });

  it('相交判定', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
  });

  it('overlapRatio 用较小者的面积作分母', () => {
    const small = { x: 0, y: 0, width: 10, height: 10 };
    const big = { x: 0, y: 0, width: 100, height: 100 };
    // 小矩形被完全包含 → 比例 1
    expect(overlapRatio(big, small)).toBeCloseTo(1, 6);
    expect(overlapRatio(small, big)).toBeCloseTo(1, 6);
  });

  it('overlapRatio 对不相交返回 0', () => {
    expect(overlapRatio({ x: 0, y: 0, width: 5, height: 5 }, { x: 50, y: 50, width: 5, height: 5 })).toBe(0);
  });
});
