// tools/gold_normalize.mjs — 金标准 xlsx → 统一规范 schema 的层级 JSON
//
// 用法：
//   node tools/gold_normalize.mjs                     # 全部年份 → build/gold/<year>.json
//   node tools/gold_normalize.mjs --year 2015         # 单年
//   node tools/gold_normalize.mjs --out some/dir      # 指定输出目录
//
// 设计要点（均有实测依据，见 docs/02-gold-schema.md）：
//   1. 【按标签锚定，不按列号】—— 2020 起表头整体右移 1 列。
//   2. Sheet3 编码行以 "STUDYID" 为锚点，顺序映射 SHEET3_COLUMNS。
//   3. Sheet1 的 试验组/对照组 段存在重复标签 → 按 group + groupIndex 定位。
//   4. 每个字段输出三元组 { code, raw, legend }，支持打分与人工核对。
//   5. Datas/ 只读，绝不写回。

import { readdirSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { readWorkbook, makeGrid, norm, indexToCol } from './lib/xlsx.mjs';
import {
  ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_FIELDS,
  SHEET3_COLUMNS, SHEET3_TOP_MAP, TIMEPOINT_BLOCKS,
  BLOCK_FIELD_MAP,
} from './gold_schema.mjs';

/** 时点块中文标签（由 TIMEPOINT_BLOCKS 派生，避免重复定义）。 */
const TIMEPOINT_BLOCK_LABELS = Object.fromEntries(
  Object.values(TIMEPOINT_BLOCKS).map((b) => [b.name, b.label]),
);

const ROOT = resolve(process.cwd());
const LABEL_DIR = join(ROOT, 'Datas', 'label');

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT_DIR = argOf('--out') ? resolve(argOf('--out')) : join(ROOT, 'build', 'gold');
const ONLY_YEAR = argOf('--year');
// 是否应用 build/gold/_reconcile.json 里的 ID 修正（源表笔误自愈）
const APPLY_RECONCILE = argv.includes('--apply-reconcile');
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 读取 ID 修正映射：{ [file_year]: Map<from, to|null> }。to=null 表示剔除。
 *
 * 注意避免循环依赖：核对工具（tools/gold_reconcile.mjs）必须基于【朴素】结果
 * （即未应用修正的 build/gold/naive/*.json），否则修正一旦生效，异常就"消失"了，
 * 下次核对会得出不同结论。因此本函数优先读 build/gold/_reconcile.json，
 * 而核对工具读 build/gold/naive/。
 */
function loadRemap() {
  const p = join(ROOT, 'build', 'gold', '_reconcile.json');
  if (!existsSync(p)) {
    if (APPLY_RECONCILE) throw new Error(`--apply-reconcile 需要 ${p}，请先运行 tools/gold_reconcile.mjs`);
    return null;
  }
  const rep = JSON.parse(readFileSync(p, 'utf8'));
  const byYear = new Map();
  for (const m of rep.id_remap ?? []) {
    if (!byYear.has(m.file_year)) byYear.set(m.file_year, new Map());
    const suffix = m.to ? m.from.slice(m.to.length) : '';
    byYear.get(m.file_year).set(m.from, m.to ? m.to + suffix : null);
  }
  return byYear;
}
const REMAP = APPLY_RECONCILE ? loadRemap() : null;

/** 应用 ID 修正。返回 { id, applied, dropped, original }。
 *
 * 映射表的键统一是【文章级】ID（如 2024-06），但调用方传进来的可能是
 * 【比较组级】ID（如 2024-06-01）。因此匹配策略是：用输入 ID 的**逐级前缀**
 * 去查表，从最长前缀开始（`2024-06-01` → 试 `2024-06-01`、`2024-06`）。
 *
 * 早期版本写成 `key.startsWith(id + '-')`，方向反了，导致比较组级 ID 永远匹配不上。
 */
function resolveId(fileYear, id) {
  const m = REMAP?.get(fileYear);
  if (!m) return { id, applied: false };
  const parts = id.split('-');
  for (let take = parts.length; take >= 2; take--) {
    const key = parts.slice(0, take).join('-');
    if (!m.has(key)) continue;
    const to = m.get(key);
    if (to === null) return { id, applied: false, dropped: true, original: id };
    // 保留输入 ID 相对该键多出来的后缀（比较组序号）
    const suffix = id.slice(key.length);
    return { id: to + suffix, applied: true, original: id };
  }
  return { id, applied: false };
}

/* --------------------------- 通用工具 --------------------------- */

/** 判断是否为研究 ID：YYYY-NN 或 YYYY-NN-K。 */
const ID_RE = /^\d{4}-\d{1,2}(?:-\d{1,2})?$/;
const isStudyId = (v) => ID_RE.test(norm(v));

/**
 * 研究 ID → 文章 ID。
 * `2015-01` → `2015-01`（不变）；`2015-04-01` → `2015-04`（去掉比较组序号）。
 * 注意 2015-2019 年份段都是 2 位，必须锚定完整正则而不是简单裁剪尾部。
 */
const articleIdOf = (id) => {
  const v = norm(id);
  const m = /^(\d{4}-\d{1,2})(?:-\d{1,2})?$/.exec(v);
  return m ? m[1] : v;
};

/** 从 sheet 中找出「锚点标签」所在的行号（取最后一个匹配，避免图例行误判）。 */
function findFieldRow(grid, anchors) {
  let found = null;
  for (const r of grid.rowNumbers) {
    for (let c = 0; c < Math.min(grid.width, 12); c++) {
      const v = norm(grid.at(r, c));
      if (v && anchors.includes(v)) { found = r; break; }
    }
  }
  return found;
}

/** 解析字段描述符 → 列号。
 *
 * 关于列偏移（实测结论，勿轻易改动）：
 *   Sheet1 表头行有一个合并单元格，把「文献编号」「提取人姓名」两个标签整体右移了
 *   1 列：它们的标签在 B/C，而数据在 A/B。**其余所有列表头与数据是对齐的。**
 *   Sheet2 则完全对齐。
 *   因此偏移只作用于「表头列 < 首个已对齐字段」的前两列，不能全局套用。
 */
const HEADER_SHIFTED_KEYS = new Set(['literature_no', 'extractor']);

function buildColumnMap(grid, fieldRow, legendRow, fields) {
  const map = {};
  const rowLabel = (c) => norm(grid.at(fieldRow, c));

  /** 校准前两列的偏移（用「ID 实际列 vs 表头标签列」比对，不靠猜）。
   *
   * 实测：
   *   Sheet1 表头行有合并单元格 → 标签「文献编号」在 B[1]，数据在 A[0] → shift = -1
   *   Sheet2 表头与数据对齐     → 标签「文献编号」在 A[0]，数据在 A[0] → shift = 0
   * 早期版本用「A 有 ID 且 B 无 ID」判定，因为 Sheet2 的 B 列本来就是空列而误判为 -1。
   */
  const detectLeadingShift = () => {
    const idField = fields[0];
    if (!idField?.labels) return 0;
    let headerCol = -1;
    for (let c = 0; c < grid.width; c++) {
      const v = rowLabel(c);
      if (v && idField.labels.some((l) => norm(l) === v)) { headerCol = c; break; }
    }
    if (headerCol < 0) return 0;
    const dataRows = grid.rowNumbers.filter((r) => r > fieldRow);
    const idCount = (col) => (col < 0 ? 0 : dataRows.filter((r) => isStudyId(grid.at(r, col))).length);
    let bestShift = 0, bestCount = -1;
    for (const shift of [0, -1]) {
      const n = idCount(headerCol + shift);
      if (n > bestCount) { bestCount = n; bestShift = shift; }
    }
    return bestCount > 0 ? bestShift : 0;
  };
  const leadingShift = detectLeadingShift();

  for (const f of fields) {
    const isLeading = HEADER_SHIFTED_KEYS.has(f.key);
    const shift = isLeading ? leadingShift : 0;

    if (f.labels) {
      let hit = -1;
      for (let c = 0; c < grid.width; c++) {
        const v = rowLabel(c);
        if (v && f.labels.some((l) => norm(l) === v)) { hit = c; break; }
      }
      if (hit >= 0) {
        const col = hit + shift;
        map[f.key] = { col, headerCol: hit, shift, header: rowLabel(hit), legend: norm(grid.at(legendRow, col)) };
        continue;
      }
    }
    if (f.group) {
      const groupCols = [];
      for (let c = 0; c < grid.width; c++) if (rowLabel(c) === f.group) groupCols.push(c);
      const anchor = groupCols[f.groupIndex ?? 0];
      if (anchor !== undefined) {
        const col = anchor + (f.offset ?? 0) + shift;
        map[f.key] = { col, headerCol: anchor, shift, header: rowLabel(anchor), group: f.group, legend: norm(grid.at(legendRow, col)) };
        continue;
      }
    }
    map[f.key] = null;   // 未找到，显式记录（便于发现 schema 漂移）
  }
  map.__leadingShift = leadingShift;
  return map;
}

/** 把 'a.b.c' 写入对象。 */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ??= {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 判定“像编码的值”：整数或 数字/数字 复合形式。 */
const CODE_LIKE = /^\d+(?:\/\d+)*$/;
const isCodeLike = (v) => CODE_LIKE.test(norm(v));

/**
 * 单元格 → 三元组字段值。
 * 返回 null 表示空（调用方决定是否省略）。
 */
function fieldValue(raw, legend) {
  const v = norm(raw);
  if (v === '') return null;
  const out = { raw: v };
  if (isCodeLike(v)) {
    out.code = v;
    if (legend) out.legend = legend;
  }
  return out;
}

/* ------------------------ Sheet3 时点块展开 ------------------------ */

/**
 * 把 Sheet3 一行（151 个编码列）展开为层级对象。
 * @param values Record<code,string>  code → 原始值
 */
function expandSheet3Row(values) {
  const record = {};

  // 顶层字段
  for (const [code, path] of Object.entries(SHEET3_TOP_MAP)) {
    const v = values[code];
    const fv = fieldValue(v ?? '', '');
    if (fv) setPath(record, path, fv);
  }

  // 时点块
  for (const [prefix, info] of Object.entries(TIMEPOINT_BLOCKS)) {
    const block = {};
    for (const [suffix, path] of Object.entries(BLOCK_FIELD_MAP)) {
      const code = prefix + suffix;
      if (!(code in values)) continue;
      const fv = fieldValue(values[code], '');
      if (fv) setPath(block, path, fv);
    }
    if (Object.keys(block).length) setPath(record, `timepoints.${info.name}`, block);
  }
  return record;
}

/* ---------------------------- 单文件转换 ---------------------------- */

/**
 * 识别三个 sheet 的角色。
 *
 * 注意：不能靠数据值里的关键字判定（Sheet1 的数据单元格可能含「题目」等字样），
 * 必须用【表头行】+【结构】特征。曾经因为 `continue` 只跳出内层循环、
 * 以及匹配条件过宽，把 Sheet2 误判成 Sheet1。
 *
 * 结构特征（实测，2015–2025 稳定）：
 *   - Sheet3：含 STUDYID 编码行，列数 ~152+
 *   - Sheet1：列数 ≥ 80（实际 91）
 *   - Sheet2：列数 ≤ 15（实际 10–12）
 */
function classifySheets(sheets) {
  const profiles = sheets.map((sh) => {
    const grid = makeGrid(sh.rows);
    // 是否存在「表头行」：某行在前几列含锚点标签
    let headerRow = null;
    for (const r of grid.rowNumbers) {
      const vals = [];
      for (let c = 0; c < Math.min(grid.width, 8); c++) vals.push(norm(grid.at(r, c)));
      if (vals.includes('文献编号') || vals.includes('STUDYID')) { headerRow = r; break; }
    }
    // A 列是否承载研究 ID
    const dataRows = headerRow === null ? [] : grid.rowNumbers.filter((r) => r > headerRow);
    const idColumnA = dataRows.filter((r) => isStudyId(grid.at(r, 0))).length;
    const hasStudyIdCodeRow = (() => {
      for (const r of grid.rowNumbers) {
        for (let c = 0; c < grid.width; c++) if (norm(grid.at(r, c)) === 'STUDYID') return true;
      }
      return false;
    })();
    return { sheet: sh, width: grid.width, headerRow, idColumnA, hasStudyIdCodeRow };
  });

  const byWidth = [...profiles].sort((a, b) => b.width - a.width);
  const s3 = profiles.find((p) => p.hasStudyIdCodeRow) ?? null;
  const rest = profiles.filter((p) => p !== s3);
  const s1 = rest.find((p) => p.width >= 40) ?? null;
  const s2 = rest.find((p) => p !== s1) ?? null;

  return {
    s1: s1?.sheet ?? null,
    s2: s2?.sheet ?? null,
    s3: s3?.sheet ?? null,
    profile: profiles.map((p) => ({ name: p.sheet.name, width: p.width, idColumnA: p.idColumnA, hasStudyIdCodeRow: p.hasStudyIdCodeRow })),
    byWidth: byWidth.map((p) => `${p.sheet.name}(${p.width})`),
  };
}

function convertFile(path) {
  const year = (basename(path).match(/^(\d{4})/) ?? [])[1] ?? 'unknown';
  const wb = readWorkbook(path);
  const { s1, s2, s3 } = classifySheets(wb.sheets);
  const warnings = [];
  const droppedIds = new Set();      // 被判定为跨年份复制残留而剔除的 ID
  const remappedIds = [];            // 被修正的 ID

  /* ---- Sheet1：文章级 + 比较组级 ---- */
  const articles = new Map();   // articleKey -> record
  const comparisons = [];
  let sheet1Map = null;

  if (!s1) {
    warnings.push('未识别到 Sheet1（文章/比较组级）');
  } else {
    const grid = makeGrid(s1.rows);
    const fieldRow = findFieldRow(grid, ['题目']);
    if (!fieldRow) {
      warnings.push('Sheet1 未找到字段名行（锚点「题目」）');
    } else {
      const legendRow = fieldRow - 1;
      sheet1Map = {
        article: buildColumnMap(grid, fieldRow, legendRow, ARTICLE_FIELDS),
        comparison: buildColumnMap(grid, fieldRow, legendRow, COMPARISON_FIELDS),
      };

      for (const r of grid.rowNumbers) {
        if (r <= fieldRow) continue;
        const rawId = norm(grid.at(r, sheet1Map.article.literature_no?.col ?? -1));
        if (!isStudyId(rawId)) continue;
        const rid = resolveId(year, rawId);
        if (rid.dropped) { droppedIds.add(rawId); continue; }
        const id = rid.id;
        if (rid.applied) remappedIds.push({ from: rawId, to: id });

        // 文章级
        const artKey = articleIdOf(id);
        if (!articles.has(artKey)) {
          const rec = {};
          for (const f of ARTICLE_FIELDS) {
            const m = sheet1Map.article[f.key];
            if (!m) continue;
            const fv = fieldValue(grid.at(r, m.col), m.legend);
            if (fv) rec[f.key] = fv;
          }
          articles.set(artKey, rec);
        }

        // 比较组级
        const cmp = { study_id: id, article_id: artKey };
        for (const f of COMPARISON_FIELDS) {
          const m = sheet1Map.comparison[f.key];
          if (!m) continue;
          const fv = fieldValue(grid.at(r, m.col), m.legend);
          if (fv) cmp[f.key] = fv;
        }
        comparisons.push(cmp);
      }
    }
  }

  /* ---- Sheet2：文章级结局分类 ---- */
  const studies = new Map();
  let sheet2Offset = null;
  if (!s2) {
    warnings.push('未识别到 Sheet2（文章级）');
  } else {
    const grid = makeGrid(s2.rows);
    const fieldRow = findFieldRow(grid, ['文献编号']);
    if (!fieldRow) {
      warnings.push('Sheet2 未找到字段名行（锚点「文献编号」）');
    } else {
      const legendRow = fieldRow - 1;
      const map = buildColumnMap(grid, fieldRow, legendRow, STUDY_FIELDS);
      sheet2Offset = map.__leadingShift;
      for (const r of grid.rowNumbers) {
        if (r <= fieldRow) continue;
        const rawId = norm(grid.at(r, map.literature_no?.col ?? -1));
        if (!isStudyId(rawId)) continue;
        const rid = resolveId(year, rawId);
        if (rid.dropped) { droppedIds.add(rawId); continue; }
        const id = rid.id;
        if (rid.applied && !remappedIds.some((x) => x.from === rawId)) remappedIds.push({ from: rawId, to: id });
        const rec = {};
        for (const f of STUDY_FIELDS) {
          const m = map[f.key];
          if (!m) continue;
          const fv = fieldValue(grid.at(r, m.col), m.legend);
          if (fv) rec[f.key] = fv;
        }
        studies.set(id, rec);
      }
    }
  }

  /* ---- Sheet3：结局级 ---- */
  const outcomes = [];
  let sheet3Map = null;
  if (!s3) {
    warnings.push('未识别到 Sheet3（结局级）');
  } else {
    const grid = makeGrid(s3.rows);
    // 编码行 = 含 STUDYID 的行（取最后一个匹配，表头有多行）
    let codeRow = null, anchorCol = null;
    for (const r of grid.rowNumbers) {
      for (let c = 0; c < grid.width; c++) {
        if (norm(grid.at(r, c)) === 'STUDYID') { codeRow = r; anchorCol = c; }
      }
      if (codeRow !== null && r <= codeRow) continue;
    }
    if (codeRow === null) {
      warnings.push('Sheet3 未找到编码行（锚点 STUDYID）');
    } else {
      // 从锚点列开始，把非空单元格按顺序映射到 SHEET3_COLUMNS
      // （表头有合并单元格造成的空洞，因此跳过空值、顺序消费编码）
      const codeToCol = {};
      let k = 0;
      for (let c = anchorCol; c < grid.width && k < SHEET3_COLUMNS.length; c++) {
        const v = norm(grid.at(codeRow, c));
        if (!v) continue;
        codeToCol[SHEET3_COLUMNS[k]] = c;
        k++;
      }
      sheet3Map = { codeRow, anchorCol, mapped: k, total: SHEET3_COLUMNS.length };
      if (k !== SHEET3_COLUMNS.length) {
        warnings.push(`Sheet3 编码列数不匹配：映射 ${k} / 期望 ${SHEET3_COLUMNS.length}`);
      }

      for (const r of grid.rowNumbers) {
        if (r <= codeRow) continue;
        // Sheet3：A 列 = 文章/比较组 ID（如 2015-01 / 2015-04-01）；
        //          编码行里的 STUDYID 列实际存「文献编号+结局序号」（如 EN009-1）。
        const rawRowId = norm(grid.at(r, 0));
        if (!isStudyId(rawRowId)) continue;
        const rid3 = resolveId(year, rawRowId);
        if (rid3.dropped) { droppedIds.add(rawRowId); continue; }
        const articleId = rid3.id;
        if (rid3.applied) remappedIds.push({ from: rawRowId, to: articleId });
        const values = {};
        for (const [code, col] of Object.entries(codeToCol)) {
          const v = norm(grid.at(r, col));
          if (v !== '') values[code] = v;
        }
        if (!Object.keys(values).length) continue;
        const rec = expandSheet3Row(values);
        rec.article_id = { raw: articleId };
        rec.row_id = { raw: articleId };
        outcomes.push(rec);
      }
    }
  }

  /* ---- 组装 ---- */
  // 归约：Sheet3 里出现的比较组 ID（如 2015-04-01）并入其文章（2015-04），
  // 避免同一篇文章被拆成多个顶层条目。
  const articleIds = new Set([
    ...articles.keys(),
    ...studies.keys(),
    ...comparisons.map((c) => c.article_id),
    ...outcomes.map((o) => o.article_id?.raw).filter(Boolean).map(articleIdOf),
  ].filter(Boolean));

  /* ---- 数据质量检查（源表本身的完整性问题，不是解析问题）---- */
  const dataQuality = [];
  if (droppedIds.size) {
    dataQuality.push({
      kind: 'dropped_cross_year_rows',
      detail: `按 _reconcile.json 剔除了 ${droppedIds.size} 个跨年份复制残留 ID：${[...droppedIds].join(', ')}`,
      ids: [...droppedIds],
    });
  }
  if (remappedIds.length) {
    const uniq = [...new Map(remappedIds.map((x) => [x.from, x])).values()];
    dataQuality.push({
      kind: 'remapped_ids',
      detail: `按 _reconcile.json 修正了 ${uniq.length} 个 ID：${uniq.map((x) => `${x.from}→${x.to}`).join(', ')}`,
      ids: uniq,
    });
  }
  const crossYear = [...articleIds].filter((a) => !a.startsWith(`${year}-`));
  if (crossYear.length) {
    dataQuality.push({
      kind: 'cross_year_id',
      detail: `源表 A 列含非本年份的 ID：${crossYear.join(', ')}`,
      ids: crossYear,
    });
  }
  const missingSheet1 = [...studies.keys()].filter((a) => !articles.has(a) && !comparisons.some((c) => c.article_id === a));
  if (missingSheet1.length) {
    dataQuality.push({
      kind: 'study_without_article_row',
      detail: `Sheet2 有、Sheet1 无：${missingSheet1.join(', ')}`,
      ids: missingSheet1,
    });
  }

  // Sheet3 中存在但没有文章级记录的孤立结局行
  const orphanOutcomes = outcomes.filter((o) => {
    const aid = articleIdOf(o.article_id?.raw ?? '');
    return !articles.has(aid) && !studies.has(aid) && !comparisons.some((c) => c.article_id === aid);
  });
  if (orphanOutcomes.length) {
    dataQuality.push({
      kind: 'orphan_outcome_rows',
      detail: `Sheet3 有 ${orphanOutcomes.length} 行结局，但对应文章在 Sheet1/Sheet2 中不存在`,
      ids: [...new Set(orphanOutcomes.map((o) => o.row_id?.raw))],
    });
  }


  const doc = {
    schema_version: 'GOLD/1.0',
    generated_from: basename(path),
    year,
    level: 'article+comparison+outcome',
    counts: {
      articles: articleIds.size,
      comparisons: comparisons.length,
      studies: studies.size,
      outcomes: outcomes.length,
      orphan_outcomes: orphanOutcomes.length,
    },
    // 字段定义（供评估与人工核对）
    field_definitions: {
      article: ARTICLE_FIELDS,
      comparison: COMPARISON_FIELDS,
      study: STUDY_FIELDS,
      outcome_columns: SHEET3_COLUMNS,
      outcome_top_map: SHEET3_TOP_MAP,
      timepoint_blocks: TIMEPOINT_BLOCKS,
      timepoint_block_labels: TIMEPOINT_BLOCK_LABELS,
      block_field_map: BLOCK_FIELD_MAP,
    },
    column_map: { sheet1: sheet1Map, sheet2Offset, sheet3: sheet3Map },
    data_quality: dataQuality,
    articles: [...articleIds].sort().map((aid) => ({
      article_id: aid,
      article: articles.get(aid) ?? {},
      study: studies.get(aid) ?? {},
      comparisons: comparisons.filter((c) => c.article_id === aid),
      outcomes: outcomes.filter((o) => articleIdOf(o.article_id?.raw ?? '') === aid),
    })),
    warnings,
  };
  return doc;
}

/* ------------------------------- main ------------------------------- */

const files = readdirSync(LABEL_DIR)
  .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
  .sort();

// 审计基线：无论是否应用修正，都先写一份「朴素」结果到 build/gold/naive/。
// tools/gold_reconcile.mjs 读的就是它，从而避免「修正后异常消失」的循环依赖。
const NAIVE_DIR = join(ROOT, 'build', 'gold', 'naive');
mkdirSync(NAIVE_DIR, { recursive: true });

const summary = [];
for (const f of files) {
  const year = (f.match(/^(\d{4})/) ?? [])[1];
  if (ONLY_YEAR && year !== ONLY_YEAR) continue;
  try {
    // 1) 朴素结果（不应用修正）
    const naive = convertFile(join(LABEL_DIR, f));
    writeFileSync(join(NAIVE_DIR, `${year}.json`), JSON.stringify(naive, null, 2), 'utf8');

    // 2) 规范结果（按需应用修正）
    const doc = APPLY_RECONCILE ? convertFile(join(LABEL_DIR, f)) : naive;
    writeFileSync(join(OUT_DIR, `${year}.json`), JSON.stringify(doc, null, 2), 'utf8');

    summary.push({ year, file: f, ...doc.counts, warnings: doc.warnings });
  } catch (err) {
    summary.push({ year, file: f, error: String(err?.message ?? err) });
  }
}

console.log(JSON.stringify(summary, null, 2));
const totalWarn = summary.reduce((a, s) => a + (s.warnings?.length ?? 0), 0);
console.log(`\n输出目录: ${OUT_DIR}`);
console.log(`总计警告: ${totalWarn}`);
