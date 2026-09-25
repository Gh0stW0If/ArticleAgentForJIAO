/**
 * tools/export_review.mjs — 把「字段视图 + 各核对人记录」摊成可导出的表
 *
 * 用途：医生要拿文件做人机核对，所以需要"一键导出"。
 * 输出两种格式，**列结构完全一致**（XLSX 只是把三张表分成三个工作表）：
 *   · XLSX —— 给人看：每个字段一行，每位核对人三列（值 / 动作 / 备注），有分歧的行标红
 *   · CSV  —— 给程序/AI 读：三张表拼成一张，首列 `工作表` 区分
 *
 * 设计取舍：
 *  1. **一位核对人三列**，不是一人一列拼字符串——机器要能按列取值，人也一眼看得清。
 *  2. **列结构两种格式保持一致**：同一份数据换个壳，比对与 diff 才不会打架。
 *  3. 只做"摊平"，不重新取数：输入就是服务端已经算好的字段视图（groups/order/headerOf），
 *     因此导出的内容**必然与界面上看到的一致**，不会出现"页面一个值、文件另一个值"。
 */

/** 动作 → 中文。 */
const ACTION_ZH = { confirm: '确认', override: '修改', add: '补录' };

/** 核对状态 → 中文。缺省（没人碰过）算「未核对」。 */
const STATUS_ZH = {
  agreed: '一致',
  disputed: '有分歧',
  single: '仅一人核对',
  'machine-only': '未核对',
};

/** 三张数据表的列（不含核对人部分）。 */
const HEAD_BASE = ['工作表', '所在行', '字段', '原始列', 'fieldPath', '机器值', '机器证据'];
const HEAD_TAIL = ['核对状态', '采用值', '是否改动'];
const REVIEW_HEAD = (r) => [`${r} · 值`, `${r} · 动作`, `${r} · 备注`];

/** 组 id → 工作表序号（1/2/3）；返回 null 表示不导出。 */
function sheetOfGroup(id) {
  if (id === 'studyOutcomes') return 2;
  if (id === 'article' || /^cmp-/.test(id)) return 1;
  if (/^out-\d+$/.test(id) || id === 'otherOutcomes') return 3;
  return null; // 例如 sheet3 的 candidates（待纳入候选，还不是正式行）
}

/** 字段的规范键：优先服务端给的 key，否则取路径末段。 */
const keyOf = (f) => f.key ?? String(f.fieldPath).split('.').pop();

/** 原始表头：优先按规范键查，其次按路径末段查。 */
function headerFor(f, headerOf) {
  if (!headerOf) return '';
  return headerOf[keyOf(f)] ?? headerOf[String(f.fieldPath).split('.').pop()] ?? '';
}

/** 机器值：被人工改过就取 LLM 原值，否则取当前值。 */
function machineRawOf(f) {
  if (f.decidedBy === 'human') return f.llmRaw ?? '（机器无值，人工补录）';
  return f.raw ?? '';
}

/** 证据摘要：页码 + 原文片段（单行、截断）。 */
function evidenceOf(f) {
  const ev = f.evidence?.[0];
  if (!ev) return '';
  const quote = String(ev.quote ?? '').replace(/\s+/g, ' ').slice(0, 160);
  return `p${ev.page}｜${quote}`;
}

/** 排序用的键→序号表。找不到的键一律返回一个很大的数，靠稳定排序保持原有相对次序。 */
function orderIndexer(lists) {
  const map = new Map();
  lists.filter(Boolean).forEach((list) => {
    (list ?? []).forEach((k, i) => { if (!map.has(k)) map.set(k, map.size); });
  });
  const big = map.size + 100000;
  return (key) => (map.has(key) ? map.get(key) : big);
}

/**
 * 构建导出表。
 *
 * @param {object} p
 * @param {string} p.year
 * @param {string} p.study
 * @param {{id:string,title:string,fields:any[]}[]} p.groups  服务端 /api/fields 的 groups
 * @param {object} [p.order]      服务端 /api/fields 的 sheets.order（用于按原始列序排）
 * @param {Record<string,string>} [p.headerOf]  规范键 → 原始表头
 * @param {string[]} [p.reviewers] 已知核对人（固定列；缺省时从字段里现收）
 * @param {object} [p.summary]     reviewSummary() 的结果（核对汇总表用）
 * @param {string} [p.generatedAt]
 * @returns {{ sheets: {name:string, rows:any[][], widths:number[]}[], csv: string, columns: string[] }}
 */
export function buildReviewExport(p) {
  const { year, study, groups, order, headerOf, summary } = p;
  const generatedAt = p.generatedAt ?? new Date().toISOString();

  // 核对人列：以服务端给的顺序为准，再把字段里出现过的补上（防止某人的记录只在别处出现）
  const reviewers = [...(p.reviewers ?? [])];
  for (const g of groups ?? []) {
    for (const f of g.fields ?? []) {
      for (const o of f.reviews ?? []) if (!reviewers.includes(o.reviewer)) reviewers.push(o.reviewer);
    }
  }

  const columns = [...HEAD_BASE, ...reviewers.flatMap(REVIEW_HEAD), ...HEAD_TAIL];
  const widths = [10, 18, 22, 26, 34, 26, 40,
    ...reviewers.flatMap(() => [18, 8, 20]), 12, 24, 8];

  const idx1 = orderIndexer([order?.sheet1?.article, order?.sheet1?.comparison]);
  const idx2 = orderIndexer([order?.sheet2]);
  const idx3 = orderIndexer([order?.sheet3?.top]);

  /** 三张数据表：{ 序号 → 行数组 }。 */
  const dataRows = { 1: [], 2: [], 3: [] };
  /**
   * 待仲裁清单。
   *
   * ⚠️ 这里**从字段视图现取**，而不是用 `summary.consensus.disputed`:
   * 那份汇总是在"没有机器值"的前提下算出来的（`buildConsensus({}, …)`），
   * 它的 `machineRaw` 恒为 null —— 仲裁表里会出现「机器值：（无）」这种误导性内容。
   * 字段视图里有真实的机器值，从这儿取才对。
   */
  const disputedList = [];

  for (const g of groups ?? []) {
    const sheet = sheetOfGroup(g.id);
    if (!sheet) continue;
    const idx = sheet === 1 ? idx1 : sheet === 2 ? idx2 : idx3;

    const fields = [...(g.fields ?? [])].sort((a, b) => idx(keyOf(a)) - idx(keyOf(b)));
    for (const f of fields) {
      const status = f.reviewStatus ?? 'machine-only';
      const disputed = status === 'disputed';
      const byReviewer = new Map((f.reviews ?? []).map((o) => [o.reviewer, o]));

      const cells = [
        `Sheet${sheet}`,
        g.title ?? '',
        f.label ?? keyOf(f),
        headerFor(f, headerOf),
        f.fieldPath,
        machineRawOf(f),
        evidenceOf(f),
      ];
      for (const r of reviewers) {
        const o = byReviewer.get(r);
        cells.push(o?.raw ?? '', o ? (ACTION_ZH[o.action] ?? o.action) : '', o?.note ?? '');
      }
      cells.push(STATUS_ZH[status] ?? status, f.raw ?? '', f.overridden ? '是' : '');

      // 有分歧的行整行标红——医生打开文件要一眼找到需要仲裁的地方
      dataRows[sheet].push(disputed ? cells.map((v) => ({ v, s: 3 })) : cells);
      if (disputed) {
        disputedList.push({
          fieldPath: f.fieldPath,
          machineRaw: machineRawOf(f) || '（无）',
          opinions: (f.reviews ?? []).map((o) => ({ reviewer: o.reviewer, raw: o.raw })),
        });
      }
    }
  }

  /** 核对汇总表（封面）：进度 + 分歧清单 + 两两一致率。 */
  const rows = [
    ['指标', '值'],
    ['研究', `${year} / ${study}`],
    ['导出时间', generatedAt],
    ['核对人', reviewers.length ? reviewers.join('、') : '（无）'],
  ];
  const st = summary?.consensus?.stats;
  if (st) {
    rows.push(
      ['字段总数', String(st.total)],
      ['已核对', String(st.reviewed)],
      ['　一致', String(st.agreed)],
      ['　有分歧', String(st.disputed)],
      ['　仅一人核对', String(st.single)],
      ['未核对', String(st.machineOnly)],
      ['已生效的人工改动', String(st.changed)],
    );
  }
  rows.push(['', '']);
  rows.push(['核对人', '条数', '确认', '修改', '补录', '最后提交']);
  for (const r of summary?.reviewers ?? []) {
    rows.push([r.reviewer, String(r.total), String(r.confirmed), String(r.overridden), String(r.added), r.updatedAt ?? '']);
  }
  rows.push(['', '']);
  rows.push(['两两一致率', '共同字段', '一致', '分歧', '一致率']);
  for (const a of summary?.consensus?.pairwise ?? []) {
    rows.push([`${a.reviewerA} ↔ ${a.reviewerB}`, String(a.common), String(a.same), String(a.disputed),
      a.rate === null ? '（无共同字段）' : `${(a.rate * 100).toFixed(1)}%`]);
  }
  rows.push(['', '']);
  rows.push(['待第三方仲裁', '', '', '']);
  rows.push(['fieldPath', '机器值', '核对人', '意见']);
  for (const d of disputedList.sort((a, b) => a.fieldPath.localeCompare(b.fieldPath))) {
    if (!d.opinions.length) rows.push([d.fieldPath, d.machineRaw, '', '']);
    else for (const o of d.opinions) rows.push([d.fieldPath, d.machineRaw, o.reviewer, o.raw]);
  }

  const sheets = [
    { name: '核对汇总', rows, widths: [34, 22, 20, 16, 12, 24] },
    { name: 'Sheet1', rows: [columns, ...dataRows[1]], widths },
    { name: 'Sheet2', rows: [columns, ...dataRows[2]], widths },
    { name: 'Sheet3', rows: [columns, ...dataRows[3]], widths },
  ];

  return { sheets, csv: toCsv([columns, ...dataRows[1], ...dataRows[2], ...dataRows[3]]), columns };
}

/* ------------------------------ CSV ------------------------------ */

/** 单元格 → CSV 字段（含逗号/引号/换行时加引号，内部引号翻倍）。 */
function csvCell(v) {
  const s = String((v && typeof v === 'object' ? v.v : v) ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 行数组 → CSV 文本。
 *
 * ⚠️ 带 UTF-8 BOM：不带的话 Excel 打开中文全是乱码（项目里已踩过一次，
 * 见 accuracy_overview.mjs 里关于 PowerShell 写 BOM 的注释）。
 * 但这里返回的是**字符串**、由调用方决定编码，所以 BOM 在 `csvBuffer()` 里加。
 */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** CSV 文本 → 带 BOM 的 Buffer（直接落盘 / 直接回给浏览器）。 */
export function csvBuffer(text) {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
}

/** 导出文件名（去掉研究号里的前导 `-`，与 annotations 的命名一致）。 */
export function exportFileName(year, study, ext, stamp = new Date()) {
  const d = stamp.toISOString().slice(0, 10);
  return `人工核对_${year}_${String(study).replace(/^-+/, '')}_${d}.${ext}`;
}
