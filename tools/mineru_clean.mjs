// tools/mineru_clean.mjs — MinerU 输出的规范化后处理（2015 实测驱动）
//
// 处理三类已定位的问题：
//
//  1) 重复表格伪影
//     PDF 第4页 = "Table 1 Descriptive analysis..."（表体完整），第5页 = "Table 1 Continued"。
//     MinerU 把第 5 页又检测成一个表格块，却只框到页眉 → body 为空。
//     判据：body 近空 + 与上一表格块 page_idx 相邻 + 上一块已有 body。
//
//  2) caption 打散 / 缺失
//     MinerU 的 OCR caption 可能是 "Ta b l e 2 Eva l <sub>u</sub> ati o n"（字距被逐字切开）。
//     实测 PDF 文本层是干净的 → caption 改为从 PDF 文本层按位置重建。
//     ⚠ 关键教训：第一版只按"距离最近"匹配，结果把【图片】的 caption 替换给了【表格】，
//       4 个全错。必须同时满足：(a) 类型一致（Table/Figure/eTable）；(b) 相似度确实很低；
//       (c) 候选行在表格上方合理范围内。
//
//  3) 页眉/页脚/页码噪声（约占 24%）
//
// 输出：build/mineru/<year>/_clean/<stem>.json + _clean_report.json
// Datas/ 只读。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs', {
  paths: [join(process.cwd(), 'tools', 'nodepdf')],
});
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const STANDARD_FONTS = pathToFileURL(join(process.cwd(), 'tools', 'nodepdf', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/').href;

const ROOT = resolve(process.cwd());
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const YEAR = argOf('--year') ?? '2015';
const MINERU_OUT = join(ROOT, 'build', 'mineru', YEAR);
const ART_DIR = join(ROOT, 'Datas', 'articles', YEAR);
const CLEAN_DIR = join(MINERU_OUT, '_clean');

const NOISE = new Set(['header', 'footer', 'page_number', 'page_footnote', 'aside_text']);

/* ---------------------- PDF 文本层：按位置重建行 ---------------------- */

async function extractPdfLines(path) {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  const pages = [];
  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim());
    const byY = new Map();
    for (const it of items) {
      const y = Math.round(it.transform[5]);
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], w: it.width ?? 0, s: it.str, h: it.height ?? 9 });
    }
    const lines = [];
    for (const [y, arr] of byY) {
      const sorted = arr.sort((a, b) => a.x - b.x);
      let text = '';
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        text += a.s;
        const b = sorted[i + 1];
        if (!b) continue;
        const gap = b.x - (a.x + a.w);
        const ref = Math.max(a.h, b.h, 8);
        // 字距被切碎的字母 gap 通常为负；只有明显正间距才是词间空格
        if (gap > 0.3 * ref) text += ' ';
      }
      lines.push({
        y,
        top: vp.height - y,
        text: text.replace(/\s+/g, ' ').trim(),
      });
    }
    // 保留原始 item，供旋转 caption 重建使用
    const rawItems = items.map((it) => ({
      x: +(it.transform[4]).toFixed(2),
      y: +(it.transform[5]).toFixed(2),
      w: +(it.width ?? 0).toFixed(2),
      s: it.str,
    }));
    pages.push({ page: pno, height: vp.height, rotate: page.rotate ?? 0, lines: lines.sort((a, b) => a.top - b.top), items: rawItems });
  }
  await task.destroy();
  return pages;
}

/* --------------------------- caption 比对与重建 --------------------------- */

/** caption 类型标签：table / figure / other。 */
function capKind(s) {
  const t = String(s ?? '');
  if (/^\s*e?Table\b/i.test(t) || /^\s*Ta\s+b\s+l\s+e\b/i.test(t)) return 'table';
  if (/^\s*(Figure|Fig)\b/i.test(t) || /^\s*F\s+i\s+g\b/i.test(t)) return 'figure';
  return 'other';
}

/**
 * caption 预处理：把被字距切碎的 "Ta b l e" 还原成 "Table"，并去掉上下标标签。
 * 必须在【提取编号】之前做——否则 `Ta b l e 2` 提不出编号 2，
 * 后续"按编号重建"的逻辑会被直接跳过（这是曾经真实发生的 bug）。
 */
function normalizeCaption(s) {
  return String(s ?? '')
    .replace(/<\/?su[bp]>/g, '')
    .replace(/\bT\s*a\s*b\s*l\s*e\b/gi, 'Table')
    .replace(/\bF\s*i\s*g\b/gi, 'Fig')
    .replace(/\\\*/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}

/** caption 编号（Table 3 → 3，eTable 1 → 1）。 */
function capNum(s) {
  const m = /(?:e?Table|Figure|Fig)\s*\.?\s*(\d+)/i.exec(normalizeCaption(s));
  return m ? Number(m[1]) : null;
}

/**
 * 字符级 n-gram 相似度。
 * 必须用字符级而非词级：PDF 文本层常出现词粘连（"Fig. 2.Participantflow chart"），
 * 词级会把这种正确 caption 判成低相似度，从而触发错误的"修复"。
 */
function charSim(a, b) {
  const norm = (s) => String(s ?? '')
    .replace(/<\/?su[bp]>/g, '')
    .replace(/\\\*/g, '*')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const grams = (s) => { const o = new Set(); for (let i = 0; i + 2 <= s.length; i++) o.add(s.slice(i, i + 2)); return o; };
  const GA = grams(A), GB = grams(B);
  let inter = 0;
  for (const g of GA) if (GB.has(g)) inter++;
  return (2 * inter) / (GA.size + GB.size);
}

/**
 * 收集某表格附近的同类型 caption 候选。
 *
 * 实测（tools/diag_caption_candidates.mjs）：
 *   - MinerU 的 page_idx = PDF 页码 - 1（0-based）；
 *   - 同一 PDF 页内可能有多张表，因此"最近的上方 caption"会配错；
 *   - caption 也可能落在下一页顶部（Δtop<0）。
 *   → 先按【编号相同】过滤，再按距离择优。
 */
function collectCandidates(pdfPages, pageIdx, bbox, kind) {
  const pg = pdfPages[pageIdx];
  if (!pg) return [];
  const top0 = bbox?.[1] ?? 0;
  const out = [];
  for (const [delta, p] of [[0, pg], [-1, pdfPages[pageIdx - 1]], [1, pdfPages[pageIdx + 1]]]) {
    if (!p) continue;
    const samePage = delta === 0;
    for (const ln of p.lines) {
      if (capKind(ln.text) !== kind) continue;
      if (ln.text.length < 6) continue;
      const dTop = samePage ? ln.top - top0 : (delta < 0 ? 1000 : 2000);
      out.push({
        page: p.page,
        text: ln.text,
        num: capNum(ln.text),
        samePage,
        dTop,
        dist: Math.abs(dTop),
      });
    }
  }
  return out;
}

/** 从候选中择优：编号必须一致（若已知编号），再取位置最近。 */
function pickCaption(cands, wantNum) {
  let pool = cands;
  if (wantNum !== null && wantNum !== undefined) {
    const same = cands.filter((c) => c.num === wantNum);
    if (same.length) pool = same;
    else return null;   // 有编号却找不到同编号候选 → 宁可不改
  }
  if (!pool.length) return null;
  // 同页优先（更可靠），再按距离
  pool = [...pool].sort((a, b) => (Number(b.samePage) - Number(a.samePage)) || (a.dist - b.dist));
  return pool[0];
}

/** caption 是否"像标题"（而不是表头行/段落）。 */
function looksLikeCaption(s) {
  const t = String(s ?? '').trim();
  if (t.length < 10) return false;
  if (/^e?Table\s*\.?\s*\d+\s*$/i.test(t)) return false;          // 光秃秃的 "Table 1"
  if (/\d\s*[|%]\s*\d/.test(t)) return false;                     // 像数据行
  if ((t.match(/\s/g) ?? []).length / t.length > 0.5) return false; // 空格过多 = 碎片堆
  return true;
}

/** caption 中的单字母碎片数（字距/旋转打散的判据）。 */
const fragmentCount = (s) => (String(s ?? '').match(/(?<![\p{L}\p{N}])\p{L}(?![\p{L}\p{N}])/gu) ?? []).length;

/**
 * 旋转表格的 caption 重建。
 *
 * 实测（-2015-01 第 5、6 页）：这类表格的 caption 是【旋转文本】，在 PDF 文本层里
 * 被拆成两个片段且阅读顺序相反——x≈125 竖带按 y 降序 = "Evaluation of outcome measures"
 * + "Table 2"，即 "Table N" 落在竖带末尾。MinerU 对这种块的 caption 会打散成
 * "Ta b l e 2 Eva l <sub>u</sub> ati o n"。
 */
function rebuildRotatedCaption(pdfPages, pageIdx, wantNum) {
  const pg = pdfPages[pageIdx];
  if (!pg || wantNum === null) return null;
  // 按 x 聚类成竖带（容差 3pt；曾用 round(x/4)*4 导致 124.7 与 125 被分到两条带）
  const bands = [];
  for (const it of [...pg.items].sort((a, b) => a.x - b.x)) {
    let b = bands.find((x) => Math.abs(x.x - it.x) <= 3);
    if (!b) { b = { x: it.x, items: [] }; bands.push(b); }
    b.items.push(it);
  }
  for (const b of bands) {
    const seq = [...b.items].sort((p, q) => q.y - p.y).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();
    const m = /^(.*?)\s*(e?Table\s*\.?\s*(\d+))\s*$/is.exec(seq);
    if (!m) continue;
    if (Number(m[3]) !== wantNum) continue;
    const head = m[1].trim();
    if (!head || head.length > 160) continue;
    if (!looksLikeCaption(head)) continue;
    return `${m[2].trim()} ${head}`.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/* ------------------------------ 主流程 ------------------------------ */

function findMineruDirs() {
  const out = [];
  if (!existsSync(MINERU_OUT)) return out;
  for (const d of readdirSync(MINERU_OUT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === '_clean') continue;
    for (const s of readdirSync(join(MINERU_OUT, d.name), { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const p = join(MINERU_OUT, d.name, s.name);
      if (readdirSync(p).some((f) => f.endsWith('_content_list.json'))) out.push({ stem: d.name, dir: p });
    }
  }
  return out;
}

const SIM_THRESHOLD = 0.85;   // 相似度低于此值才认为 MinerU 的 caption 有问题

mkdirSync(CLEAN_DIR, { recursive: true });
const dirs = findMineruDirs();
const report = { year: YEAR, sim_threshold: SIM_THRESHOLD, documents: [] };

for (const { stem, dir } of dirs) {
  const items = JSON.parse(readFileSync(join(dir, `${stem}_content_list.json`), 'utf8'));
  const pdfPath = join(ART_DIR, `${stem}.pdf`);
  const pdfPages = existsSync(pdfPath) ? await extractPdfLines(pdfPath) : null;

  const fixes = { duplicateTablesMerged: 0, captionsRepaired: 0, captionsKept: 0, captionsSkippedNoCandidate: 0, captionsScrambled: 0, noiseRemoved: 0 };
  const captionLog = [];

  // 1) 去噪
  const kept = [];
  for (const it of items) {
    if (NOISE.has(it.type)) { fixes.noiseRemoved++; continue; }
    kept.push(it);
  }

  // 2) 合并重复表格伪影
  const merged = [];
  for (const it of kept) {
    if (it.type !== 'table') { merged.push(it); continue; }
    const body = String(it.table_body ?? '').trim();
    const isEmpty = body.length < 20;
    const prevTable = [...merged].reverse().find((x) => x.type === 'table');
    const prevBodyLen = prevTable ? String(prevTable.table_body ?? '').trim().length : 0;
    const adjacent = prevTable && Math.abs((it.page_idx ?? 0) - (prevTable.page_idx ?? 0)) <= 1;
    if (isEmpty && prevTable && prevBodyLen >= 20 && adjacent) {
      prevTable.table_caption = [...(prevTable.table_caption ?? []), ...(it.table_caption ?? []).filter(Boolean)];
      prevTable._merged_from = [...(prevTable._merged_from ?? []), { page_idx: it.page_idx, bbox: it.bbox, note: 'duplicate table artifact (header-only bbox)' }];
      fixes.duplicateTablesMerged++;
      continue;
    }
    merged.push(it);
  }

  // 3) caption 校验 / 重建
  //
  // 策略（实测确定）：MinerU 的 caption 在 21/23 的情况下是干净的，
  // 因此【编号清晰就保持原样】，只在编号缺失或明显打散时才修，
  // 且候选必须【同编号】——否则宁可不改。
  for (const it of merged) {
    if (it.type !== 'table' && it.type !== 'image') continue;
    const isTable = it.type === 'table';
    const mineruCap = (isTable ? it.table_caption : it.image_caption ?? []).filter(Boolean).join(' | ');
    if (!pdfPages) continue;

    const kind = isTable ? 'table' : 'figure';
    const wantNum = capNum(mineruCap);
    const broken = fragmentCount(mineruCap) >= 3;
    const missing = !mineruCap.trim();

    // 编号清晰且未打散 → 直接信任 MinerU（实测 21/23 正确）
    if (!missing && !broken && wantNum !== null) {
      it._caption_source = 'mineru';
      it._caption_number = wantNum;
      fixes.captionsKept++;
      continue;
    }

    // 原文是"无编号但描述性良好"的 caption（如散文式表题）→ 不动它，
    // 因为任何按编号找来的候选都会退化成 "Table N"。
    if (!missing && wantNum === null && looksLikeCaption(mineruCap) && !broken) {
      it._caption_source = 'mineru';
      it._caption_flag = 'unnumbered_caption_kept';
      fixes.captionsKept++;
      continue;
    }

    // 情形 A：旋转表格 → 竖带重建；情形 B：按编号做位置匹配
    const rotated = isTable ? rebuildRotatedCaption(pdfPages, it.page_idx ?? 0, wantNum) : null;
    const picked = rotated
      ? { text: rotated, num: wantNum, dist: 0, samePage: true }
      : pickCaption(collectCandidates(pdfPages, it.page_idx ?? 0, it.bbox, kind), wantNum);

    // 只有"候选确实像标题"且"相似度确实更低"时才替换
    const sim = picked ? charSim(mineruCap, picked.text) : 0;
    const worthIt = picked && looksLikeCaption(picked.text) && (!mineruCap.trim() || sim < SIM_THRESHOLD);

    if (!worthIt) {
      it._caption_source = mineruCap ? 'mineru' : 'missing';
      it._caption_number = wantNum;
      it._caption_flag = missing ? 'caption_missing_no_candidate'
        : broken ? 'caption_scrambled_kept' : 'caption_degraded_kept';
      fixes.captionsSkippedNoCandidate++;
      if (broken && missing === false) fixes.captionsScrambled++;
      continue;
    }

    it._caption_source = rotated ? 'pdf_text_layer_rotated' : 'pdf_text_layer';
    it._caption_original = mineruCap;
    it._caption_similarity = +sim.toFixed(3);
    it._caption_number = picked.num;
    if (isTable) it.table_caption = [picked.text];
    else it.image_caption = [picked.text];
    fixes.captionsRepaired++;
    captionLog.push({
      type: it.type, page_idx: it.page_idx, want_num: wantNum, got_num: picked.num,
      sim: +sim.toFixed(3), method: rotated ? 'rotated-band' : 'positional',
      from: mineruCap, to: picked.text,
    });
  }

  const doc = {
    schema_version: 'MINERU_CLEAN/1.0',
    stem,
    source_pdf: `Datas/articles/${YEAR}/${stem}.pdf`,
    counts: {
      raw_items: items.length,
      kept_items: merged.length,
      tables: merged.filter((i) => i.type === 'table').length,
      images: merged.filter((i) => i.type === 'image').length,
      text: merged.filter((i) => i.type === 'text').length,
      lists: merged.filter((i) => i.type === 'list').length,
    },
    fixes,
    caption_log: captionLog,
    items: merged,
  };
  writeFileSync(join(CLEAN_DIR, `${stem}.json`), JSON.stringify(doc, null, 2), 'utf8');
  report.documents.push({ stem, ...doc.counts, ...fixes });
}

writeFileSync(join(CLEAN_DIR, '_clean_report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`年份 ${YEAR}：${dirs.length} 篇  (caption 相似度阈值 ${SIM_THRESHOLD})\n`);
console.log('文件'.padEnd(14), '原始', '保留', '表', '图', '正文', '合表', '修cap', '留cap', '无候选', '去噪');
for (const d of report.documents) {
  console.log(
    d.stem.padEnd(14), String(d.raw_items).padStart(4), String(d.kept_items).padStart(4),
    String(d.tables).padStart(3), String(d.images).padStart(3), String(d.text).padStart(4),
    String(d.duplicateTablesMerged).padStart(4), String(d.captionsRepaired).padStart(5),
    String(d.captionsKept).padStart(6), String(d.captionsSkippedNoCandidate).padStart(6),
    String(d.noiseRemoved).padStart(4),
  );
}
const t = report.documents.reduce((a, d) => ({
  raw: a.raw + d.raw_items, kept: a.kept + d.kept_items, tables: a.tables + d.tables,
  merged: a.merged + d.duplicateTablesMerged, rep: a.rep + d.captionsRepaired,
  keptc: a.keptc + d.captionsKept, noise: a.noise + d.noiseRemoved,
}), { raw: 0, kept: 0, tables: 0, merged: 0, rep: 0, keptc: 0, noise: 0 });
console.log(`\n合计: 原始 ${t.raw} → 保留 ${t.kept}（去噪 ${t.noise}）| 表格 ${t.tables}（合并伪影 ${t.merged}）`);
console.log(`      caption: 保留 ${t.keptc} / 重建 ${t.rep}`);
console.log(`输出: ${CLEAN_DIR}`);
