/**
 * MinerU 有没有把**数字读错/漏读**？—— 用 PDF 原生文字层对账。
 *
 * 为什么要做：本项目所有数值都来自 MinerU 的还原。如果源头就读错了，
 * 那不管提示词写得多细都救不回来 —— 必须先在源头定性。
 *
 * ── 口径演进（踩过坑，记在这里）──────────────────────────────
 * 最初只做「表级 bbox 对账」：拿 MinerU 的 table.bbox 去 PyMuPDF 原生词层框同一区域。
 * 实测在 2015-01 上暴露三个**口径本身的**伪差异，说明 bbox 法不可靠：
 *   ① **跨页合并**：MinerU 把 p4+p5 的跨页表**合成一个块**（p4 块 bbox 近乎整页、
 *      html 含两页内容；p5 块 table_body 的 lines 为 0、html 全空）→ 假的"多读 45 + 漏读 49"；
 *   ② **旋转页**：p6 的 `page_size=[793,595]`，而 PyMuPDF 报 595.3×793.7（正交）
 *      → bbox 坐标系不同，框到的是别处的内容；
 *   ③ **封面误判**：p11 是 BMJ 的期刊封面/引用页，被 layout 误判为 table（html 里有 `<img>`）
 *      → 它本来就不是"论文数据表"。
 *
 * 所以主口径改为**页级**：整页文字的数字多重集对账。
 *   · 不依赖 bbox、不受旋转与跨页影响；
 *   · mineruOnly（MinerU 读出的数字在**该页原生文字里根本不存在**）= **确定性读错/幻觉**，
 *     这是回答"源头有没有错"最硬的证据；
 *   · nativeOnly = 该页原生有、MinerU 整页都没读出 = **漏读**。
 * 表级 bbox 对账降为**辅口径**，只在"方向一致 + bbox 在页内"的表上跑，用于定位具体是哪张表。
 *
 * 另设**宽松口径**估计 OCR 字母数字混淆（`O↔0`、`l/I↔1`）：把文本里 O→0、l/I→1 后再取数字，
 * 若差异因此消失，就归入"字母数字混淆"而非真错。这是**上界**（全文替换比较激进），
 * 在报告里与严格口径并列给出。
 *
 * 用法：
 *   node tools/table_fidelity.mjs                      # 全部年份
 *   node tools/table_fidelity.mjs --year 2015
 *   node tools/table_fidelity.mjs --article 2015-01 --detail
 *   node tools/table_fidelity.mjs --limit 3            # 每年只跑前 3 篇（试跑）
 * 输出：build/table_fidelity.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { deLatex } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(ROOT, 'runtime', 'mineru', 'Scripts', 'python.exe');
const PY_SCRIPT = join(ROOT, 'tools', 'lib', 'pdf_words.py');

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const ONLY_ARTICLE = arg('article', null);
const LIMIT = Number(arg('limit', 0)) || 0;
const DETAIL = argv.includes('--detail');
/**
 * `--raw`：用 MinerU 的**原始**输出对账（会看到 82% 的 `<eq>` 把数字拆成 `4 1 . 7 5`）。
 * 默认用 **清洗后**的文本——那才是下游模型真正看到的材料，也是"源头到底准不准"的正确口径。
 * 两者对照可以看出：raw 口径下的巨大差异有多少是 LaTeX 包装造成的假象。
 */
const RAW = argv.includes('--raw');

const YEARS = ONLY_YEAR
  ? [ONLY_YEAR]
  : ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];

/* ------------------------------ 数字与文本工具 ------------------------------ */

/** HTML 实体解码（MinerU 的 table html 里有 `&#x27;` `&lt;` `&amp;`）。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** 数字规范化：`1,234.5` / `1.234,5` / `−41` / `41.0` 都归到同一个 token。 */
function numsOf(text) {
  const out = [];
  const re = /[-−–—]?\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    let s = m[0].replace(/[−–—]/g, '-');
    /* 欧式千分位（1.234,5）与美式（1,234.5）都处理：把"分隔符后正好 3 位"的当作千分位 */
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s.replace(/^-/, ''))) s = s.replace(/[.,]/g, '');
    else s = s.replace(/,/g, '.');
    const n = Number(s);
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

/** 宽松口径：先把 O→0、l/I→1 再取数字，用于估计 OCR 字母数字混淆的上界。 */
const looseNums = (text) => numsOf(String(text ?? '').replace(/O/g, '0').replace(/[lI]/g, '1'));

/** 文本 → 统一负号后的字面文本（原生 PDF 用 U+2212 `−`，MinerU 用 ASCII `-`）。 */
const literalText = (t) => String(t).replace(/[−–—]/g, '-');
/** 文本 → 纯数字流（去掉一切非数字字符），用于比对"分隔符/空格写法不同"的同一个数。 */
const digitStream = (t) => String(t).replace(/\D/g, '');

/**
 * 我这侧"多出来"的数字里，有多少**在对侧原文里能找到**（字面或数字流）？
 *
 * 为什么需要它：数字多重集对账对**写法差异**极其敏感，实测的三类假差异：
 *   · **上标粘连**：原生把 `2011,8`（年份 + 上标引用号）读成一个数 `2011.8`，
 *     MinerU 读成 `2011` 和 `8` → 严格口径下两边都成了"错"；
 *   · **负号字形**：原生用 U+2212 `−1.1`，MinerU 用 ASCII `-1.1` → `includes` 直接失败；
 *   · **千分位/空格**：原生 `60 000`、MinerU `60000`。
 * 前两类由"统一负号后的字面包含"解决，第三类由"数字流包含"解决。
 * 剩下的才是"这页纸上根本没有这几个字符"——即**确定性编造**，这是最硬的下界。
 *
 * ⚠️ 只统计**超出对侧数量的那部分**（`excess`）。把"两边都有"的份额也算进来会算出负数。
 * ⚠️ 也不要用"把 O 换成 0 再比数字多重集"这种宽松口径：实测它把 12,572/12,625 的
 * "读错"都解释掉了（单字母替换会在整页里凭空造出大量 0 和 1），几乎没有鉴别力。
 *
 * @param m     我这侧的数字多重集
 * @param other 对侧的**原文**（用于字面查找）
 * @param mine  对侧的数字多重集（用于算"超出量"）
 */
function literallyExplained(m, other, mine) {
  const lt = literalText(other);
  const ds = digitStream(other);
  let n = 0;
  for (const [k, c] of m) {
    const excess = c - (mine.get(k) ?? 0);
    if (excess <= 0) continue;
    const needle = digitStream(k);
    const occ = lt.includes(k)
      ? lt.split(k).length - 1
      : (needle && ds.includes(needle) ? excess : 0);
    n += Math.min(excess, occ);
  }
  return n;
}

const multiset = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
const diffCount = (a, b) => {          // a 里比 b 多出来的个数
  let extra = 0;
  for (const [k, n] of a) extra += Math.max(0, n - (b.get(k) ?? 0));
  return extra;
};
const bothCount = (a, b) => {
  let n = 0;
  for (const [k, c] of a) n += Math.min(c, b.get(k) ?? 0);
  return n;
};
const size = (m) => [...m.values()].reduce((a, b) => a + b, 0);

/* ------------------------------ MinerU 侧 ------------------------------ */

/**
 * 遍历一页所有块，拼出该页的**纯文本**（含 discarded_blocks，与原生侧口径对齐）。
 *
 * ⚠️ 顺序很重要：**先 deLatex、后去标签**。
 * 若反过来（先去标签把 `<td>` 换成空格，再 deLatex），"数字粘合"规则会把相邻两个
 * 单元格的 `35` 与 `38` 粘成 `3538` —— 实测这一步会把一致率从 9 成打到 7 成，纯属自伤。
 * 真实 ingest 路径就是在标签完整时清洗的（`tableParts` → `deLatex(sp.html)`），
 * 这里必须与之一致，否则对账结论会指向错误的方向。
 */
function mineruPageText(page) {
  const segs = [];
  const clean = (s) => (RAW ? s : deLatex(s));
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      for (const line of b.lines ?? []) {
        let seg = '';
        for (const span of line.spans ?? []) {
          if (span.content) seg += clean(span.content);
          if (span.html) seg += decodeEntities(clean(String(span.html)).replace(/<[^>]+>/g, ' '));
        }
        if (seg.trim()) segs.push(seg);
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(page.para_blocks);
  walk(page.discarded_blocks);
  /* 用换行而不是空格拼：数字粘合只看普通空格，换行能挡住跨块/跨行的误粘 */
  return segs.join('\n');
}

/** 一页里的表格块（顶层 type=table），带 html、bbox 与"是否期刊封面"标记。 */
function mineruTables(page) {
  const out = [];
  for (const b of page.para_blocks ?? []) {
    if (String(b.type ?? '').toLowerCase() !== 'table') continue;
    let rawHtml = '';
    for (const c of b.blocks ?? []) {
      if (String(c.type ?? '').toLowerCase() !== 'table_body') continue;
      for (const line of c.lines ?? []) for (const span of line.spans ?? []) if (span.html) rawHtml += span.html;
    }
    const hasImg = /<img/i.test(rawHtml);
    /* 同样：先 deLatex 再去标签 */
    const cleaned = RAW ? rawHtml : deLatex(rawHtml);
    out.push({
      bbox: b.bbox ?? null,
      html: decodeEntities(cleaned.replace(/<[^>]+>/g, ' ')),
      hasImg,
      empty: rawHtml.replace(/<[^>]+>/g, '').trim().length === 0,
    });
  }
  return out;
}

/** 读一篇的 `_middle.json`，返回 { pages:[{page,pageSize,text,tables}] }。 */
function readMineru(midFile) {
  const mid = JSON.parse(readFileSync(midFile, 'utf8'));
  const pages = [];
  for (const [pi, page] of (mid.pdf_info ?? []).entries()) {
    pages.push({
      page: pi + 1,
      pageSize: page.page_size ?? null,
      text: mineruPageText(page),
      tables: mineruTables(page),
    });
  }
  return pages;
}

/** 找出该篇的 PDF（Datas/articles/<year>/<id>.pdf，容忍前导连字符）。 */
function pdfOf(year, id) {
  const dir = join(ROOT, 'Datas', 'articles', year);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.pdf')) continue;
    if (f.replace(/\.pdf$/i, '').replace(/^-+/, '') === id) return join(dir, f);
  }
  return null;
}

/** 原生文字里，落在给定 bbox 内的词（MinerU 与 PyMuPDF 坐标原点都是左上）。 */
function wordsInBox(pageWords, bbox) {
  if (!bbox) return pageWords.map((w) => w.t).join(' ');
  const [x0, y0, x1, y1] = bbox;
  const out = [];
  for (const w of pageWords) {
    const [a, b, c, d] = w.b;
    const cx = (a + c) / 2; const cy = (b + d) / 2;
    if (cx >= x0 - 2 && cx <= x1 + 2 && cy >= y0 - 2 && cy <= y1 + 2) out.push(w.t);   // 放宽 2pt
  }
  return out.join(' ');
}

/* ------------------------------ 收集待办（按年） ------------------------------ */

const perYear = new Map();
for (const year of YEARS) {
  const base = join(ROOT, 'build', 'mineru', year);
  if (!existsSync(base)) continue;
  const list = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    /** 2015 的目录名带前导连字符（`-2015-01`），必须容忍——否则整年会被跳过（实测踩过） */
    .map((d) => ({ dir: d.name, id: d.name.replace(/^-+/, '') }))
    .filter((x) => /^\d{4}-\d+$/.test(x.id))
    .filter((x) => !ONLY_ARTICLE || x.id === ONLY_ARTICLE)
    .sort((a, b) => a.id.localeCompare(b.id));
  const limited = LIMIT ? list.slice(0, LIMIT) : list;
  const tasks = [];
  for (const { dir, id } of limited) {
    const midDir = join(base, dir, 'txt');
    if (!existsSync(midDir)) continue;
    const midFile = readdirSync(midDir).find((f) => f.endsWith('_middle.json'));
    if (!midFile) continue;
    const pdf = pdfOf(year, id);
    if (!pdf) continue;
    tasks.push({ year, id, midFile: join(midDir, midFile), pdf });
  }
  if (tasks.length) perYear.set(year, tasks);
}

/* ------------------------------ 主循环 ------------------------------ */

const stat = {
  articles: 0, pages: 0,
  nativeNums: 0, mineruNums: 0, both: 0, nativeOnly: 0, mineruOnly: 0,
  looseNativeOnly: 0, looseMineruOnly: 0,             // 剔除"切分差异"后剩下的 = 真错/真漏
  pagesExact: 0, articlesExact: 0,
  /* 篇级口径：把整篇的原生文字与 MinerU 文字各拼成一串再比 —— 天然免疫"跨页表格归属"伪差异 */
  artNativeNums: 0, artMineruNums: 0, artBoth: 0, artNativeOnly: 0, artMineruOnly: 0,
  artNativeOnlyReal: 0, artMineruOnlyReal: 0, artExact: 0,
  tables: 0, tablesCompared: 0, tablesRotated: 0, tablesCover: 0, tablesEmpty: 0,
  tablesCrossPage: 0, tableNativeOnly: 0, tableMineruOnly: 0,
  pageCountMismatch: 0, failedArticles: [],
};
const pageRows = [];
const artRows = [];
const tableRows = [];
const samples = [];        // 差异页明细
const articleBad = new Map();

let done = 0;
const totalArticles = [...perYear.values()].reduce((a, t) => a + t.length, 0);

for (const [year, tasks] of perYear) {
  const tmp = mkdtempSync(join(tmpdir(), 'pdfwords-'));
  const wordsFile = join(tmp, 'words.json');
  let native = null;
  try {
    const r = spawnSync(PY, [PY_SCRIPT, wordsFile, ...tasks.map((t) => t.pdf)], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (r.status !== 0 || !existsSync(wordsFile)) {
      throw new Error((r.stderr ?? '').replace(/\s+/g, ' ').slice(0, 300) || `python 退出码 ${r.status}`);
    }
    native = JSON.parse(readFileSync(wordsFile, 'utf8'));
  } catch (e) {
    for (const t of tasks) stat.failedArticles.push({ articleId: t.id, error: e.message });
    console.error(`  ⚠ ${year}: 取原生文字失败（${e.message}）`);
    rmSync(tmp, { recursive: true, force: true });
    continue;
  }
  rmSync(tmp, { recursive: true, force: true });

  for (const t of tasks) {
    done++;
    if (DETAIL) process.stderr.write(`\r  对账中 ${done}/${totalArticles} …`);
    let mPages;
    try {
      mPages = readMineru(t.midFile);
    } catch (e) {
      stat.failedArticles.push({ articleId: t.id, error: `middle.json 读取失败：${e.message}` });
      continue;
    }
    const nDoc = native[t.pdf];
    if (!nDoc) { stat.failedArticles.push({ articleId: t.id, error: '原生文字缺失' }); continue; }
    stat.articles++;
    if (mPages.length !== nDoc.page_count) stat.pageCountMismatch++;

    let artNativeOnly = 0; let artMineruOnly = 0;
    /* 篇级累积：整篇的原生文字与 MinerU 文字 */
    const artNativeTextParts = [];
    const artMineruTextParts = [];
    for (const mp of mPages) {
      const np = nDoc.pages[mp.page - 1];
      if (!np) continue;
      stat.pages++;
      artNativeTextParts.push(np.words.map((w) => w.t).join(' '));
      artMineruTextParts.push(mp.text);

      /* 方向一致性：MinerU 的 page_size 与 PyMuPDF 的宽高互换 → 该页被 MinerU 旋转过 */
      const rotated = !!mp.pageSize
        && Math.abs(mp.pageSize[0] - np.height) < 3 && Math.abs(mp.pageSize[1] - np.width) < 3
        && Math.abs(mp.pageSize[0] - np.width) >= 3;

      const nText = np.words.map((w) => w.t).join(' ');
      const nM = multiset(numsOf(nText));
      const mM = multiset(numsOf(mp.text));
      const nOnly = diffCount(nM, mM);
      const mOnly = diffCount(mM, nM);
      const both = bothCount(nM, mM);

      /* 字面存在性复检：剔除"只是切分方式不同"的假差异，留下真正的编造/漏读 */
      const nOnlyReal = Math.max(0, nOnly - literallyExplained(nM, mp.text, mM));   // 原生有、MinerU 原文里连字符都没有
      const mOnlyReal = Math.max(0, mOnly - literallyExplained(mM, nText, nM));     // MinerU 有、原生页上连字符都没有

      stat.nativeNums += size(nM); stat.mineruNums += size(mM);
      stat.both += both; stat.nativeOnly += nOnly; stat.mineruOnly += mOnly;
      stat.looseNativeOnly += nOnlyReal; stat.looseMineruOnly += mOnlyReal;
      if (!nOnly && !mOnly) stat.pagesExact++;
      artNativeOnly += nOnly; artMineruOnly += mOnly;

      pageRows.push({ year, articleId: t.id, page: mp.page, nativeNums: size(nM), mineruNums: size(mM),
        both, nativeOnly: nOnly, mineruOnly: mOnly, nativeOnlyLoose: nOnlyReal, mineruOnlyLoose: mOnlyReal, rotated });

      if ((nOnly || mOnly) && samples.length < 400) {
        const missing = [...nM.keys()].filter((k) => (nM.get(k) ?? 0) > (mM.get(k) ?? 0));
        const extra = [...mM.keys()].filter((k) => (mM.get(k) ?? 0) > (nM.get(k) ?? 0));
        samples.push({ year, articleId: t.id, page: mp.page, rotated,
          missing: missing.slice(0, 10), extra: extra.slice(0, 10),
          missingReal: missing.filter((k) => !mp.text.includes(k)).slice(0, 10),
          extraReal: extra.filter((k) => !nText.includes(k)).slice(0, 10) });
      }

      /* ── 辅口径：表级 bbox ── */
      for (const [ti, tb] of mp.tables.entries()) {
        stat.tables++;
        if (tb.hasImg) { stat.tablesCover++; continue; }                  // 期刊封面/引用页被误判为表
        if (tb.empty) { stat.tablesEmpty++; continue; }                   // 跨页表被并入上一块（本块 body 空）
        if (rotated) { stat.tablesRotated++; continue; }                  // 坐标系正交，bbox 不可比
        const bb = tb.bbox;
        if (!bb || bb[3] > np.height + 2 || bb[0] < -2 || bb[2] > np.width + 2) { stat.tablesCrossPage++; continue; }
        if (bb[3] - bb[1] > np.height * 0.75) { stat.tablesCrossPage++; continue; }   // bbox 近乎整页 → 疑跨页合并
        const tNative = multiset(numsOf(wordsInBox(np.words, bb)));
        const tMineru = multiset(numsOf(tb.html));
        const tn = diffCount(tNative, tMineru);
        const tm = diffCount(tMineru, tNative);
        stat.tableNativeOnly += tn; stat.tableMineruOnly += tm; stat.tablesCompared++;
        tableRows.push({ year, articleId: t.id, page: mp.page, tableIndex: ti + 1,
          nativeNums: size(tNative), mineruNums: size(tMineru), nativeOnly: tn, mineruOnly: tm,
          both: bothCount(tNative, tMineru) });
      }
    }
    if (!artNativeOnly && !artMineruOnly) stat.articlesExact++;
    else articleBad.set(t.id, (articleBad.get(t.id) ?? 0) + artNativeOnly + artMineruOnly);

    /* ── 篇级对账：免疫"跨页表格被算到上一页"的伪差异 ── */
    const artNativeText = artNativeTextParts.join(' ');
    const artMineruText = artMineruTextParts.join(' ');
    const aN = multiset(numsOf(artNativeText));
    const aM = multiset(numsOf(artMineruText));
    const aNOnly = diffCount(aN, aM);
    const aMOnly = diffCount(aM, aN);
    const aBoth = bothCount(aN, aM);
    const aNOnlyReal = Math.max(0, aNOnly - literallyExplained(aN, artMineruText, aM));
    const aMOnlyReal = Math.max(0, aMOnly - literallyExplained(aM, artNativeText, aN));
    stat.artNativeNums += size(aN); stat.artMineruNums += size(aM);
    stat.artBoth += aBoth; stat.artNativeOnly += aNOnly; stat.artMineruOnly += aMOnly;
    stat.artNativeOnlyReal += aNOnlyReal; stat.artMineruOnlyReal += aMOnlyReal;
    if (!aNOnly && !aMOnly) stat.artExact++;
    artRows.push({ year, articleId: t.id, nativeNums: size(aN), mineruNums: size(aM), both: aBoth,
      nativeOnly: aNOnly, mineruOnly: aMOnly,
      nativeOnlyReal: aNOnlyReal, mineruOnlyReal: aMOnlyReal });
  }
}
if (DETAIL) process.stderr.write('\n');

/* ------------------------------ 汇总 ------------------------------ */

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : '—');
const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
const totalNative = stat.nativeNums;
const trueErrors = stat.mineruOnly - stat.looseMineruOnly;    // 页上根本不存在、且换字母也解释不掉
const trueMisses = stat.nativeOnly - stat.looseNativeOnly;

console.log(`\n══ MinerU × PDF 原生文字 数值对账（${stat.articles} 篇 / ${stat.pages} 页）══`);
console.log(RAW ? '  口径：MinerU **原始**输出（未清洗 LaTeX）\n' : '  口径：MinerU 输出**清洗后**（= 下游模型实际看到的材料）\n');
console.log('【篇级】整篇的原生文字 × MinerU 文字（**推荐口径**：免疫跨页归属与旋转页伪差异）');
console.log(`  原生数字 ${stat.artNativeNums}｜MinerU 数字 ${stat.artMineruNums}`);
console.log(`  两边一致：${stat.artBoth}（${pc(stat.artBoth, stat.artNativeNums)}）`);
console.log(`  原生有、MinerU 全篇都没有：${stat.artNativeOnly}（${pc(stat.artNativeOnly, stat.artNativeNums)}）`
  + ` → 其中字面也不存在的**确定性漏读** ${stat.artNativeOnlyReal}（${pc(stat.artNativeOnlyReal, stat.artNativeNums)}）`);
console.log(`  MinerU 有、原生全篇都没有：${stat.artMineruOnly}（${pc(stat.artMineruOnly, stat.artMineruNums)}）`
  + ` → 其中字面也不存在的**确定性编造** ${stat.artMineruOnlyReal}（${pc(stat.artMineruOnlyReal, stat.artMineruNums)}）`);
console.log(`  逐篇数字完全一致：${stat.artExact} / ${stat.articles}（${pc(stat.artExact, stat.articles)}）`);
if (DETAIL) {
  const worstArt = [...artRows].sort((a, b) => (b.nativeOnlyReal + b.mineruOnlyReal) - (a.nativeOnlyReal + a.mineruOnlyReal)).slice(0, 10);
  console.log('  确定性差异最多的篇：');
  for (const r of worstArt) console.log(`   ${r.articleId}：漏 ${r.nativeOnlyReal} / 编造 ${r.mineruOnlyReal}（原生 ${r.nativeNums} 个数字）`);
}

console.log('\n【页级】整页数字多重集（受"跨页表格被算到上一页"影响，只作参考）');
console.log(`  原生数字总数 ${totalNative}｜MinerU 数字总数 ${stat.mineruNums}`);
console.log(`  两边一致：${stat.both}（${pc(stat.both, totalNative)}）`);
console.log(`  原生有、MinerU 整页都没有（**漏读**）：${stat.nativeOnly}（${pc(stat.nativeOnly, totalNative)}）`);
console.log(`  MinerU 有、原生该页根本没有（**读错/幻觉**）：${stat.mineruOnly}（${pc(stat.mineruOnly, stat.mineruNums)}）`);
console.log(`  其中属于**切分方式不同**（数字在原文里字面存在，只是被切开/粘连）：漏 ${stat.looseNativeOnly} / 错 ${stat.looseMineruOnly}`);
console.log(`  ⇒ **确定性编造/漏读**（该页纸上连这几个字符都没有）：漏 ${trueMisses}（${pc(trueMisses, totalNative)}）/ 错 ${trueErrors}（${pc(trueErrors, Math.max(1, stat.mineruNums))}）`);
console.log(`  逐页数字完全一致：${stat.pagesExact} / ${stat.pages}（${pc(stat.pagesExact, stat.pages)}）`);
console.log(`  逐篇数字完全一致：${stat.articlesExact} / ${stat.articles}（${pc(stat.articlesExact, stat.articles)}）`);
if (stat.pageCountMismatch) console.log(`  ⚠ MinerU 页数与 PDF 页数不一致的篇：${stat.pageCountMismatch}`);

console.log('\n  分年：');
console.log('   年份   页数    原生数字   一致率    漏读    读错   真错(扣混淆)  逐页全对');
for (const year of YEARS) {
  const rs = pageRows.filter((r) => r.year === year);
  if (!rs.length) continue;
  const n = sum(rs, 'nativeNums');
  const tr = sum(rs, 'mineruOnly') - sum(rs, 'mineruOnlyLoose');
  console.log(`   ${year}  ${String(rs.length).padStart(5)}  ${String(n).padStart(8)}  ${pc(sum(rs, 'both'), n).padStart(7)}  ${String(sum(rs, 'nativeOnly')).padStart(6)}  ${String(sum(rs, 'mineruOnly')).padStart(6)}  ${String(tr).padStart(9)}  ${pc(rs.filter((r) => !r.nativeOnly && !r.mineruOnly).length, rs.length).padStart(8)}`);
}

console.log('\n【辅口径】表级 bbox 对账（只统计可信的表）');
console.log(`  MinerU 识别出的表格块：${stat.tables}`);
console.log(`  可对账：${stat.tablesCompared}｜期刊封面误判：${stat.tablesCover}｜跨页合并/bbox 越界：${stat.tablesCrossPage}｜旋转页：${stat.tablesRotated}｜body 为空：${stat.tablesEmpty}`);
if (stat.tablesCompared) {
  const tNativeTotal = sum(tableRows, 'nativeNums');
  console.log(`  表内数字：原生 ${tNativeTotal}｜一致 ${sum(tableRows, 'both')}（${pc(sum(tableRows, 'both'), tNativeTotal)}）｜漏 ${stat.tableNativeOnly}｜多 ${stat.tableMineruOnly}`);
}

const worstArticles = [...articleBad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (worstArticles.length) {
  console.log('\n  数值差异最多的篇：');
  for (const [id, n] of worstArticles) {
    const rs = pageRows.filter((r) => r.articleId === id);
    console.log(`   ${id}：差异 ${n} 个数字（原生 ${sum(rs, 'nativeNums')}｜漏 ${sum(rs, 'nativeOnly')}｜错 ${sum(rs, 'mineruOnly')}）`);
  }
}

if (DETAIL && samples.length) {
  const top = samples.sort((a, b) => (b.missing.length + b.extra.length) - (a.missing.length + a.extra.length)).slice(0, 10);
  console.log('\n  差异页明细（前 10）：');
  for (const s of top) {
    console.log(`   ${s.articleId} p${s.page}${s.rotated ? '［旋转页］' : ''}：原生有而 MinerU 无 → ${s.missing.join(',') || '—'}`);
    console.log(`      MinerU 有而原生无 → ${s.extra.join(',') || '—'}${s.extraLoose !== s.extra.length ? `（扣混淆后 ${s.extraLoose}）` : ''}`);
  }
}

const out = join(ROOT, 'build', 'table_fidelity.json');
writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(), stat,
  articleIssues: worstArticles.map(([id, n]) => ({ articleId: id, diff: n })),
  articles: artRows, pages: pageRows, tables: tableRows, samples,
}, null, 1), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
