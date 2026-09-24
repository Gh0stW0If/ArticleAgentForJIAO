/**
 * 「原始表格列序」——把三张 Sheet 的**真实列顺序**还原成前端可用的布局。
 *
 * 需求：右侧抽取字段改成 Sheet1/Sheet2/Sheet3 三张选项卡，**字段按原始表格的排布**。
 * 因此不能用手写顺序，必须回到金标准的表头去取：
 *
 *   build/legend/<year>.json（由 xlsx 表头 + 单元格批注抽取而来）
 *     Sheet3 有 codeRow=5 → 每列有**列代码**（STUDYID / SUBCONST / BIESTI…），可精确还原；
 *     Sheet1 / Sheet2 没有代码行 → 只能按**中文表头文本**匹配规范清单里的 label。
 *
 * 输出（键 = 规范清单里的 camelCase key，前端用它排序）：
 *   {
 *     headerOf: { <key>: '<原始表头>' },
 *     sheet1: { article: [key…], comparison: [key…] },
 *     sheet2: [key…],
 *     sheet3: { top: [key…], timepoint: { baseline:[…], endOfTreatment:[…], followUpEnd:[…] } },
 *     unmatched: { sheet1: [...], sheet2: [...] },   // 便于发现表头改名
 *   }
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_OUTCOME_FIELDS,
  OUTCOME_TOP_FIELDS, TIMEPOINT_FIELDS,
} from './canonical-field-map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 归一化表头/标签：去空白与标点、全角括号转半角、小写。 */
const norm = (s) => String(s ?? '')
  .replace(/[（]/g, '(').replace(/[）]/g, ')')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[：:，,。.、;；!！?？"'“”‘’]/g, '')
  .toLowerCase();

/** Sheet3 的时点列代码前缀 → 规范时点键。 */
const TP_BY_PREFIX = { B: 'baseline', E: 'endOfTreatment', F: 'followUpEnd' };

/** 加载某年的图例；不存在时退回合并图例。 */
export function loadLegend(year) {
  const perYear = join(ROOT, 'build', 'legend', `${year}.json`);
  const merged = join(ROOT, 'build', 'legend', '_merged.json');
  const file = existsSync(perYear) ? perYear : merged;
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  // 逐年文件：{ sheets: { Sheet1: { fields:[…] } } }；合并文件：{ fields:[…] }（每条带 sheet）
  if (raw.sheets) {
    return {
      source: file,
      sheet1: raw.sheets.Sheet1?.fields ?? [],
      sheet2: raw.sheets.Sheet2?.fields ?? [],
      sheet3: raw.sheets.Sheet3?.fields ?? [],
    };
  }
  const pick = (n) => (raw.fields ?? []).filter((f) => f.sheet === n);
  return { source: file, sheet1: pick('Sheet1'), sheet2: pick('Sheet2'), sheet3: pick('Sheet3') };
}

/**
 * 生成三张表的列序布局。
 *
 * @param {string} year
 */
export function buildSheetLayout(year = '2015') {
  const legend = loadLegend(year);
  const headerOf = {};
  const unmatched = { sheet1: [], sheet2: [] };

  /* ---------- Sheet1：文章级 + 比较组（按中文表头匹配） ---------- */
  const s1Cols = legend?.sheet1 ?? [];
  /**
   * 每一列的可匹配文本集合。
   *
   * ⚠️ Sheet1 里「试验组/对照组」这组表头**重复出现 4 次**（性别、随机例数、脱落人数…），
   * 只比对列名会全部撞在一起。好消息是 legend 的 `headerLabels` 是**逐行**给出的：
   * 例如 `['性别（男/女） ● 若未报告…', '试验组']` —— 行首是字段含义，末行是组别。
   * 因此把两行都收进候选文本，并在规范字段名里带 Experimental/Control 时要求组别对得上。
   */
  const s1Norm = s1Cols.map((c, i) => ({
    i,
    col: c.col,
    texts: [
      norm(c.field),
      ...(c.headerLabels ?? []).map((h) => norm(h.text)),
    ].filter(Boolean),
    group: norm((c.headerLabels ?? []).map((h) => h.text).filter(Boolean).slice(-1)[0] ?? ''),
  }));

  /** 找该规范字段对应的列（先精确、再包含；带 Experimental/Control 时要求组别一致）。 */
  const findCol = (f) => {
    const label = norm(f.label);
    const wantGroup = /Experimental$/.test(f.key) ? '试验组' : /Control$/.test(f.key) ? '对照组' : '';
    const ok = (c) => (wantGroup ? c.group.includes(wantGroup) : true);
    const exact = s1Norm.find((c) => c.texts.includes(label) && ok(c));
    if (exact) return exact;
    // 列名常带批注说明（"性别（男/女） ● 若未报告填 NR"），用"以标签开头/包含标签"再试一轮
    return s1Norm.find((c) => c.texts.some((t) => t.startsWith(label) || t.includes(label)) && ok(c));
  };

  /** 从一组规范字段里，按"在表头里首次出现的位置"排序。 */
  const orderByHeader = (fields, out, miss) => {
    const withPos = [];
    for (const f of fields) {
      const hit = findCol(f);
      if (!hit) { miss.push(f.key); continue; }
      withPos.push({ key: f.key, pos: hit.i, header: s1Cols[hit.i]?.field ?? hit.col });
      if (!headerOf[f.key]) headerOf[f.key] = s1Cols[hit.i]?.field ?? hit.col;
    }
    withPos.sort((a, b) => a.pos - b.pos);
    for (const x of withPos) out.push(x.key);
  };

  const articleKeys = [];
  const comparisonKeys = [];
  orderByHeader(ARTICLE_FIELDS, articleKeys, unmatched.sheet1);
  orderByHeader(COMPARISON_FIELDS, comparisonKeys, unmatched.sheet1);

  /* ---------- Sheet2：结局分类（按中文表头匹配） ---------- */
  const s2Norm = (legend?.sheet2 ?? []).map((c, i) => ({ i, text: norm(c.field), raw: c.field }));
  const s2ByLabel = new Map();
  for (const c of s2Norm) if (!s2ByLabel.has(c.text)) s2ByLabel.set(c.text, c);
  const sheet2 = [];
  const withPos2 = [];
  for (const f of STUDY_OUTCOME_FIELDS) {
    const hit = s2ByLabel.get(norm(f.label));
    if (!hit) { unmatched.sheet2.push(f.key); continue; }
    withPos2.push({ key: f.key, pos: hit.i, header: hit.raw });
    headerOf[f.key] = hit.raw;
  }
  withPos2.sort((a, b) => a.pos - b.pos);
  for (const x of withPos2) sheet2.push(x.key);

  /* ---------- Sheet3：结局字段（顶层按 code；时点列按 B/E/F 前缀分组） ---------- */
  const s3Cols = legend?.sheet3 ?? [];
  const codeToKey = new Map();
  for (const f of OUTCOME_TOP_FIELDS) if (f.code) codeToKey.set(f.code, f.key);
  const tpCodeToKey = new Map();
  for (const f of TIMEPOINT_FIELDS) if (f.code) tpCodeToKey.set(f.code, f.key);

  const top = [];
  const timepoint = { baseline: [], endOfTreatment: [], followUpEnd: [] };
  const tpHeader = {};
  for (const c of s3Cols) {
    const code = c.code;
    if (!code) continue;
    if (tpCodeToKey.has(code)) {
      // 形如 TESTI（无前缀）→ 三个时点共用，跳过（由带前缀的列决定）
      continue;
    }
    if (codeToKey.has(code)) {
      top.push(codeToKey.get(code));
      headerOf[codeToKey.get(code)] ??= c.headerLabels?.map((h) => h.text).join(' ') ?? c.field;
      continue;
    }
    const m = /^([BEF])(.+)$/.exec(code);
    if (m && tpCodeToKey.has(m[2])) {
      const tp = TP_BY_PREFIX[m[1]];
      const key = tpCodeToKey.get(m[2]);
      if (tp && !timepoint[tp].includes(key)) {
        timepoint[tp].push(key);
        tpHeader[`${tp}.${key}`] ??= c.headerLabels?.map((h) => h.text).join(' ') ?? '';
      }
    }
  }
  for (const [tp, keys] of Object.entries(timepoint)) {
    for (const k of keys) headerOf[`${tp}.${k}`] ??= tpHeader[`${tp}.${k}`] ?? '';
  }

  return {
    year,
    source: legend?.source ?? null,
    headerOf,
    sheet1: { article: articleKeys, comparison: comparisonKeys },
    sheet2,
    sheet3: { top, timepoint },
    unmatched,
  };
}
