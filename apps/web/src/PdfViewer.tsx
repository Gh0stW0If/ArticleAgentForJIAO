/**
 * PDF 连续滚动视图 + 块叠加 + 框选
 *
 * ===== 为什么改成"连续滚动" =====
 * 原先一次只渲染一页、靠 ◀ ▶ 翻页。实际核对证据时要来回跳（"这个值在第 6 页那张表里，
 * 但方法学在第 3 页"），翻页把上下文切断了。现在所有页竖直堆叠，滚动即可连续阅读。
 *
 * 但**不能把每页都画成 canvas**：一篇 10+ 页的论文一次性渲染会卡住主线程、占大量显存。
 * 因此采用「占位 + 惰性渲染」：
 *   · 每个页先放一个**尺寸已知的占位 div**（高度由 MiniDoc 的页面尺寸算出来，滚动条不会跳）；
 *   · 用 IntersectionObserver 只给"看得见的页 + 上下各一页"创建 canvas，离开视口就销毁。
 *
 * ===== 坐标关键点（决定框选能否对准）=====
 * MiniDoc 的 bbox 位于 canonical（未旋转）框架，而 pdf.js 的 viewport 是显示方向，
 * 两者必须经 `bboxToScreen()` / `screenToBbox()` 换算——实测 rotate:90 的页不换算会整体偏移 199pt。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  bboxToScreen, screenToBbox, rectFromPoints, overlapRatio,
  type Bbox, type PageGeom, type Rect,
} from './geometry.ts';
import { T, R, SH, tint } from './theme.ts';
import type { MiniDoc, MiniDocBlock, MiniDocPageMeta } from './types.ts';

export type SelectMode = 'browse' | 'mark';

export interface Hit {
  block: MiniDocBlock;
  ratio: number;
}

export interface Selection {
  page: number;
  /** canonical bbox（可直接作为 Evidence.bbox 存盘） */
  bbox: [number, number, number, number];
  hits: Hit[];
  /** 由命中块拼出的原文（作为 Evidence.quote） */
  quote: string;
  mode: SelectMode;
}

export interface Highlight { page: number; bbox: Bbox; label: string; color?: string; human?: boolean }

interface ViewerProps {
  pdf: PDFDocumentProxy;
  doc: MiniDoc;
  scale: number;
  highlights?: Highlight[];
  showBlocks: boolean;
  mode: SelectMode;
  /**
   * 界面缩放倍数（字体档位带来的 CSS `zoom`）。
   * 只影响**鼠标坐标换算**——见 PageCanvas.relPos：Chromium 的 gBCR 返回的是
   * 缩放后坐标，不除会导致框选证据整体错位。默认 1。
   */
  uiZoom?: number;
  /** 滚到这一页（字段定位时用）；变化即触发滚动 */
  focusPage?: number | undefined;
  focusToken?: number;
  onSelect(sel: Selection | null): void;
  onPageChange(page: number): void;
}

/** 把命中块的文本拼成 quote（保留阅读顺序，去重）。 */
function composeQuote(hits: Hit[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const h of [...hits].sort((a, b) => a.block.index - b.block.index)) {
    const t = h.block.text.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/** 页在屏幕上的显示尺寸（canonical 尺寸按 rotate 交换宽高，再乘缩放）。 */
function displaySize(meta: MiniDocPageMeta, scale: number): { width: number; height: number } {
  const swapped = meta.rotate === 90 || meta.rotate === 270;
  const w = swapped ? meta.height : meta.width;
  const h = swapped ? meta.width : meta.height;
  return { width: Math.floor(w * scale), height: Math.floor(h * scale) };
}

/** 单页：占位 + 惰性 canvas + 叠加层 + 框选。 */
function PageCanvas({
  pdf, meta, blocks, scale, visible, highlights, showBlocks, mode, uiZoom, onSelect, onVisible,
}: {
  pdf: PDFDocumentProxy;
  meta: MiniDocPageMeta;
  blocks: MiniDocBlock[];
  scale: number;
  visible: boolean;
  highlights: Highlight[];
  showBlocks: boolean;
  mode: SelectMode;
  /** 界面缩放（字体档位带来的 CSS zoom）。见 relPos 的说明。 */
  uiZoom: number;
  onSelect(sel: Selection | null): void;
  onVisible(page: number): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const size = displaySize(meta, scale);

  const geom: PageGeom = { page: meta.page, width: meta.width, height: meta.height, rotate: meta.rotate, scale };

  /* 只在"可见"时绘制；离开视口把画布清掉，避免十几个 canvas 同时占内存 */
  useEffect(() => {
    if (!visible) { setDrawn(false); return; }
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      try {
        const p = await pdf.getPage(meta.page);
        const vp = p.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        task = p.render({ canvasContext: ctx, viewport: vp });
        await (task as unknown as { promise: Promise<void> }).promise;
        if (!cancelled) setDrawn(true);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, meta.page, scale, visible]);

  /**
   * 鼠标位置 → **页面局部 CSS px**。
   *
   * ⚠️ 必须除以 `uiZoom`：界面「字体大小」是用 CSS `zoom` 实现的，
   * 而 Chromium 的 `getBoundingClientRect()` 返回的是**已经缩放过的**坐标，
   * clientX 也在同一套（缩放后）坐标里。两者相减得到的是"缩放后的局部偏移"，
   * 不除就会比真实页面 px 大 zoom 倍 —— 框选反算出的证据框会整体错位。
   *
   * 缩放倍数由 App 算好传进来，这里不读 localStorage，组件保持纯粹。
   */
  const relPos = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left) / uiZoom, y: (e.clientY - rect.top) / uiZoom };
  }, [uiZoom]);

  /** 用「起点 + 终点」收尾（终点来自鼠标事件，可能落在页外）。 */
  const finishAt = useCallback((start: Rect, end: { x: number; y: number }) => {
    const rect = rectFromPoints(start.x, start.y, end.x, end.y);
    if (rect.width < 4 || rect.height < 4) { setDrag(null); onSelect(null); return; }
    const bbox = screenToBbox(rect, geom) as [number, number, number, number];
    const hits: Hit[] = blocks
      .filter((b) => b.bbox)
      .map((b) => ({ block: b, ratio: overlapRatio(rect, bboxToScreen(b.bbox as Bbox, geom)) }))
      .filter((x) => x.ratio > 0.15)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 8);
    onSelect({ page: meta.page, bbox, hits, quote: composeQuote(hits), mode });
    setDrag(null);
  }, [geom, blocks, meta.page, mode, onSelect]);

  /*
   * 结束框选：**mouseup 才算数，且监听挂在 window 上**。
   *
   * 不用 `onMouseLeave` 收尾，实测它有两个坑：
   *   1. 指针**还在页内**时就会误触发（拖拽矩形每次重渲染都会干扰 React 的 leave 判定）——
   *      日志实测：mouseleave 在终点 (647,522)、而页框是 19..804 / 209..1255，明明在里面；
   *   2. 它只能拿"最后一次 mousemove 存下的 state"收尾，追不上真实位置，
   *      框出来比手画的短一截（zoom 1.2 下稳定停在 8 步里的第 7 步）。
   *
   * 挂 window 还顺带覆盖了"在页面外松开"的情况：终点坐标照样取自事件本身。
   */
  useEffect(() => {
    if (!drag) return;
    const onUp = (ev: MouseEvent) => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      finishAt(drag, { x: (ev.clientX - r.left) / uiZoom, y: (ev.clientY - r.top) / uiZoom });
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [drag, uiZoom, finishAt]);

  return (
    <div
      ref={wrapRef}
      data-page={meta.page}
      /* 惰性渲染的可观测状态：供 e2e 断言"远页没有真的画出来" */
      data-drawn={drawn ? '1' : '0'}
      style={{
        position: 'relative', width: size.width, height: size.height, margin: '0 auto 16px',
        background: '#fff', borderRadius: R.page, boxShadow: SH.page, overflow: 'hidden',
        userSelect: 'none', cursor: mode === 'mark' ? 'crosshair' : 'default',
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (mode === 'mark') e.preventDefault();
        const p = relPos(e);
        setDrag({ x: p.x, y: p.y, width: 0, height: 0 });
      }}
      onMouseMove={(e) => {
        if (!drag) return;
        const p = relPos(e);
        setDrag(rectFromPoints(drag.x, drag.y, p.x, p.y));
      }}
      onMouseUp={() => { /* 由 window 监听收尾，避免在页外松开时丢失 */ }}
      onMouseLeave={() => { /* 收尾统一交给 window 的 mouseup，见上面的 useEffect */ }}
      onMouseEnter={() => onVisible(meta.page)}
    >
      {!drawn && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: T.faint, fontSize: 12 }}>
          第 {meta.page} 页{visible ? ' 渲染中…' : '（滚动到这里自动渲染）'}
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'block', opacity: drawn ? 1 : 0 }} />

      {showBlocks && drawn && blocks.filter((b) => b.bbox).map((b) => {
        const r = bboxToScreen(b.bbox as Bbox, geom);
        return (
          <div
            key={b.index}
            title={`#${b.index} ${b.type} — ${b.text.slice(0, 140)}`}
            style={{
              position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height,
              border: `1px solid ${tint(T.blue, '55')}`, background: tint(T.blue, '0f'),
              borderRadius: 2, pointerEvents: 'none', fontSize: 9, color: tint(T.blue, 'cc'), overflow: 'hidden',
            }}
          >
            {r.width > 60 && r.height > 14 ? `${b.index}` : ''}
          </div>
        );
      })}

      {drawn && highlights.map((h, i) => {
        const r = bboxToScreen(h.bbox, geom);
        const c = h.color ?? (h.human ? T.indigo : T.amberBright);
        return (
          <div
            key={`hl-${i}`}
            title={h.label}
            style={{
              position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height,
              border: `2px solid ${c}`, background: tint(c, '22'), borderRadius: 3, pointerEvents: 'none',
            }}
          />
        );
      })}

      {drag && (
        <div
          style={{
            position: 'absolute', left: drag.x, top: drag.y, width: drag.width, height: drag.height,
            border: `1.5px dashed ${mode === 'mark' ? T.indigo : T.cyan}`,
            background: mode === 'mark' ? tint(T.indigo, '1f') : tint(T.cyan, '1c'),
            borderRadius: 3, pointerEvents: 'none',
          }}
        />
      )}

      <div style={{
        position: 'absolute', right: 8, top: 8, fontSize: 10, color: T.faint, pointerEvents: 'none',
        background: tint('#ffffff', 'd9'), padding: '1px 6px', borderRadius: R.pill,
      }}>
        p{meta.page}{meta.rotate ? ` · rotate ${meta.rotate}°` : ''}
        {mode === 'mark' && <span style={{ color: T.indigo }}> · 标注中</span>}
      </div>
      {error && (
        <div style={{ position: 'absolute', inset: '40% 0 auto 0', textAlign: 'center', color: T.red }}>
          渲染失败：{error}
        </div>
      )}
    </div>
  );
}

export function PdfViewer({
  pdf, doc, scale, highlights = [], showBlocks, mode, focusPage, focusToken = 0, uiZoom = 1,
  onSelect, onPageChange,
}: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 每页是否处于"渲染窗口"（可见页 ± 1） */
  const [windowPages, setWindowPages] = useState<Set<number>>(new Set([1]));

  const blocksByPage = useMemo(() => {
    const m = new Map<number, MiniDocBlock[]>();
    for (const b of doc.blocks) {
      if (!b.bbox) continue;
      const list = m.get(b.page);
      if (list) list.push(b); else m.set(b.page, [b]);
    }
    return m;
  }, [doc]);

  /* 记录"当前页"：取离视口中心最近的一页 */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const center = el.scrollTop + el.clientHeight / 2;
    let best = 1;
    let bestDist = Infinity;
    for (const meta of doc.pages) {
      const node = el.querySelector(`[data-page="${meta.page}"]`) as HTMLElement | null;
      if (!node) continue;
      const mid = node.offsetTop + node.offsetHeight / 2;
      const d = Math.abs(mid - center);
      if (d < bestDist) { bestDist = d; best = meta.page; }
    }
    onPageChange(best);
  }, [doc.pages, onPageChange]);

  /* 可见页 ± 1 才渲染：用 IntersectionObserver 维护窗口 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      setWindowPages((prev) => {
        const next = new Set(prev);
        for (const e of entries) {
          const p = Number((e.target as HTMLElement).dataset.page);
          if (!Number.isFinite(p)) continue;
          if (e.isIntersecting) { next.add(p); next.add(p - 1); next.add(p + 1); } else next.delete(p);
        }
        return next;
      });
    }, { root: el, rootMargin: '300px 0px' });
    for (const meta of doc.pages) {
      const node = el.querySelector(`[data-page="${meta.page}"]`);
      if (node) obs.observe(node);
    }
    return () => obs.disconnect();
  }, [doc.pages]);

  /* 字段定位：滚到目标页（`focusToken` 保证同一页重复点击也会重新滚） */
  useEffect(() => {
    if (!focusPage) return;
    const el = scrollRef.current;
    const node = el?.querySelector(`[data-page="${focusPage}"]`) as HTMLElement | null;
    if (el && node) el.scrollTo({ top: Math.max(0, node.offsetTop - 12), behavior: 'smooth' });
  }, [focusPage, focusToken]);

  return (
    <div
      ref={scrollRef}
      data-testid="pdf-scroll"
      onScroll={onScroll}
      style={{ height: '100%', overflow: 'auto', padding: '16px 16px 48px', background: T.canvas }}
    >
      {doc.pages.map((meta) => (
        <PageCanvas
          key={meta.page}
          pdf={pdf}
          meta={meta}
          blocks={blocksByPage.get(meta.page) ?? []}
          scale={scale}
          visible={windowPages.has(meta.page)}
          highlights={highlights.filter((h) => h.page === meta.page)}
          showBlocks={showBlocks}
          mode={mode}
          uiZoom={uiZoom}
          onSelect={onSelect}
          onVisible={() => { /* 进入页面：并入渲染窗口 */ setWindowPages((p) => new Set(p).add(meta.page)); }}
        />
      ))}
    </div>
  );
}
