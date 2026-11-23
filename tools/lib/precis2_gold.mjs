/**
 * PRECIS-2 金标准加载器（第二篇）
 *
 * 数据源：`Datas/design/文章计划 整理 202609/06 PRECIS-2基本信息.xlsx`
 * 目标列：CT–DC（九个领域 + 总分）。人工评分只有 1–5 与 `/`（= N/A），
 * 没有 05 规格里的 `3-B / 3-U / AS` 标签 —— 这正是 docs/25 提醒的「05 与 06 记分方式不一致」。
 * 因此本加载器**只做忠实读取**：
 *
 *   - 数值 1–5 → numeric 1–5，label 同数字；
 *   - `/`     → label `N/A`，numeric null（不猜成 3）；
 *   - 空       → label null，numeric null（缺失，不参与一致率）；
 *   - 若哪天表里出现 `3-B / 3-U / AS:`，按 05 的规则归一化（3-B/3-U 记 numeric 3，AS 不进分母）。
 *
 * 研究 ID：06 的 A 列是「行号」（`2015-04-01`），B 列是文章号（`2015-04`）。
 * 两者与仓库金标准的 ID 都有漂移（实测 6 处跨年笔误、若干 `-01` 后缀），
 * 所以匹配顺序是 **标题优先 → 精确 ID → 去后缀 → 同年编号**，每一步都记录匹配方式，
 * 匹配不上的不丢，进 `unmatched` 供人工看。
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, makeGrid, norm } from './xlsx.mjs';

const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 九个领域。列字母对应 06 表（2015–2025 同一版式）。 */
export const DOMAINS = [
  { key: 'eligibility', col: 'CT', en: 'Eligibility', zh: '纳排标准' },
  { key: 'recruitment', col: 'CU', en: 'Recruitment', zh: '招募' },
  { key: 'setting', col: 'CV', en: 'Setting', zh: '场所' },
  { key: 'organisation', col: 'CW', en: 'Organisation', zh: '组织与资源' },
  { key: 'flex_delivery', col: 'CX', en: 'Flexibility: delivery', zh: '灵活性（实施）' },
  { key: 'flex_adherence', col: 'CY', en: 'Flexibility: adherence', zh: '灵活性（依从）' },
  { key: 'follow_up', col: 'CZ', en: 'Follow-up', zh: '随访' },
  { key: 'primary_outcome', col: 'DA', en: 'Primary outcome', zh: '主要结局' },
  { key: 'primary_analysis', col: 'DB', en: 'Primary analysis', zh: '主要分析' },
];

/** 领域键 → 数值列，便于评测与展示。 */
export const DOMAIN_KEYS = DOMAINS.map((d) => d.key);

/**
 * 归一化一个 PRECIS-2 评分。
 *
 * @param {unknown} raw
 * @returns {{ label: string|null, numeric: number|null, uncertain?: boolean, armSpecific?: boolean, invalid?: boolean }}
 */
export function normalizeScore(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { label: null, numeric: null };

  // 06 的 `/`：不适用。绝不把它猜成 3。
  if (s === '/' || /^n\/?a$/i.test(s)) return { label: 'N/A', numeric: null };

  // 05 的标签（当前 06 里没有，但保留兼容）
  const b = /^3\s*[-–]?\s*B$/i.exec(s);
  if (b) return { label: '3-B', numeric: 3 };

  const u = /^3\s*[-–]?\s*U$/i.exec(s);
  if (u) return { label: '3-U', numeric: 3, uncertain: true };

  if (/^AS\s*[:：]/i.test(s)) return { label: s.replace(/\s+/g, ' '), numeric: null, armSpecific: true };

  if (/^[1-5]$/.test(s)) return { label: s, numeric: Number(s) };

  // 数字但带小数（不应该出现）：按数值取整前先标红
  if (/^[1-5]\.0+$/.test(s)) return { label: s, numeric: Math.round(Number(s)) };

  return { label: s, numeric: null, invalid: true };
}

/** 标题归一化：只留字母数字，用于稳健比较（06 的题名常带换行、大小写不一）。 */
const titleKey = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** 字符 bigram Dice 相似度（长度不同也能比）。 */
export function titleSimilarity(a, b) {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) hit += Math.min(n, gy.get(g) ?? 0);
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

/** 读仓库金标准，得到「已知文章 ID + 题名」。 */
export function loadKnownArticles(root = ROOT) {
  const out = [];
  for (const year of ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025']) {
    const file = join(root, 'build', 'gold', `${year}.json`);
    let j;
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const a of j.articles ?? []) {
      out.push({
        studyId: a.article_id,
        year,
        title: a.article?.title?.raw ?? '',
      });
    }
  }
  return out;
}

/**
 * 把 06 的原始行解析成「行对象」。只依赖列字母，不依赖 Excel 行号。
 *
 * @param {ReturnType<typeof makeGrid>} grid
 */
export function parseRows(grid) {
  const rows = [];
  for (const r of grid.rowNumbers) {
    const idA = norm(grid.at(r, 0));
    const idB = norm(grid.at(r, 1));
    if (!idA && !idB) continue;
    // 表头行（第 1/2 行）没有形如 2015-01 的编号
    if (!/^\d{4}-\d{2}/.test(idA) && !/^\d{4}-\d{2}/.test(idB)) continue;

    const domains = {};
    for (const d of DOMAINS) {
      // 列字母 → 0-based
      const idx = (() => {
        let n = 0;
        for (const ch of d.col) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
      })();
      domains[d.key] = normalizeScore(grid.at(r, idx));
    }

    rows.push({
      excelRow: r,
      idA,
      idB,
      literatureNo: norm(grid.at(r, 2)),
      title: norm(grid.at(r, 7)),
      year: norm(grid.at(r, 8)),
      domains,
      total: nf(grid.at(r, 106)), // DC（A=0 … DC=106）
    });
  }
  return rows;
}

/** 空串 → null；纯数字 → number；其它原样。 */
function nf(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/**
 * 把一行匹配到已知文章。
 *
 * 顺序：标题（≥0.9，且唯一最佳）→ 精确 ID → 去 `-01` 后缀 → 同年同号。
 * 标题优先是因为 06 里确有跨年笔误（如 2022-05 写成 2024-05），
 * 而同名文章在语料里几乎不会重复。
 *
 * @returns {{ study: {studyId:string,year:string,title:string}|null, how: string, candidates: string[] }}
 */
export function matchRow(row, known) {
  // 1) 标题
  if (row.title) {
    const scored = known
      .map((k) => ({ k, s: titleSimilarity(row.title, k.title) }))
      .filter((x) => x.s >= 0.9)
      .sort((a, b) => b.s - a.s);
    if (scored.length) {
      const best = scored[0];
      /*
       * 并列第一必须用 ID 打破，不能随便取一个。
       * 实测 2025-01 / 2025-02 题名高度相似（同一主题的两篇），
       * 单纯按相似度排序会取错年份。
       */
      const tie = scored.filter((x) => Math.abs(x.s - best.s) < 1e-9 && x.k.studyId !== best.k.studyId);
      if (!tie.length) return { study: best.k, how: `title:${best.s.toFixed(3)}`, candidates: [] };
      // 并列：只有 ID 能唯一指定时才认，否则留人工
      const ids = [row.idB, row.idA].filter(Boolean);
      const idHit = tie.find((x) => ids.includes(x.k.studyId)) ?? (ids.includes(best.k.studyId) ? best : undefined);
      if (idHit) return { study: idHit.k, how: `title+id:${idHit.s.toFixed(3)}`, candidates: [] };
      return { study: null, how: 'title-tie', candidates: scored.slice(0, 4).map((x) => x.k.studyId) };
    }
  }

  const ids = [row.idB, row.idA].filter(Boolean);
  // 2) 精确
  for (const id of ids) {
    const hit = known.find((k) => k.studyId === id);
    if (hit) return { study: hit, how: 'exact', candidates: [] };
  }
  // 3) 去掉末尾的 -NN（06 的 A 列比较组后缀）
  for (const id of ids) {
    const base = id.replace(/-\d{2}$/, '');
    const hit = known.find((k) => k.studyId === base);
    if (hit) return { study: hit, how: 'suffix', candidates: [] };
  }
  // 4) 同年同号（年份取 I 列，编号取 B 列的数字段）
  const year = /^\d{4}/.exec(row.year || row.idB)?.[0] ?? '';
  const num = /-(\d{2})/.exec(row.idB)?.[1];
  if (year && num) {
    const id = `${year}-${num}`;
    const hit = known.find((k) => k.studyId === id);
    if (hit) return { study: hit, how: 'year-number', candidates: [] };
  }

  return { study: null, how: 'unmatched', candidates: [] };
}

/** 读整本 06，输出结构化金标准。 */
export function loadGold(opts = {}) {
  const src = opts.src ?? join(ROOT, 'Datas', 'design', '文章计划 整理 202609', '06 PRECIS-2基本信息.xlsx');
  const { sheets } = readWorkbook(src);
  const grid = makeGrid(sheets[0].rows);
  const rows = parseRows(grid);
  const known = opts.known ?? loadKnownArticles(opts.root ?? ROOT);

  const byStudy = new Map();
  const unmatched = [];
  const matchMethods = {};
  const duplicates = [];

  for (const row of rows) {
    const m = matchRow(row, known);
    matchMethods[m.how] = (matchMethods[m.how] ?? 0) + 1;
    if (!m.study) {
      unmatched.push({ idA: row.idA, idB: row.idB, title: row.title, how: m.how, candidates: m.candidates });
      continue;
    }
    const id = m.study.studyId;
    if (!byStudy.has(id)) {
      byStudy.set(id, {
        studyId: id,
        year: m.study.year,
        title: row.title || m.study.title,
        sourceRow: row.excelRow,
        match: m.how,
        domains: row.domains,
        total: row.total,
        duplicateRows: [],
      });
    } else {
      const prev = byStudy.get(id);
      const same = DOMAIN_KEYS.every((k) => prev.domains[k]?.label === row.domains[k]?.label);
      prev.duplicateRows.push({ sourceRow: row.excelRow, idA: row.idA, idB: row.idB, sameScores: same, domains: row.domains });
      if (!same) duplicates.push({ studyId: id, rows: [prev.sourceRow, row.excelRow] });
    }
  }

  return {
    source: src,
    rows: rows.length,
    studies: [...byStudy.values()].sort((a, b) => a.studyId.localeCompare(b.studyId)),
    unmatched,
    duplicates,
    matchMethods,
  };
}

/* ------------------------------- CLI ------------------------------- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const gold = loadGold(process.argv.includes('--src') ? { src: process.argv[process.argv.indexOf('--src') + 1] } : {});
  const out = join(ROOT, 'build', 'precis2', 'gold.json');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(gold, null, 2), 'utf8');

  const withAll = gold.studies.filter((s) => DOMAIN_KEYS.every((k) => s.domains[k]?.label));
  console.log(`06 行数 ${gold.rows} → 匹配 ${gold.studies.length} 篇（九领域齐全 ${withAll.length} 篇）`);
  console.log('匹配方式：', JSON.stringify(gold.matchMethods));
  if (gold.unmatched.length) {
    console.log(`未匹配 ${gold.unmatched.length} 行：`);
    for (const u of gold.unmatched.slice(0, 20)) console.log(`  ${u.idA} / ${u.idB}  ${u.title.slice(0, 50)}  (${u.how})`);
  }
  if (gold.duplicates.length) {
    console.log(`同一篇出现多行且评分不同 ${gold.duplicates.length} 处：`, JSON.stringify(gold.duplicates));
  }
  console.log(`→ ${out}`);
}
