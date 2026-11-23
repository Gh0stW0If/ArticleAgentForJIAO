/**
 * tools/export_review.mjs — 把「字段视图 + 各核对人记录」摊成可导出的表
 *
 * 用途：医生要拿文件做人机核对，所以需要"一键导出"。
 * 输出两种格式，**列结构完全一致**（XLSX 只是把三张表分成三个工作表）：
 *   · XLSX —— 给人看：每个字段一行，每位核对人三列（值 / 动作 / 备注），有分歧的行标红
 *   · CSV  —— 给程序/AI 读：三张表拼成一张，首列 `工作表` 区分
 *
 * 支持**单篇**与**批量**（一个年份 / 全部年份）：批量时每行多带 `年份` / `研究` 两列，
 * 方便在 Excel 里筛选与透视。
 *
 * 设计取舍：
 *  1. **一位核对人三列**，不是一人一列拼字符串——机器要能按列取值，人也一眼看得清。
 *  2. **列结构两种格式保持一致**：同一份数据换个壳，比对与 diff 才不会打架。
 *  3. 只做"摊平"，不重新取数：输入就是服务端已经算好的字段视图（groups/order/headerOf），
 *     因此导出的内容**必然与界面上看到的一致**，不会出现"页面一个值、文件另一个值"。
 *  4. **汇总自己算**，不依赖外部传进来的 summary——批量导出时没有单篇 summary 可用，
 *     而这里本来就走过了每个字段，顺手统计比再传一份口径更不容易对不上。
 *
 * ⚠️ 「导回」功能（`tools/import_review.mjs`）读的就是本文件产出的列名。
 *    改列名 = 破坏已发出的文件的可导回性，**必须同步改那边的表头常量**。
 */

import { createHash } from 'node:crypto';

/** 动作 → 中文。 */
const ACTION_ZH = { confirm: '确认', override: '修改', add: '补录' };

/** 核对状态 → 中文。缺省（没人碰过）算「未核对」。 */
const STATUS_ZH = {
  agreed: '一致',
  disputed: '有分歧',
  single: '仅一人核对',
  'machine-only': '未核对',
};

/*
 * ===== 列定义（导回侧按这些**表头文字**定位，见 tools/import_review.mjs）=====
 *
 * ⚠️ 不要随手改这里的字符串：已经发出去的文件就是靠它们导回的。
 *    真要改，得同时兼容旧表头。
 */
export const BASE_COLUMNS = ['工作表', '年份', '研究', '所在行', '字段', '原始列', 'fieldPath', '机器值', '机器证据'];
export const TAIL_COLUMNS = ['核对状态', '采用值', '是否改动'];
export const reviewerColumns = (r) => [`${r} · 值`, `${r} · 动作`, `${r} · 备注`];

/**
 * 签名块的标记。
 *
 * CSV 里是**行首注释**：`# AA-REVIEW-SIGNATURE {…}`；
 * XLSX 里是「签名」工作表的 **A1**（B1 放 JSON）。
 * 两边用同一个标记，读写由 `tools/import_review.mjs` 的 `readSignature` 负责。
 */
export const SIG_TAG = 'AA-REVIEW-SIGNATURE';
export const SIG_SHEET = '签名';

/** 动作的中文（导回时反向用）。 */
export const ACTION_ZH_MAP = ACTION_ZH;
/** 反向：中文 → 动作。 */
export const ZH_ACTION = { 确认: 'confirm', 修改: 'override', 补录: 'add' };

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
    (list ?? []).forEach((k) => { if (!map.has(k)) map.set(k, map.size); });
  });
  const big = map.size + 100000;
  return (key) => (map.has(key) ? map.get(key) : big);
}

/* ------------------------------ 签名 ------------------------------ */

/**
 * 签名块自身的校验和。
 *
 * ⚠️ **这不是防篡改签名**——文件本来就是拿去给人编辑的，任何数据哈希都必然失效。
 * 它的作用只有一个：发现**签名块本身**被表格软件顺手改坏（日期被格式化、
 * 名字前后多了空格之类），避免导回时按一个坏掉的署名去记账。
 * 真要防伪得用带密钥的 MAC，而密钥不该放在客户端。
 */
function sumOf(core) {
  return createHash('sha256')
    .update(JSON.stringify(core, Object.keys(core).sort()))
    .digest('hex')
    .slice(0, 16);
}

/** 构造签名块。`signer` 是**导出人**（= 导出时界面上的核对人）。 */
export function makeSignature(p) {
  const core = {
    v: 1,
    signer: String(p.signer ?? ''),
    at: p.at ?? new Date().toISOString(),
    scope: p.scope ?? 'study',
    label: p.label ?? '',
    studies: p.studies ?? 0,
    rows: p.rows ?? 0,
    reviewers: p.reviewers ?? [],
    cols: p.cols ?? 0,
  };
  return { ...core, sum: sumOf(core) };
}

/** 校验和是否对得上（只说明签名块没被改坏，不说明文件没被编辑）。 */
export function verifySignature(sig) {
  if (!sig || typeof sig !== 'object') return false;
  const { sum, ...core } = sig;
  return typeof sum === 'string' && sum === sumOf(core);
}

/** CSV 里的签名行。 */
export const signatureLine = (sig) => `# ${SIG_TAG} ${JSON.stringify(sig)}`;

/**
 * 构建导出表。
 *
 * @param {object} p
 * @param {string} [p.label]       导出范围的文字（汇总表标题用）
 * @param {'study'|'year'|'all'} [p.scope]
 * @param {string} [p.signer]      **导出人**（= 导出时界面上的核对人）。给空则不带签名
 * @param {{year:string, study:string, groups:any[], order?:object, headerOf?:object}[]} p.subjects
 *        一个或多个研究。批量导出时按传入顺序排列。
 * @param {{keep:number, drop:number, disputed:number, none:number,
 *          rows:{year:string, study:string, index:number, name:string, decision:string,
 *                opinions:{reviewer:string, decision:string}[]}[]}} [p.adjudication]
 *        结局行人工裁定汇总。**被丢弃的行应当已从 `subjects[].groups` 里剔除**
 *        （本函数只负责在汇总页留痕，不做过滤——过滤在调用方做，那里才知道行号）。
 * @param {string} [p.generatedAt]
 * @returns {{ sheets:{name:string,rows:any[][],widths:number[]}[], csv:string, columns:string[], stats:object, signature:object|null }}
 */
export function buildReviewExport(p) {
  const subjects = p.subjects ?? [];
  const generatedAt = p.generatedAt ?? new Date().toISOString();

  // 核对人列：所有研究里出现过的核对人的并集，**按名字排序**（中文走拼音序）。
  // 排序而不是"首次出现顺序"：列顺序要跨研究、跨多次导出都稳定，
  // 否则导出的表与「导回」的表头对不上（见 tools/import_review.mjs 的表头契约）。
  const reviewers = [];
  for (const s of subjects) {
    for (const g of s.groups ?? []) {
      for (const f of g.fields ?? []) {
        for (const o of f.reviews ?? []) if (!reviewers.includes(o.reviewer)) reviewers.push(o.reviewer);
      }
    }
  }
  reviewers.sort((a, b) => a.localeCompare(b));

  const columns = [...BASE_COLUMNS, ...reviewers.flatMap(reviewerColumns), ...TAIL_COLUMNS];
  const widths = [10, 8, 18, 18, 22, 26, 34, 26, 40,
    ...reviewers.flatMap(() => [18, 8, 20]), 12, 24, 8];

  const dataRows = { 1: [], 2: [], 3: [] };
  /** 待仲裁清单（从字段视图现取，那里有真实机器值）。 */
  const disputedList = [];
  /** 逐字段的意见（跨研究要加前缀，否则不同研究的同名字段会串）。 */
  const opinionsByField = new Map();
  const perReviewer = new Map();
  const stats = { total: 0, agreed: 0, disputed: 0, single: 0, machineOnly: 0, reviewed: 0, changed: 0 };

  for (const s of subjects) {
    const idx1 = orderIndexer([s.order?.sheet1?.article, s.order?.sheet1?.comparison]);
    const idx2 = orderIndexer([s.order?.sheet2]);
    const idx3 = orderIndexer([s.order?.sheet3?.top]);

    for (const g of s.groups ?? []) {
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
          s.year ?? '',
          s.study ?? '',
          g.title ?? '',
          f.label ?? keyOf(f),
          headerFor(f, s.headerOf),
          f.fieldPath,
          machineRawOf(f),
          evidenceOf(f),
        ];
        for (const r of reviewers) {
          const o = byReviewer.get(r);
          cells.push(o?.raw ?? '', o ? (ACTION_ZH[o.action] ?? o.action) : '', o?.note ?? '');
        }
        const isChange = Boolean(f.overridden);
        cells.push(STATUS_ZH[status] ?? status, f.raw ?? '', isChange ? '是' : '');

        // 有分歧的行整行标红——医生打开文件要一眼找到需要仲裁的地方
        dataRows[sheet].push(disputed ? cells.map((v) => ({ v, s: 3 })) : cells);

        // ---- 统计（自己算，不依赖外部 summary）----
        stats.total += 1;
        if (status === 'agreed') stats.agreed += 1;
        else if (status === 'disputed') stats.disputed += 1;
        else if (status === 'single') stats.single += 1;
        else stats.machineOnly += 1;
        if (isChange) stats.changed += 1;

        const fkey = `${s.year ?? ''}/${s.study ?? ''}::${f.fieldPath}`;
        if (f.reviews?.length) {
          opinionsByField.set(fkey, new Map(f.reviews.map((o) => [o.reviewer, String(o.raw ?? '')])));
        }
        for (const o of f.reviews ?? []) {
          const cur = perReviewer.get(o.reviewer) ?? { total: 0, confirmed: 0, overridden: 0, added: 0 };
          cur.total += 1;
          if (o.action === 'confirm') cur.confirmed += 1;
          else if (o.action === 'add') cur.added += 1;
          else cur.overridden += 1;
          perReviewer.set(o.reviewer, cur);
        }

        if (disputed) {
          disputedList.push({
            year: s.year ?? '',
            study: s.study ?? '',
            fieldPath: f.fieldPath,
            machineRaw: machineRawOf(f) || '（无）',
            opinions: (f.reviews ?? []).map((o) => ({ reviewer: o.reviewer, raw: o.raw })),
          });
        }
      }
    }
  }

  stats.reviewed = stats.agreed + stats.disputed + stats.single;

  /* ---- 两两一致率：只用「两人都表过态」的字段做分母 ---- */
  const pairwise = [];
  for (let i = 0; i < reviewers.length; i++) {
    for (let j = i + 1; j < reviewers.length; j++) {
      const A = reviewers[i];
      const B = reviewers[j];
      let common = 0;
      let same = 0;
      for (const m of opinionsByField.values()) {
        if (!m.has(A) || !m.has(B)) continue;
        common += 1;
        if (m.get(A) === m.get(B)) same += 1;
      }
      pairwise.push({ a: A, b: B, common, same, disputed: common - same, rate: common ? same / common : null });
    }
  }

  /* ---- 核对汇总（封面）---- */
  const rows = [
    ['指标', '值'],
    ['导出范围', p.label ?? '（未标注）'],
    ['研究数', String(subjects.length)],
    ['导出时间', generatedAt],
    ['核对人', reviewers.length ? reviewers.join('、') : '（无）'],
    ['字段总数', String(stats.total)],
    ['已核对', String(stats.reviewed)],
    ['　一致', String(stats.agreed)],
    ['　有分歧', String(stats.disputed)],
    ['　仅一人核对', String(stats.single)],
    ['未核对', String(stats.machineOnly)],
    ['已生效的人工改动', String(stats.changed)],
    ['', ''],
    ['核对人', '条数', '确认', '修改', '补录'],
  ];
  for (const [r, v] of [...perReviewer.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    rows.push([r, String(v.total), String(v.confirmed), String(v.overridden), String(v.added)]);
  }
  rows.push(['', '']);
  rows.push(['两两一致率', '共同字段', '一致', '分歧', '一致率']);
  for (const a of pairwise) {
    rows.push([`${a.a} ↔ ${a.b}`, String(a.common), String(a.same), String(a.disputed),
      a.rate === null ? '（无共同字段）' : `${(a.rate * 100).toFixed(1)}%`]);
  }
  rows.push(['', '']);
  /*
   * 结局行人工裁定（覆盖率口径的配套）。
   *
   * 覆盖率口径下"流水线抽了、金标准没要"的结局行**不判错**，留不留由人定；
   * 被丢弃的行**不进 Sheet3**（那才是裁定的实际意义），但必须在汇总页留痕——
   * 否则表格少了几行，看表的人不知道是没抽到还是被裁掉了。
   */
  const adj = p.adjudication;
  if (adj) {
    rows.push(['结局行裁定（金标准没要的行）', '', '', '', '']);
    rows.push(['保留', String(adj.keep ?? 0), '丢弃', String(adj.drop ?? 0), '未裁定', String(adj.none ?? 0)]);
    if (adj.disputed) rows.push(['⚠ 核对人有分歧（按保留处理，待仲裁）', String(adj.disputed)]);
    rows.push(['', '']);
    rows.push(['年份', '研究', '结局行', '结局名', '裁定', '核对人']);
    for (const d of adj.rows ?? []) {
      rows.push([d.year, d.study, String((d.index ?? 0) + 1), d.name, d.decision === 'drop' ? '丢弃' : '保留',
        (d.opinions ?? []).map((o) => `${o.reviewer}:${o.decision === 'drop' ? '丢弃' : '保留'}`).join('、') || '（未裁定）']);
    }
  }
  rows.push(['', '']);
  rows.push(['待第三方仲裁', '', '', '', '']);
  rows.push(['年份', '研究', 'fieldPath', '机器值', '核对人', '意见']);
  for (const d of disputedList.sort((x, y) =>
    `${x.year}${x.study}${x.fieldPath}`.localeCompare(`${y.year}${y.study}${y.fieldPath}`))) {
    if (!d.opinions.length) rows.push([d.year, d.study, d.fieldPath, d.machineRaw, '', '']);
    else for (const o of d.opinions) rows.push([d.year, d.study, d.fieldPath, d.machineRaw, o.reviewer, o.raw]);
  }

  const sheets = [
    { name: '核对汇总', rows, widths: [34, 22, 20, 16, 12, 24] },
    { name: 'Sheet1', rows: [columns, ...dataRows[1]], widths },
    { name: 'Sheet2', rows: [columns, ...dataRows[2]], widths },
    { name: 'Sheet3', rows: [columns, ...dataRows[3]], widths },
  ];

  /* ---- 签名 ---- */
  /*
   * 数据行数在签名里要如实记（导出后被改了多少行，一比对就知道），
   * 所以签名只能在这里构造——调用方在构建前拿不到行数。
   */
  const dataRowCount = dataRows[1].length + dataRows[2].length + dataRows[3].length;
  const signature = p.signer
    ? makeSignature({
      signer: p.signer,
      at: generatedAt,
      scope: p.scope ?? 'study',
      label: p.label ?? '',
      studies: subjects.length,
      rows: dataRowCount,
      reviewers,
      cols: columns.length,
    })
    : null;

  if (signature) {
    // 放最后：前面四张是给人用的，签名是元数据
    sheets.push({
      name: SIG_SHEET,
      rows: [
        [SIG_TAG, JSON.stringify(signature)],
        ['项目', '值'],
        ['导出人', signature.signer],
        ['导出时间', signature.at],
        ['导出范围', signature.scope === 'all' ? '全部年份' : (signature.scope === 'year' ? '整年' : '单篇')],
        ['范围标签', signature.label],
        ['研究数', String(signature.studies)],
        ['数据行数', String(signature.rows)],
        ['核对人列', signature.reviewers.join('、') || '（无）'],
        ['校验和', signature.sum],
        ['说明', '校验和只用来发现签名块被表格软件改坏；文件本来就是要编辑的，所以它不是防篡改签名。'],
      ],
      widths: [22, 96],
    });
  }

  const csvBody = toCsv([columns, ...dataRows[1], ...dataRows[2], ...dataRows[3]]);
  return {
    sheets,
    // CSV 没有工作表，签名以行首注释的形式放在最前面
    csv: signature ? `${signatureLine(signature)}\r\n${csvBody}` : csvBody,
    columns,
    stats,
    pairwise,
    signature,
  };
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
 * ⚠️ 带 UTF-8 BOM 由 `csvBuffer()` 负责（不带的话 Excel 打开中文全是乱码）。
 * 这里只产出文本，编码交给调用方。
 */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** CSV 文本 → 带 BOM 的 Buffer（直接落盘 / 直接回给浏览器）。 */
export function csvBuffer(text) {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
}

/**
 * 导出文件名。
 * @param {string} label 范围标签，如 `2015_2015-01` / `2015_全部` / `全部年份`
 */
export function exportFileName(label, ext, stamp = new Date()) {
  const d = stamp.toISOString().slice(0, 10);
  const safe = String(label).replace(/[\\/:*?"<>|]/g, '_');
  return `人工核对_${safe}_${d}.${ext}`;
}
