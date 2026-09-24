#!/usr/bin/env node
/**
 * tools/legend_extract.mjs — 从金标准 xlsx 自动提取「图例 + 批注」为机器可读 schema
 *
 * 输入：Datas/label/*.xlsx（只读）
 * 输出：build/legend/<year>.json + build/legend/_merged.json
 *
 * ===== 为什么需要它（替代手录）=====
 * 填写规范分散在两处，必须合并才完整：
 *   1. **图例行**（Sheet1 的 R1、Sheet3 的 R1~R4 + R5 编码行）—— 编码 → 含义
 *   2. **单元格批注**（266 条）—— 人工填写要求、优先级规则，以及**图例没写全的判定标准**
 *
 * 实例：V2「国家分类」图例只写 `1=东方 2=西方`，批注才补上
 * 「1=东方：亚洲国家 2=西方：非亚洲国家」。少了批注就无法确定性判定。
 *
 * ===== 两个必须处理的坑（都在本项目实测踩到过）=====
 *   A) **表头行判定**：早期版本把所有"数据行之前的行"当表头，
 *      结果 2020+ 因列位移把数据行当成了表头，产出 `field="15"`、`field="age 48.82±13.29"` 这类垃圾。
 *      现在只认真正的表头行：含中文/英文标签、不含纯数值、且位于数据行之前。
 *   B) **列偏移**：Sheet1 在 2020 起整体右移 1 列（字段从 B 列移到 A 列），
 *      而批注坐标仍指向老位置 → 批注会挂到错误字段上。
 *      现在通过与工作表自身比对来校准：批注所在的"列标签"必须能找到对应字段。
 *
 * 调用：node tools/legend_extract.mjs [--year 2015] [--out build/legend]
 */

import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readWorkbook, makeGrid, norm, indexToCol, colToIndex } from './lib/xlsx.mjs';

const ROOT = resolve(process.cwd());
const LABEL_DIR = join(ROOT, 'Datas', 'label');
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ONLY_YEAR = argOf('--year');
const OUT_DIR = resolve(argOf('--out') ?? join(ROOT, 'build', 'legend'));
mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------ 工具 ------------------------------ */

const ID_RE = /^\d{4}-\d{1,2}(?:-\d{1,2})?$/;
/** 严格判据：必须形如 YYYY-NN（年份≥1900），避免把"图例编号 1..15"当成研究 ID。 */
const isStudyId = (v) => {
  const s = norm(v).replace(/^-+/, '');
  if (!ID_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  return y >= 1900 && y <= 2100;
};

/** 剥掉批注前缀里的作者名。 */
function stripAuthorPrefix(body, author) {
  let t = String(body ?? '');
  if (author && t.startsWith(`${author}:`)) t = t.slice(author.length + 1);
  t = t.replace(/^(Administrator|mary|gangweijuan|huaweiuser):\s*/i, '');
  return t.replace(/\r\n/g, '\n').trim();
}

/**
 * 从一段图例文本里解析出 编码 → 含义。
 *
 * 实测存在三种写法，都必须支持（早期只支持 `=` 导致"疾病系统"的 18 类全部漏掉）：
 *   A) `1=补充替代医学期刊 2=非补充替代医学期刊`
 *   B) `1.肌肉骨骼和结缔组织疾病 2.神经系统 …`   ← 疾病系统用的就是这种
 *   C) `2 =否(禁止进行医患交流)`（等号两侧有空格）
 *
 * 边界规则（避免把 `0.001`、`1.5` 这类数值误当编码）：
 *   - 标记必须出现在文本开头或空白之后；
 *   - 编码后紧跟 `=` 或 `.`；
 *   - 该符号之后**不能**是数字（排除小数）。
 */
function parseCodes(text) {
  const out = {};
  if (!text) return out;
  const re = /(?:^|\s)(\d{1,2})\s*(?:=|\.)\s*(?!\d)/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ code: m[1], start: m.index, valueStart: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const value = text.slice(cur.valueStart, end).replace(/[\s\n；;，,]+$/, '').trim();
    if (value) out[cur.code] = value;
  }
  return out;
}

/**
 * 判定一段文本是否"像编码图例块"。
 *
 * ⚠️ 不能只看"解析出 ≥2 个编码"：批注里的普通编号列表也是这个形式。
 * 实测反例（疾病系统的 S2 批注）：
 *   "1.可参考附录3-疾病系统分类。\n2.可参考ICD-11."
 * 它会被解析成 {1:..., 2:...}，而真正的图例在表头行（1..18 共 18 类）。
 * 若让批注覆盖表头，就会把 1、2 两类写成批注文字（这是真实发生过的 bug）。
 *
 * 但门槛过严也有代价：实测有 12 个字段的图例只有 2~3 个编码
 * （如 数据类型 `1=均值±标准差 2=范围`），被过滤后提取结果里就没有编码了。
 *
 * 因此按**来源**区分严格度：
 *   - 表头行（图例行的权威位置）：≥2 个编码即可，或 ≥1 个且文本很短（像纯图例）
 *   - 批注：要求 ≥4 个编码，或 3 个且从 0/1 起连续（排除普通编号列表）
 */
function isLegendBlock(codes, opts = {}) {
  const nums = Object.keys(codes).map(Number).sort((a, b) => a - b);
  const fromComment = opts.fromComment === true;
  const contiguous = nums.length >= 1 && nums[0] !== undefined && nums[nums.length - 1] === nums[0] + nums.length - 1;

  if (fromComment) {
    if (nums.length >= 4) return true;
    if (nums.length >= 3 && nums[0] !== undefined && nums[0] <= 1 && contiguous) return true;
    return false;
  }
  // 表头行：宽松
  if (nums.length >= 2) return true;
  return false;
}

/** 兼容旧用法（默认视为表头来源）。 */
const looksLikeCodeList = (t) => isLegendBlock(parseCodes(t));

/** 含"未报告/不适用"这类哨兵说明。 */
const SENTINEL_HINT = /(未报告|不适用|无法确定|排除|不清楚|\bNR\b|\bNA\b)/i;

/**
 * 判定某一行是否为表头行。
 *
 * 表头行的特征：本行前若干净（有标签）且【不像是数据行】。
 * 数据行的特征：某列是研究 ID；或本行含大量数值型单元格。
 * 曾因只按"数据行之前"取表头而把数据行当表头，产出 field="15" 这类垃圾。
 */
function isHeaderRow(grid, r, firstDataRow) {
  if (r >= firstDataRow) return false;
  let textCells = 0;
  let numericCells = 0;
  let idCells = 0;
  for (let c = 0; c < grid.width; c++) {
    const v = norm(grid.at(r, c));
    if (!v) continue;
    if (isStudyId(v)) { idCells++; continue; }
    // 纯数值（含小数/百分号/负号）视为数据
    if (/^-?\d+(?:\.\d+)?%?$/.test(v)) numericCells++;
    else if (/[\p{L}\u4e00-\u9fff]/u.test(v)) textCells++;
  }
  if (idCells > 0) return false;
  // 数据行常常是"几乎全是数值"
  if (numericCells > 0 && textCells === 0) return false;
  if (numericCells > textCells * 2 && numericCells > 3) return false;
  return textCells > 0 || numericCells === 0;
}

/* ------------------------------ 单年提取 ------------------------------ */

function extractYear(file) {
  const year = (file.match(/^(\d{4})/) ?? [])[1];
  const wb = readWorkbook(join(LABEL_DIR, file));
  const sheets = {};

  /**
   * 权威表头骨架（以 2015 为基准，实测 10/11 年份完全一致）。
   *
   * 为什么用固定骨架而不是"自动探测表头行"：
   *   2023 的 Sheet1 在字段名行(r2) 与数据(r18) 之间**插了 15 行图例编号行**(r3..r17)，
   *   自动探测会把这些行当表头，进而把该块 G 列的论文标题当成字段名，
   *   产出 `field="The efficacy and safety of…"` 这类垃圾。
   *   骨架化后只需按【标签锚定 + 偏移校准】找出该年份的实际列位置——
   *   这与金标准归一化器是同一套做法（见 tools/gold_normalize.mjs）。
   */
  const HEADER_SKELETON = {
    sheet1: { rows: [1, 2], anchorLabel: '文献编号', codeAnchor: null },
    sheet2: { rows: [1], anchorLabel: '文献编号', codeAnchor: null },
    sheet3: { rows: [1, 2, 3, 4, 5], anchorLabel: null, codeAnchor: 'STUDYID' },
  };

  const kindIdx = (name) => {
    const n = name.replace(/\s+/g, '').toLowerCase();
    if (n === 'sheet3') return 'sheet3';
    if (n === 'sheet2') return 'sheet2';
    return 'sheet1';
  };

  for (const sh of wb.sheets) {
    const grid = makeGrid(sh.rows);
    if (!grid.rowNumbers.length) continue;

    /* 1) 数据起始行（必须是 YYYY-NN 形态） */
    let firstDataRow = Infinity;
    for (const r of grid.rowNumbers) {
      let hit = false;
      for (let c = 0; c < Math.min(grid.width, 4); c++) if (isStudyId(grid.at(r, c))) { hit = true; break; }
      if (hit) { firstDataRow = r; break; }
    }
    if (firstDataRow === Infinity) { sheets[sh.name] = { skipped: true, reason: '未找到数据行' }; continue; }

    /* 2) 按骨架取表头行 */
    const skel = HEADER_SKELETON[kindIdx(sh.name)] ?? HEADER_SKELETON.sheet1;
    const headerRows = skel.rows;

    /* 3) 列偏移校准：用锚点标签对齐骨架与本年实际列（2020+ 整体右移 1 列） */
    let colShift = 0;
    if (skel.anchorLabel) {
      const nameRow = skel.rows[skel.rows.length - 1];
      let anchorCol = -1;
      for (let c = 0; c < grid.width; c++) {
        if (norm(grid.at(nameRow, c)) === skel.anchorLabel) { anchorCol = c; break; }
      }
      const BASE_ANCHOR = 1;   // 2015 基准：文献编号在 B 列（0-based 1）
      if (anchorCol >= 0) {
        colShift = anchorCol - BASE_ANCHOR;
      } else {
        // 兜底：用"哪一列最像研究 ID"标定
        const dataRows = grid.rowNumbers.filter((r) => r >= firstDataRow).slice(0, 20);
        for (const cand of [0, 1]) {
          let n = 0;
          for (const r of dataRows) if (isStudyId(grid.at(r, cand))) n++;
          if (n > 0) { colShift = cand - BASE_ANCHOR; break; }
        }
      }
    }

    /* 4) Sheet3 的编码行（在骨架行里以 STUDYID 为锚） */
    let codeRow = null, codeAnchor = null;
    if (skel.codeAnchor) {
      for (const r of headerRows) {
        for (let c = 0; c < grid.width; c++) {
          if (norm(grid.at(r, c)) === skel.codeAnchor) { codeRow = r; codeAnchor = c; break; }
        }
        if (codeRow !== null) break;
      }
    }

    /* 4) 编码名按列（顺序消费，跳空列） */
    const codeNameByCol = new Map();
    if (codeRow !== null && codeAnchor !== null) {
      for (let c = codeAnchor; c < grid.width; c++) {
        const v = norm(grid.at(codeRow, c));
        if (v) codeNameByCol.set(c, v);
      }
    }

    /* 5) 批注收集
     *
     * ⚠️ 澄清（曾判断错）：批注坐标写在本年份**自己的工作表坐标系**里，
     * 不需要再做平移。
     *   2015 Sheet1 有 9 条批注（含 AK2 特定的医患交流、BG2 刺激强度、BV2 数据类型）
     *   2020 Sheet1 只有 8 条，且是**另一组**（D1 离群值、J2 期刊名、T2 国家…）
     * 早年我曾以为"批注停在 2015 坐标而字段右移了"，据此加 colShift，
     * 结果把正确归属改错。现在只用原始列坐标，凭字段标签对齐。
     * colShift 仅用于**报告**（说明本表相对 2015 基准是否右移），不参与归属。
     */
    const commentCols = new Map();
    for (const ref of Object.keys(sh.comments)) {
      if (ref.endsWith('@author')) continue;
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const col = colToIndex(m[1]);
      if (!commentCols.has(col)) commentCols.set(col, []);
      commentCols.get(col).push({
        ref,
        row: Number(m[2]),
        author: sh.comments[`${ref}@author`] ?? null,
        text: stripAuthorPrefix(sh.comments[ref], sh.comments[`${ref}@author`]),
      });
    }

    /* 6) 参与列 */
    const cols = new Set();
    for (const r of headerRows) {
      for (let c = 0; c < grid.width; c++) if (norm(grid.at(r, c))) cols.add(c);
    }
    for (const c of commentCols.keys()) cols.add(c);

    /* 7) 逐列聚合 */
    const fields = [];
    for (const cRaw of [...cols].sort((a, b) => a - b)) {
      const labels = [];
      for (const r of headerRows) {
        const v = norm(grid.at(r, cRaw));
        if (!v) continue;
        labels.push({ row: r, text: v, isCodeRow: codeRow === r });
      }
      const comments = (commentCols.get(cRaw) ?? []).map((x) => ({ ...x, mappedTo: indexToCol(cRaw) }));
      if (!labels.length && !comments.length) continue;

      const nonCode = labels.filter((l) => !l.isCodeRow);
      // 字段名必须"像字段名"：排除纯数值、"1 (东方)" 这类答案选项、含 ± 的统计量
      const looksLikeFieldName = (t) => {
        const s = norm(t);
        if (!s) return false;
        if (/^-?\d+(\.\d+)?%?$/.test(s)) return false;            // 纯数值
        if (/^\d+\s*[（(].*[)）]$/.test(s)) return false;           // "1 (东方)" 答案选项
        if (/[±]/.test(s) || /\d+\.\d+\s*[±]/.test(s)) return false; // "age 48.82±13.29"
        if (/^\d+(\.\d+)?\s*(year|years|mm|min|%)$/i.test(s)) return false;
        return /[\p{L}\u4e00-\u9fff]/u.test(s);
      };
      const nameCandidates = nonCode.filter((l) => looksLikeFieldName(l.text));
      const fieldName = nameCandidates.length ? nameCandidates[nameCandidates.length - 1].text : null;

      // 表头行宽松、批注严格：批注里常见普通编号列表（"1.…2.…"），
      // 若不过滤会覆盖正确图例（疾病系统曾被这样改错）。
      const legendFromHeaders = nonCode.filter((l) => isLegendBlock(parseCodes(l.text))).map((l) => l.text);
      const commentIsLegend = comments.filter((cm) => isLegendBlock(parseCodes(cm.text), { fromComment: true }));
      const legendFromComments = commentIsLegend.map((cm) => cm.text);
      const codes = {};
      // 表头优先，批注仅补全缺失编码（不覆盖）
      for (const t of legendFromHeaders) Object.assign(codes, parseCodes(t));
      for (const t of legendFromComments) {
        for (const [k, v] of Object.entries(parseCodes(t))) if (!(k in codes)) codes[k] = v;
      }

      const legendTexts = new Set([...legendFromHeaders, ...legendFromComments]);
      const requirements = comments.filter((cm) => !legendTexts.has(cm.text)).map((cm) => cm.text).filter(Boolean);

      fields.push({
        col: indexToCol(cRaw),
        colIndex: cRaw,
        sheet: sh.name,
        code: codeNameByCol.get(cRaw) ?? null,
        field: fieldName,
        headerLabels: labels.map((l) => ({ row: l.row, text: l.text })),
        codes: Object.keys(codes).length ? codes : null,
        requirements,
        comments: comments.map((cm) => ({ ref: cm.ref, row: cm.row, author: cm.author, text: cm.text })),
        sentinelHint: [...legendFromHeaders, ...legendFromComments, ...requirements].some((t) => SENTINEL_HINT.test(t)),
      });
    }

    sheets[sh.name] = {
      headerRows,
      colShift,
      codeRow,
      firstDataRow,
      commentColumnShift: colShift,
      fieldCount: fields.length,
      fields,
    };
  }

  return { year, sourceFile: file, sheets };
}

/* ------------------------------ 输出 ------------------------------ */

const files = readdirSync(LABEL_DIR)
  .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
  .sort();

const kindOf = (sheetName) => {
  const n = sheetName.replace(/\s+/g, '').toLowerCase();
  if (n === 'sheet3') return 'outcome';
  if (n === 'sheet2') return 'study';
  return 'article';
};

const docs = [];
for (const f of files) {
  const y = (f.match(/^(\d{4})/) ?? [])[1];
  if (ONLY_YEAR && y !== ONLY_YEAR) continue;
  const doc = extractYear(f);
  writeFileSync(join(OUT_DIR, `${y}.json`), JSON.stringify(doc, null, 2), 'utf8');
  docs.push(doc);
}

/** 合并各年：以字段身份（Sheet3 用编码名，Sheet1/2 用标签）为键。 */
function mergeFields(docs) {
  const merged = new Map();
  for (const d of docs) {
    for (const [sheetName, sh] of Object.entries(d.sheets)) {
      if (sh.skipped) continue;
      const kind = kindOf(sheetName);
      for (const f of sh.fields) {
        // 字段身份：Sheet3 优先用编码名（跨年稳定）；否则用标签
        const identity = f.code ? `code:${f.code}` : f.field ? `label:${norm(f.field)}` : `col:${f.col}`;
        const key = `${kind}::${identity}`;
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, {
            kind, identity, sheet: sheetName,
            col: f.col, code: f.code, field: f.field,
            headerLabels: [...f.headerLabels],
            codes: { ...(f.codes ?? {}) },
            requirements: [...f.requirements],
            comments: [...f.comments],
            sentinelHint: f.sentinelHint,
            seenIn: [d.year],
          });
          continue;
        }
        if (!prev.seenIn.includes(d.year)) prev.seenIn.push(d.year);
        // 编码：后续年份补全，但不覆盖已确立的含义
        for (const [c, v] of Object.entries(f.codes ?? {})) if (!(c in prev.codes)) prev.codes[c] = v;
        for (const r of f.requirements) if (!prev.requirements.includes(r)) prev.requirements.push(r);
        for (const cm of f.comments) if (!prev.comments.some((x) => x.ref === cm.ref && x.text === cm.text)) prev.comments.push(cm);
        if (!prev.field && f.field) prev.field = f.field;
        prev.sentinelHint ||= f.sentinelHint;
      }
    }
  }
  return [...merged.values()].map((m) => ({ ...m, codes: Object.keys(m.codes).length ? m.codes : null }));
}

const allFields = mergeFields(docs);
const merged = {
  schemaVersion: 'AA_LEGEND/1.0',
  generatedFrom: docs.map((d) => d.sourceFile),
  stats: {
    years: docs.map((d) => d.year),
    totalFields: allFields.length,
    withCodes: allFields.filter((f) => f.codes).length,
    withRequirements: allFields.filter((f) => f.requirements.length).length,
    withComments: allFields.filter((f) => f.comments.length).length,
    totalComments: allFields.reduce((n, f) => n + f.comments.length, 0),
  },
  fields: allFields,
};
writeFileSync(join(OUT_DIR, '_merged.json'), JSON.stringify(merged, null, 2), 'utf8');

console.log(`年份 ${docs.map((d) => d.year).join(', ')} → ${OUT_DIR}\n`);
for (const d of docs) {
  const parts = Object.entries(d.sheets)
    .filter(([, v]) => !v.skipped)
    .map(([k, v]) => `${k}(表头行[${v.headerRows.join(',')}] 位移${v.commentColumnShift} 字段${v.fieldCount} 批注${v.fields.reduce((n, f) => n + f.comments.length, 0)})`);
  console.log(`  ${d.year}: ${parts.join('\n           ')}`);
}
console.log(`\n合并结果: ${merged.stats.totalFields} 个字段`);
console.log(`  有编码图例: ${merged.stats.withCodes}`);
console.log(`  有填写要求: ${merged.stats.withRequirements}`);
console.log(`  有批注:     ${merged.stats.withComments}（批注总数 ${merged.stats.totalComments}）`);
console.log(`  编码+要求都有: ${allFields.filter((f) => f.codes && f.requirements.length).length}`);
console.log(`\n输出: ${join(OUT_DIR, '_merged.json')}`);
