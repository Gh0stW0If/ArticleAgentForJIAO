/**
 * 把"提取用字段名"翻译成**原始工作簿里的列名**。
 *
 * 为什么要它：给医生看的报告里出现 `end_of_treatment.binary.n`、`comparison.randomization_method`
 * 这种键，医生无法对照自己的工作簿。每个字段都必须能回答"这是表格里的哪一列"。
 *
 * 数据来源：`build/gold/<year>.json` 的 `field_definitions` 与 `column_map`——
 * 它们是**从原始 xlsx 里读出来的**（列头文字、列号、批注取值表），不是我们另起的名字。
 *   · Sheet1：`column_map.sheet1.{article,comparison}[key] = { col, header }`
 *   · Sheet2：`field_definitions.study[key].labels[0]`
 *   · Sheet3：列码 = 时点前缀（B/E/F）+ 块内后缀码（`block_field_map` 反查），
 *     列字母 = `anchorCol + outcome_columns.indexOf(列码)`
 *
 * 用法：
 *   const labels = createFieldLabels(rootDir);
 *   labels.describe('comparison.randomization_method') // → { where: 'Sheet1 比较组', names: ['随机序列产生方法'] }
 *   labels.describe('end_of_treatment.binary.n')       // → { where: 'Sheet3 疗程结束时', names: ['试验组例数（列 EINUM）', '对照组例数（列 ECNUM）'] }
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { indexToCol } from './xlsx.mjs';

/** 块内路径 → 中文列名（Sheet3 的列码是缩写，医生看不懂 IESTI 这类字符）。 */
const BLOCK_FIELD_ZH = {
  'continuous.estimate_type': '效应量类型',
  'continuous.variance_type': '变异值类型',
  'continuous.experimental.estimate': '试验组效应量',
  'continuous.experimental.ci_lower': '试验组变异值下限',
  'continuous.experimental.ci_upper': '试验组变异值上限',
  'continuous.experimental.n': '试验组例数',
  'continuous.control.estimate': '对照组效应量',
  'continuous.control.ci_lower': '对照组变异值下限',
  'continuous.control.ci_upper': '对照组变异值上限',
  'continuous.control.n': '对照组例数',
  'binary.difference_estimate': '组间差值',
  'binary.difference_ci_lower': '组间差值下限',
  'binary.difference_ci_upper': '组间差值上限',
  'binary.experimental.events': '试验组事件数',
  'binary.experimental.n': '试验组例数',
  'binary.control.events': '对照组事件数',
  'binary.control.n': '对照组例数',
  'binary.or': 'OR 值', 'binary.or_ci_lower': 'OR 下限', 'binary.or_ci_upper': 'OR 上限',
  'binary.rr': 'RR 值', 'binary.rr_ci_lower': 'RR 下限', 'binary.rr_ci_upper': 'RR 上限',
  'binary.rd': 'RD 值', 'binary.rd_ci_lower': 'RD 下限', 'binary.rd_ci_upper': 'RD 上限',
  'binary.hr': 'HR 值', 'binary.hr_ci_lower': 'HR 下限', 'binary.hr_ci_upper': 'HR 上限',
  'categorical.classification_method': '等级资料分类方法',
  'categorical.experimental.n': '试验组例数',
  'categorical.control.n': '对照组例数',
};

/** 结局级（Sheet3 上半部分）的常见列码中文名。 */
const TOP_FIELD_ZH = {
  'outcome.construct_code': '结局类别',
  'outcome.subconstruct_code': '结局子类',
  'outcome.p_value_range': 'P 值所属区间',
  'outcome.p_value': 'P 值',
  'outcome.name': '结局名称',
  'outcome.instrument': '测量工具',
  'outcome.measurement_range': '量表取值范围',
  'outcome.measurement_direction': '测量方向',
  'outcome.measurement_type': '数据类型',
  'outcome.measurement_unit': '测量单位',
  'outcome.baseline_adjusted': '是否对基线做调整',
  'outcome.primary_outcome_timepoint': '主要结局测量时点',
  'outcome.special_data_flag': '特殊数据情况',
  'outcome.special_category': '特殊数据分类',
  'follow_up.description': '最长随访时间（描述）',
  'follow_up.value': '最长随访时间（数值）',
  'follow_up.unit': '最长随访时间（单位）',
  'literature_code': '文献编号(带结局序号)',
  'arm_number': '研究组别的数量',
};

/** 时点块内的叶子名 → 中文（用于 `outcome.timepoints.<叶子>` 这种"跨时点"的记账）。 */
const LEAF_ZH = {
  n: '例数', estimate: '效应量', ci_lower: '变异值下限', ci_upper: '变异值上限',
  estimate_type: '效应量类型', variance_type: '变异值类型', events: '事件数',
  difference: '组间差值', difference_estimate: '组间差值',
  difference_ci_lower: '组间差值下限', difference_ci_upper: '组间差值上限',
  or: 'OR 值', rr: 'RR 值', rd: 'RD 值', hr: 'HR 值',
  cat1: '第 1 类人数', cat2: '第 2 类人数', cat3: '第 3 类人数',
  cat4: '第 4 类人数', cat5: '第 5 类人数', cat6: '第 6 类人数',
};

/**
 * 工作簿里就是英文列头的少数几列：给一个中文注解，避免报告里突然冒出英文。
 * 名字仍以工作簿为准（括号里注明原列头），不替换。
 */
const HEADER_ZH = {
  'outliers and influential observations': '离群值与影响力分析（原表列头为英文）',
};

const stripJudged = (key) => String(key ?? '').replace(/^judged\./, '');

export function createFieldLabels(rootDir) {
  const goldDir = join(rootDir, 'build', 'gold');
  const legendDir = join(rootDir, 'build', 'legend');
  const years = existsSync(goldDir)
    ? readdirSync(goldDir).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.replace('.json', '')).sort()
    : [];

  /*
   * ⚠️ 原始工作簿有**两版布局**：2015–2019 比 2020–2025 多一列（Sheet1 的 construct），
   * 于是同一个字段的列字母在两版里差一位。报告里必须给**当前版（最新年份）**的字母，
   * 需要时再补一句"旧版为第 X 列"。
   */
  const NEWEST = years[years.length - 1] ?? null;

  /* 合并所有年份的定义：**最新年份优先**（列字母以当前版布局为准）。 */
  const sheet1 = { article: new Map(), comparison: new Map() };
  const study = new Map();
  const topMap = new Map();        // 列码 → 规范路径
  const blockMap = new Map();      // 块内路径 → 列码（不含时点前缀）
  const tpBlocks = new Map();      // 'baseline' → 'B'
  const tpLabels = new Map();      // 'baseline' → '基线期'
  let outcomeColumns = [];
  let anchorCol = 1;

  for (const y of [...years].reverse()) {
    let g;
    try { g = JSON.parse(readFileSync(join(goldDir, `${y}.json`), 'utf8')); } catch { continue; }
    const fd = g.field_definitions ?? {};
    const cm = g.column_map ?? {};
    for (const [scope, map] of [['article', sheet1.article], ['comparison', sheet1.comparison]]) {
      for (const [k, v] of Object.entries(cm.sheet1?.[scope] ?? {})) {
        if (k.startsWith('__')) continue;
        const col = v.col;
        if (!map.has(k)) map.set(k, { header: v.header ?? '', col, letters: new Map(), legend: v.legend ?? '' });
        const rec = map.get(k);
        if (col !== null && col !== undefined) rec.letters.set(y, indexToCol(col));
      }
      for (const d of fd[scope] ?? []) {
        if (!map.has(d.key)) map.set(d.key, { header: (d.labels ?? [])[0] ?? d.key, col: null, letters: new Map(), legend: '' });
      }
    }
    for (const d of fd.study ?? []) if (!study.has(d.key)) study.set(d.key, (d.labels ?? [])[0] ?? d.key);
    for (const [code, path] of Object.entries(fd.outcome_top_map ?? {})) if (!topMap.has(code)) topMap.set(code, path);
    for (const [code, path] of Object.entries(fd.block_field_map ?? {})) if (!blockMap.has(path)) blockMap.set(path, code);
    for (const [letter, v] of Object.entries(fd.timepoint_blocks ?? {})) {
      if (v?.name && !tpBlocks.has(v.name)) tpBlocks.set(v.name, letter);
    }
    for (const [name, label] of Object.entries(fd.timepoint_block_labels ?? {})) {
      if (!tpLabels.has(name)) tpLabels.set(name, label);
    }
    if (fd.outcome_columns?.length) outcomeColumns = fd.outcome_columns;
    if (cm.sheet3?.anchorCol !== undefined) anchorCol = cm.sheet3.anchorCol;
  }

  /*
   * Sheet3 的列码 → 列字母：**以 legend 为准**（legend 是从真实 xlsx 的单元格坐标读出来的）。
   *
   * ⚠️ 不能靠 `anchorCol + outcome_columns.indexOf(code)` 推算：`outcome_columns` 有 151 项，
   * 而工作表有 152 列 —— 中间的 `OI` 列没进清单，于是从第二列起全部**少算一位**
   * （实测 OUTCOM 会被写成 H 列，真实是 I 列；2020–2025 与 2015–2019 都差这一位）。
   * 推算只作为 legend 缺失时的兜底。
   */
  const codeLetters = new Map();   // code -> Map<year, letter>
  const studyLetters = new Map();  // study 字段键 -> Map<year, letter>
  /* study 键 → 原始列头（可能多个，如 primary_outcome 有"主要结局或第1个出现的患者重要结局"与"主要结局(英文)"） */
  const studyLabels = new Map();
  for (const y of years) {
    let g2;
    try { g2 = JSON.parse(readFileSync(join(goldDir, `${y}.json`), 'utf8')); } catch { continue; }
    for (const d of g2.field_definitions?.study ?? []) {
      const prev = studyLabels.get(d.key) ?? [];
      studyLabels.set(d.key, [...new Set([...prev, ...(d.labels ?? [])])]);
    }
  }
  for (const y of years) {
    let lg;
    try { lg = JSON.parse(readFileSync(join(legendDir, `${y}.json`), 'utf8')); } catch { continue; }
    for (const f of lg.sheets?.Sheet3?.fields ?? []) {
      const hdrs = (f.headerLabels ?? []).map((h) => h.text);
      const code = hdrs[hdrs.length - 1];
      if (!code || !f.col) continue;
      if (!codeLetters.has(code)) codeLetters.set(code, new Map());
      codeLetters.get(code).set(y, f.col);
    }
    for (const f of lg.sheets?.Sheet2?.fields ?? []) {
      if (!f.col) continue;
      for (const [k, labels] of studyLabels) {
        if (!(labels ?? []).includes(f.field)) continue;
        if (!studyLetters.has(k)) studyLetters.set(k, new Map());
        studyLetters.get(k).set(y, f.col);
      }
    }
  }
  /** study 字段的列字母（含旧版） */
  const studyColText = (k) => {
    const m = studyLetters.get(k);
    if (!m?.size) return '';
    const primary = m.get(NEWEST) ?? [...m.values()][m.size - 1];
    const others = [...new Set([...m.values()])].filter((l) => l !== primary);
    return `（${withAlt({ others }, `第 ${primary} 列`)}）`;
  };
  /** 某一列码在各年的字母：{ primary, others } */
  const lettersOf = (code) => {
    const byYear = codeLetters.get(code);
    if (byYear?.size) {
      const primary = byYear.get(NEWEST) ?? [...byYear.values()][byYear.size - 1];
      const others = [...new Set([...byYear.values()])].filter((l) => l !== primary);
      return { primary, others };
    }
    const i = outcomeColumns.indexOf(code);
    if (i < 0) return { primary: null, others: [] };
    /* 兜底：补回被漏掉的 OI 列（它排在 STUDYID 之后） */
    return { primary: indexToCol(anchorCol + i + (i >= 1 ? 1 : 0)), others: [] };
  };
  const colLetter = (code) => lettersOf(code).primary;
  const withAlt = (letters, base) => (letters.others.length ? `${base}；旧版布局为第 ${letters.others.join(' / ')} 列` : base);

  /**
   * 把"时点前缀 + 块内后缀码"解析成真实列码。
   *
   * ⚠️ 不能直接拼：`block_field_map` 给的是**规范码**，与工作簿里的真实列码并不总是一致——
   * 等级资料那几列，规范码是 `DINFRI`，工作簿里却是 `BRDINFRI`/`ERDINFRI`/`FRDINFRI`（多了个 R）。
   * 先试直拼，再退化为"同前缀、同后缀"的列码。
   */
  const resolveCode = (prefix, suffix) => {
    const direct = `${prefix}${suffix}`;
    if (!outcomeColumns.length || outcomeColumns.includes(direct)) return direct;
    return outcomeColumns.find((c) => c.startsWith(prefix) && c.endsWith(suffix)) ?? direct;
  };

  /** 后缀码 → 中文名（块内路径来自 block_field_map，是权威的规范路径）。 */
  const zhOf = (suffix) => {
    const path = [...blockMap.entries()].find(([, code]) => code === suffix)?.[0];
    if (!path) return suffix;
    const m = /^categorical\.(experimental|control)\.cat(\d)$/.exec(path);
    if (m) return `${m[1] === 'experimental' ? '试验组' : '对照组'}第 ${m[2]} 类人数`;
    return BLOCK_FIELD_ZH[path] ?? path;
  };

  /** 「中文名（列 XXX／第 Y 列）」 */
  const blockName = (prefix, suffix) => {
    const code = resolveCode(prefix, suffix);
    const lt = lettersOf(code);
    return `${zhOf(suffix)}（列 ${code}${lt.primary ? `／${withAlt(lt, `第 ${lt.primary} 列`)}` : ''}）`;
  };

  /**
   * 描述一个评测字段键。返回 `{ where, names }`：
   *   where —— 属于哪张表、哪一层（如 `Sheet3 疗程结束时`）
   *   names —— 原始表格里的列名（可能多个：如 `binary.n` 同时指试验组与对照组的例数列）
   */
  const describe = (rawKey) => {
    const key = stripJudged(rawKey);
    /* Sheet2：study.* */
    if (key.startsWith('study.')) {
      const k = key.slice('study.'.length);
      const label = study.get(k) ?? k;
      return { where: 'Sheet2 结局分类', names: [`${label}${studyColText(k)}`] };
    }
    /* Sheet1：article.* / comparison.* */
    for (const [scope, zh] of [['article', 'Sheet1 文章级'], ['comparison', 'Sheet1 比较组']]) {
      if (!key.startsWith(`${scope}.`)) continue;
      const k = key.slice(scope.length + 1);
      const hit = sheet1[scope].get(k);
      const header = hit?.header ?? '';
      const shown = HEADER_ZH[header] ?? header;
      const letters = [...new Set([...(hit?.letters?.values() ?? [])])];
      const primary = letters.length ? (hit.letters.get(NEWEST) ?? letters[letters.length - 1]) : null;
      const others = letters.filter((l) => l !== primary);
      const colTxt = primary ? `（${withAlt({ others }, `第 ${primary} 列`)}）` : '';
      return { where: zh, names: [shown ? `${shown}${colTxt}` : k] };
    }
    /* Sheet3：<时点>.<块>.<字段> */
    const parts = key.split('.');
    const tp = parts[0];
    if (tpBlocks.has(tp) || tp === 'timepoints') {
      const where = `Sheet3 ${tpLabels.get(tp) ?? tp}`;
      const rest = parts.slice(1).join('.');
      const prefix = tpBlocks.get(tp) ?? '';
      const names = [];
      /* ① 块内路径直接命中（如 binary.difference_estimate） */
      const direct = blockMap.get(rest);
      if (direct) names.push(blockName(prefix, direct));
      /* ② 复合叶子（如 binary.n / binary.events）→ 试验组、对照组各一列 */
      if (!names.length) {
        const suffix = rest.split('.').pop();
        const kind = parts[1] ?? '';
        const cands = [...blockMap.entries()]
          .filter(([p]) => p.startsWith(`${kind}.`) && p.endsWith(`.${suffix}`))
          .map(([, code]) => code);
        for (const code of cands) names.push(blockName(prefix, code));
      }
      return { where, names: names.length ? names : [rest] };
    }
    /* Sheet3 上半部分（结局级）：outcome.xxx / follow_up.xxx / 顶层键 */
    /*
     * 注意 `outcome.description|value|unit` 这三键：金标准排查工具按"结局层"记账，
     * 但工作簿里的规范路径是 `follow_up.*`（列 FOLTIM/FOLTIMN/FOLTIMU）。
     * 不转换就会显示成没有列名的裸键。
     */
    const alias = /^outcome\.(description|value|unit)$/.test(key)
      ? `follow_up.${key.split('.')[1]}`
      : key;
    /* 跨时点的叶子（`outcome.timepoints.n`）——每个时点各有一列，无法只指一列 */
    const tleaf = /^(?:outcome\.)?timepoints\.(\w+)$/.exec(key);
    if (tleaf) {
      const zh = LEAF_ZH[tleaf[1]] ?? tleaf[1];
      const codes = [...blockMap.entries()]
        .filter(([p]) => p.endsWith(`.${tleaf[1]}`))
        .map(([, code]) => code);
      const uniq = [...new Set(codes)].slice(0, 4).join(' / ');
      return { where: 'Sheet3 结局级', names: [`${zh}（基线/疗程结束/随访各一列${uniq ? `：${uniq} 等` : ''}）`] };
    }
    if (key.startsWith('outcome.') || alias.startsWith('follow_up.')) {
      const k = alias;
      /*
       * `outcome_top_map` 里的路径**不完全带 `outcome.` 前缀**（如 STDATA → `special_data_flag`），
       * 所以两种写法都要试，否则这一列会显示成没有列名的裸键。
       */
      const code = [...topMap.entries()].find(([, p]) => p === k)?.[0]
        ?? [...topMap.entries()].find(([, p]) => p === k.replace(/^outcome\./, ''))?.[0];
      const zh = TOP_FIELD_ZH[k] ?? TOP_FIELD_ZH[k.replace(/^outcome\./, 'outcome.')] ?? k;
      const lt = code ? lettersOf(code) : null;
      return { where: 'Sheet3 结局级', names: [code && lt?.primary ? `${zh}（列 ${code}／${withAlt(lt, `第 ${lt.primary} 列`)}）` : zh] };
    }
    if (TOP_FIELD_ZH[key]) {
      const code = [...topMap.entries()].find(([, p]) => p === key)?.[0];
      const lt = code ? lettersOf(code) : null;
      return { where: 'Sheet3 结局级', names: [code && lt?.primary ? `${TOP_FIELD_ZH[key]}（列 ${code}／${withAlt(lt, `第 ${lt.primary} 列`)}）` : TOP_FIELD_ZH[key]] };
    }
    return { where: '—', names: [key] };
  };

  /** 一行文字：`Sheet1 比较组 · 随机序列产生方法（第 X 列）` */
  const line = (key) => {
    const d = describe(key);
    return `${d.where} · ${d.names.join(' / ')}`;
  };

  return { describe, line, size: sheet1.article.size + sheet1.comparison.size + study.size };
}
