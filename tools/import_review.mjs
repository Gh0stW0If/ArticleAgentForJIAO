/**
 * tools/import_review.mjs — 把导出出去的表**导回**成人工标注
 *
 * 工作流：批量导出 → 医生在 Excel 里核对/修改 → 导回 → 系统接收修改。
 *
 * 本文件只做**纯逻辑**：解析表格、算出"要改哪些字段"。
 * 真正落盘（写 `build/annotations/...`）在服务端做，这样危险动作集中在一处、好审。
 *
 * ===== 安全取舍 =====
 *  1. **先算差异，再落盘**。调用方可以只拿 `changes` 做预览（dry-run）给人确认。
 *  2. **只增改，默认不删**。导出后留空的格子有歧义——可能是"我不管了"，
 *     也可能是误删。默认**跳过并计数**，只有显式打开 `retractCleared` 才撤回。
 *  3. **动作由"值 vs 机器值"现算**，不信文件里的「动作」列——
 *     那一列是上一次导出时的状态快照，导回时早已过期。
 *     这条规则与界面上的 `onEdit` 保持一致，两条路写出来的标注才是同一种东西。
 *  4. **对不上就报错，不猜**。字段已退役、研究号不认识、缺 reviewer 列，
 *     一律进 `errors` 并带上行号，不静默丢弃。
 *
 * ===== 表头契约 =====
 * 列名常量与 `tools/export_review.mjs` 的 `BASE_COLUMNS` / `reviewerColumns` 是一份契约。
 * **改那边必须同步改这里**，否则已发出的文件导不回来。
 */

import { readWorkbook } from './lib/xlsx.mjs';
import { BASE_COLUMNS, TAIL_COLUMNS, reviewerColumns, SIG_TAG } from './export_review.mjs';

/** 表头文字（与导出侧同源，避免两处各写一份字符串）。 */
export const HEAD = Object.freeze({
  sheet: BASE_COLUMNS[0],   // 工作表
  year: BASE_COLUMNS[1],    // 年份
  study: BASE_COLUMNS[2],   // 研究
  row: BASE_COLUMNS[3],     // 所在行
  label: BASE_COLUMNS[4],   // 字段
  header: BASE_COLUMNS[5],  // 原始列
  fieldPath: BASE_COLUMNS[6],
  machine: BASE_COLUMNS[7],
  evidence: BASE_COLUMNS[8],
  status: TAIL_COLUMNS[0],
  adopted: TAIL_COLUMNS[1],
  changed: TAIL_COLUMNS[2],
});

/** 归一化表头：去 BOM、折叠空白。容忍"导出后被 Excel 动过空格"。 */
const normHead = (s) => String(s ?? '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();

/** 表头行是否是一张数据表（按内容判定，不靠工作表名——名字可以被改）。 */
const isDataHeader = (cells) => {
  const set = new Set(cells.map(normHead));
  return set.has(HEAD.fieldPath) && set.has(HEAD.year) && set.has(HEAD.study);
};

/* ------------------------------ CSV ------------------------------ */

/**
 * RFC4180 CSV 解析：支持引号包裹、内部逗号/换行、`""` 转义。
 *
 * 为什么不按行 split：证据列里**真的有换行**（PDF 原文），按行切会把一行拆成两行。
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    cell += c;
  }
  // 收尾：最后一行没有换行符时也要收
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/* ------------------------------ 读表 ------------------------------ */

/**
 * 去掉 CSV 顶部的 `#` 注释行（签名就放在那里）。
 *
 * ⚠️ 只剥**顶部连续**的注释，不能全文过滤 `#`：
 * 证据列里可能有换行，换行后正好以 `#` 开头的行是真数据。
 */
function stripLeadingComments(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].startsWith('#')) i++;
  return lines.slice(i).join('\r\n');
}

/**
 * 读签名块；没有签名返回 null（旧版导出的文件也走这条路）。
 *
 * @param {Buffer} bytes
 * @param {'xlsx'|'csv'} kind
 */
export function readSignature(bytes, kind) {
  if (kind === 'csv') {
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const re = new RegExp(`^#\\s*${SIG_TAG}\\s+(\\{.*\\})\\s*$`);
    for (const l of lines) {
      if (!l.startsWith('#')) break;     // 只看顶部注释块
      const m = re.exec(l);
      if (m) { try { return JSON.parse(m[1]); } catch { return null; } }
    }
    return null;
  }
  const wb = readWorkbook(bytes);
  for (const sh of wb.sheets) {
    const r1 = sh.rows.find((x) => x.r === 1);
    if (String(r1?.cells?.[0] ?? '') !== SIG_TAG) continue;
    try { return JSON.parse(String(r1.cells[1] ?? '')); } catch { return null; }
  }
  return null;
}

/**
 * 读成 `{ columns, rows }[]`（每张数据表一份）。
 *
 * @param {Buffer} bytes
 * @param {'xlsx'|'csv'} kind
 */
export function readReviewTables(bytes, kind) {
  const out = [];
  if (kind === 'csv') {
    const rows = parseCsv(stripLeadingComments(bytes.toString('utf8')));
    // CSV 是三张表拼在一起的，靠「工作表」列区分；这里按连续段切开
    if (!rows.length) return out;
    const head = rows[0].map(normHead);
    if (!isDataHeader(head)) throw new Error(`CSV 表头不认识：缺少「${HEAD.fieldPath}」/「${HEAD.year}」/「${HEAD.study}」列`);
    const iSheet = head.indexOf(normHead(HEAD.sheet));
    let cur = null;
    for (const r of rows.slice(1)) {
      const tag = iSheet >= 0 ? normHead(r[iSheet]) : '';
      if (!cur || (tag && cur.tag && tag !== cur.tag)) {
        cur = { tag: tag || cur?.tag || '', columns: rows[0], rows: [] };
        out.push(cur);
      }
      cur.rows.push(r);
    }
    return out;
  }

  const wb = readWorkbook(bytes);
  for (const sh of wb.sheets) {
    const cells = (r) => (sh.rows.find((x) => x.r === r)?.cells ?? []);
    const header = cells(1).map((c) => String(c ?? ''));
    if (!isDataHeader(header)) continue;   // 跳过「核对汇总」等非数据表
    const rows = [];
    for (const r of sh.rows) {
      if (r.r === 1) continue;
      if (!r.cells.some((v) => String(v ?? '').trim() !== '')) continue;
      rows.push(r.cells.map((v, i) => (i < header.length ? String(v ?? '') : '')).slice(0, header.length));
    }
    // 只有表头、没有数据行的表不算数据表（导出时空表也带表头）
    if (!rows.length) continue;
    out.push({ tag: sh.name, columns: header, rows });
  }
  return out;
}

/** 找出某个表头对应的列下标（容忍多余空格）。 */
function colOf(columns, name) {
  const want = normHead(name);
  return columns.findIndex((c) => normHead(c) === want);
}

/** 表头归一化（服务端也要用它定位列）。 */
export { normHead };

/**
 * 文件里出现过的 `年份/研究` 组合。
 *
 * 服务端拿它去**只给这些研究**建字段索引——批量文件可能覆盖两百多篇，
 * 全量建索引会白读几百兆 JSON。
 *
 * @returns {Set<string>} 形如 `2019/2019-01`
 */
export function studyPairs(tables) {
  const out = new Set();
  for (const t of tables) {
    const cYear = colOf(t.columns, HEAD.year);
    const cStudy = colOf(t.columns, HEAD.study);
    if (cYear < 0 || cStudy < 0) continue;
    for (const r of t.rows) {
      const y = String(r[cYear] ?? '').trim();
      const s = String(r[cStudy] ?? '').trim();
      if (y && s) out.add(`${y}/${s}`);
    }
  }
  return out;
}

/* ------------------------------ 差异计算 ------------------------------ */

/** 由「值 vs 机器值」决定动作，与前端 onEdit 同规则。 */
function decideAction(raw, machineRaw, hasMachine) {
  if (!hasMachine) return 'add';
  return raw === machineRaw ? 'confirm' : 'override';
}

/**
 * 算出「要改哪些字段」。
 *
 * @param {object} p
 * @param {{columns:string[], rows:string[][]}[]} p.tables  导出的数据表
 * @param {string} p.reviewer   以哪一位核对人的列作为修改来源
 * @param {Map<string, {machineRaw:string, hasMachine:boolean, existing?:{raw:string,action:string,note?:string}}>} p.index
 *        键 = `${year}/${study}::${fieldPath}`
 * @param {boolean} [p.retractCleared]  是否把「清空的格子」当作撤回（默认 false）
 * @returns {{changes:object[], unchanged:number, cleared:object[], errors:object[], cols:object}}
 */
export function planImport({ tables, reviewer, index, retractCleared = false }) {
  const changes = [];
  const cleared = [];
  const errors = [];
  let unchanged = 0;
  let seen = 0;
  let cols = null;

  for (const t of tables) {
    const cField = colOf(t.columns, HEAD.fieldPath);
    const cYear = colOf(t.columns, HEAD.year);
    const cStudy = colOf(t.columns, HEAD.study);
    const cValue = colOf(t.columns, reviewerColumns(reviewer)[0]);
    const cNote = colOf(t.columns, reviewerColumns(reviewer)[2]);
    cols = { field: cField, year: cYear, study: cStudy, value: cValue, note: cNote };

    if (cField < 0 || cYear < 0 || cStudy < 0) {
      errors.push({ line: 0, reason: `表「${t.tag}」缺少 ${HEAD.year}/${HEAD.study}/${HEAD.fieldPath} 列` });
      continue;
    }
    if (cValue < 0) {
      errors.push({
        line: 0,
        reason: `表「${t.tag}」里没有核对人「${reviewer}」的列（${reviewerColumns(reviewer)[0]}）。`
          + `导出时该核对人还没有任何记录，或核对人名字打错了。`,
      });
      continue;
    }

    t.rows.forEach((r, i) => {
      const line = i + 2;   // 表头占第 1 行
      const year = String(r[cYear] ?? '').trim();
      const study = String(r[cStudy] ?? '').trim();
      const fieldPath = String(r[cField] ?? '').trim();
      if (!fieldPath) { errors.push({ line, reason: '缺 fieldPath' }); return; }

      const key = `${year}/${study}::${fieldPath}`;
      const target = index.get(key);
      if (!target) {
        errors.push({ line, year, study, fieldPath, reason: '该系统里没有这个字段（已退役？研究号不对？）' });
        return;
      }
      seen += 1;

      const raw = String(r[cValue] ?? '').trim();
      const note = cNote >= 0 ? String(r[cNote] ?? '').trim() : '';
      const before = target.existing?.raw ?? null;

      if (raw === '') {
        // 格子空着：默认不动；开了 retractCleared 才当作"撤回"
        if (target.existing) {
          if (retractCleared) cleared.push({ line, year, study, fieldPath, before, retract: true });
          else unchanged += 1;
        }
        return;
      }

      if (target.existing && target.existing.raw === raw) { unchanged += 1; return; }

      changes.push({
        line,
        year,
        study,
        fieldPath,
        raw,
        note,
        // 动作**现算**，不信文件里的「动作」列（那是上次导出时的过期快照）
        action: decideAction(raw, target.machineRaw, target.hasMachine),
        before,
        machineRaw: target.machineRaw,
      });
    });
  }

  return { changes, unchanged, cleared, errors, cols, seen };
}
