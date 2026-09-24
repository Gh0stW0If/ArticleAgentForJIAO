/**
 * 金标准字段 ↔ 原始 Excel 列 的完整对照表。
 *
 * 数据来源（都是本地已生成的产物，不改动 `Datas/`）：
 *   · `build/gold/<year>.json`
 *       - `field_definitions`：每层的字段键 + 原始中文表头（labels）
 *       - `column_map.sheet1.{article,comparison}[key].{col,header,legend}`（col 是 0 基列索引）
 *       - `field_definitions.outcome_top_map / block_field_map / timepoint_blocks`（Sheet3 列的语义）
 *   · `build/legend/<year>.json`：按真实 Excel 解析出的列字母 + 第 1..5 行表头 + 编码表
 *
 * 输出：
 *   · `docs/22-gold-column-map.md`     人读的对照文档
 *   · `build/gold_column_map.json`     机器可读
 *
 * 用法：node tools/gold_column_map.mjs [--year 2020] [--json]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ANCHOR = arg('year', '2020');            // 表头/图例文本以这一年为准
const AS_JSON = argv.includes('--json');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const colLetter = (i) => {
  let s = ''; let n = Number(i);
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
};
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const golds = new Map();
const legends = new Map();
for (const y of YEARS) {
  golds.set(y, load(join(ROOT, 'build', 'gold', `${y}.json`)));
  legends.set(y, load(join(ROOT, 'build', 'legend', `${y}.json`)));
}
const anchorGold = golds.get(ANCHOR) ?? [...golds.values()].find(Boolean);
const anchorLegend = legends.get(ANCHOR) ?? [...legends.values()].find(Boolean);

/* ── 1. Sheet1：文章级 / 比较组级 ── */
const sheet1 = { article: [], comparison: [] };
for (const lvl of ['article', 'comparison']) {
  const seen = new Map();
  for (const y of YEARS) {
    const g = golds.get(y);
    const m = g?.column_map?.sheet1?.[lvl];
    if (!m) continue;
    for (const [key, v] of Object.entries(m)) {
      if (key.startsWith('__')) continue;
      const rec = seen.get(key) ?? { key, cols: {}, header: '', legend: '', labels: [] };
      if (v?.col !== undefined) rec.cols[y] = v.col;
      if (v?.header && !rec.header) rec.header = v.header;
      if (v?.legend && !rec.legend) rec.legend = v.legend;
      seen.set(key, rec);
    }
  }
  /* 原始中文 labels（以 anchor 年为准，缺则任取一年） */
  const defs = anchorGold?.field_definitions?.[lvl] ?? [];
  const labelOf = new Map(defs.map((d) => [d.key, d.labels ?? []]));
  for (const y of YEARS) {
    for (const d of golds.get(y)?.field_definitions?.[lvl] ?? []) {
      if (!labelOf.has(d.key)) labelOf.set(d.key, d.labels ?? []);
    }
  }
  /* 与 legend 对齐：拿真实列字母 + 第 1..2 行表头 + 编码表 */
  const lgFields = anchorLegend?.sheets?.Sheet1?.fields ?? [];
  for (const rec of seen.values()) {
    rec.labels = labelOf.get(rec.key) ?? [];
    const lf = lgFields.find((f) => f.field === rec.header)
      ?? lgFields.find((f) => (f.headerLabels ?? []).some((h) => h.text === rec.header))
      ?? lgFields.find((f) => rec.labels.includes(f.field));
    if (lf) {
      rec.legendField = lf.field;
      rec.colLetter = lf.col;
      rec.headerLabels = (lf.headerLabels ?? []).map((h) => h.text);
      rec.codes = lf.codes ?? null;
    }
    rec.colAnchor = rec.cols[ANCHOR] !== undefined ? colLetter(rec.cols[ANCHOR]) : undefined;
    rec.colVariants = [...new Set(Object.values(rec.cols).map(colLetter))];
  }
  sheet1[lvl] = [...seen.values()];
}

/* ── 2. Sheet2：study 级 ── */
const study = [];
{
  const labelOf = new Map();
  for (const y of YEARS) for (const d of golds.get(y)?.field_definitions?.study ?? []) if (!labelOf.has(d.key)) labelOf.set(d.key, d.labels ?? []);
  for (const [key, labels] of labelOf) {
    const cols = {};
    let first = null;
    for (const y of YEARS) {
      const f = (legends.get(y)?.sheets?.Sheet2?.fields ?? []).find((x) => labels.includes(x.field));
      if (!f) continue;
      cols[y] = f.col;
      first ??= f;
    }
    study.push({ key, labels, colLetter: first?.col, cols, header: first?.field, codes: first?.codes ?? null });
  }
}

/* ── 3. Sheet3：结局行 ── */
const fd = anchorGold?.field_definitions ?? {};
const lgS3 = anchorLegend?.sheets?.Sheet3?.fields ?? [];
const byCode = new Map();
for (const f of lgS3) {
  const hdrs = (f.headerLabels ?? []).map((h) => h.text);
  const code = hdrs[hdrs.length - 1];
  if (code) byCode.set(code, { code, col: f.col, field: f.field, headers: hdrs.slice(0, -1), codes: f.codes ?? null });
}
const outcomeTop = Object.entries(fd.outcome_top_map ?? {}).map(([code, key]) => ({
  code, key, ...(byCode.get(code) ?? {}),
}));
const blockField = fd.block_field_map ?? {};
const blocks = fd.timepoint_blocks ?? {};
const timepointCols = [];
for (const [letter, b] of Object.entries(blocks)) {
  for (const [suffix, key] of Object.entries(blockField)) {
    /*
     * 等级资料块的列代码多一个 `R`（Rank）：`block_field_map` 写 `DINFRI`，
     * 真实 Excel 列是 `BRDINFRI`。所以两种拼法都要试。
     */
    const hit = byCode.get(`${letter}${suffix}`) ?? byCode.get(`${letter}R${suffix}`);
    if (hit) timepointCols.push({ ...hit, block: b.name, blockLabel: b.label, code: hit.code ?? `${letter}R${suffix}`, key: `${b.name}.${key}` });
  }
}

/* ── 4. 列位置跨年漂移 ── */
const drift = [];
for (const lvl of ['article', 'comparison']) {
  for (const r of sheet1[lvl]) {
    if (r.colVariants.length > 1) drift.push({ level: lvl, key: r.key, header: r.header, variants: r.colVariants, cols: r.cols });
  }
}

/* ── 4b. 覆盖核对：原始表里有、但金标准 json 没收录的列 ── */
const usedLegendFields = new Set();
for (const lvl of ['article', 'comparison']) for (const r of sheet1[lvl]) if (r.legendField) usedLegendFields.add(r.legendField);
const uncoveredSheet1 = (anchorLegend?.sheets?.Sheet1?.fields ?? [])
  .filter((f) => !usedLegendFields.has(f.field))
  .map((f) => ({ col: f.col, field: f.field, codes: f.codes ? Object.keys(f.codes).length : 0 }));
const usedS3Codes = new Set([...outcomeTop.map((r) => r.code), ...timepointCols.map((r) => r.code)]);
const uncoveredSheet3 = lgS3
  .map((f) => {
    const hdrs = (f.headerLabels ?? []).map((h) => h.text);
    return { col: f.col, code: hdrs[hdrs.length - 1], field: f.field };
  })
  .filter((r) => r.code && !usedS3Codes.has(r.code));

/* ── 5. 两版布局：2015–2019 vs 2020–2025 ── */
const layoutByYear = {};
for (const lvl of ['article', 'comparison']) {
  for (const r of sheet1[lvl]) for (const [y, c] of Object.entries(r.cols)) (layoutByYear[y] ??= {})[r.key] = colLetter(c);
}
const early = sheet1.comparison.find((r) => r.key === 'intervention');
const late = Object.entries(early?.cols ?? {});
const layoutShift = early ? { key: 'intervention', perYear: late.map(([y, c]) => `${y}:${colLetter(c)}`).join(' ') } : null;

/* ── 输出 ── */
const payload = { anchorYear: ANCHOR, sheet1, study, outcomeTop, timepointCols, drift, blocks, blockField, uncoveredSheet1, uncoveredSheet3, layoutByYear };
writeFileSync(join(ROOT, 'build', 'gold_column_map.json'), JSON.stringify(payload, null, 1), 'utf8');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const L = [];
L.push('# 金标准字段 ↔ 原始表格列 对照表');
L.push('');
L.push('> 由 `tools/gold_column_map.mjs` 生成（数据源：`build/gold/<year>.json` + `build/legend/<year>.json`）。');
L.push(`> 列字母/中文表头/编码表以 **${ANCHOR}** 年文件为准；列号随年份有漂移，见 §6。`);
L.push('');
L.push('## 0. 三层结构（行粒度已对原始 xlsx 逐行核实）');
L.push('');
L.push('| 金标准层 | 原始工作表 | **一行 = 什么** | 2020 实例 | 说明 |');
L.push('|---|---|---|---|---|');
L.push('| `article.*` | **Sheet1 左半**（2020 版 A–V 列） | —— | 20 篇文章 | 文章元信息 |');
L.push('| `comparison.*` | **Sheet1 右半**（W–CK 列） | **1 个比较组** | 27 行 → 20 篇 | 与文章级**同一张表同一行**，靠列区分；多臂文章用编号后缀区分（`2020-02-01` / `2020-02-02`） |');
L.push('| `study.*` | **Sheet2** | **1 篇文章** | 20 行 → 20 篇 | 结局分类（文本） |');
L.push('| `outcome.*` / `followUp.*` / `timepoints.*` | **Sheet3** | **1 个（比较组 × 结局）** | 132 行 → 27 个 study_id | 5 行表头、152 列、列名是英文代码；同一 id 多行即多个结局 |');
L.push('');
L.push('**逐行实测**（`tools/_sheet_rowcount.mjs`）：');
L.push('');
L.push('| 年 | 篇数 | Sheet1 数据行（=比较组） | Sheet2 数据行 | Sheet3 数据行（=结局） |');
L.push('|---|---|---|---|---|');
L.push('| 2015 | 6 | 9 | 6 | 22 |');
L.push('| 2019 | 19 | 25 | 19 | 72 |');
L.push('| 2020 | 20 | 27 | 20 | 132 |');
L.push('| 2025 | 33（32 个编号） | 40 | 33（32 个编号） | 166 |');
L.push('');
L.push('> ⚠️ `2025-02` 是**两篇论文共用一个编号**（Sheet1 第 4、5 行、Sheet2 第 3、4 行），');
L.push('> 见 `docs/21` §6.1 —— 所以 2025 的 Sheet3 行数 ≠ 篇数×结局数 的直觉算法。');
L.push('> 另外 Sheet3 的「一行」绑定的是**某个比较组**，靠 `文献编号` 的 `-01/-02` 后缀区分（2020 起如此）。');
L.push('');
L.push('## 1. Sheet1 · 文章级');
L.push('');
L.push('| 列 | 原始表头 | 金标准键 | 编码表/图例 |');
L.push('|---|---|---|---|');
for (const r of sheet1.article) L.push(`| ${r.colAnchor ?? '?'} | ${esc(r.header || (r.labels[0] ?? ''))} | \`${r.key}\` | ${esc(r.codes ? JSON.stringify(r.codes) : (r.legend || '')).slice(0, 120)} |`);
L.push('');
L.push('## 2. Sheet1 · 比较组级');
L.push('');
L.push('| 列 | 原始表头 | 金标准键 | 编码表/图例 |');
L.push('|---|---|---|---|');
for (const r of sheet1.comparison) L.push(`| ${r.colAnchor ?? '?'} | ${esc(r.header || (r.labels[0] ?? ''))} | \`${r.key}\` | ${esc(r.codes ? JSON.stringify(r.codes) : (r.legend || '')).slice(0, 120)} |`);
L.push('');
L.push('## 3. Sheet2 · study 级（结局分类）');
L.push('');
L.push('| 列（2015） | 列（2016+） | 原始表头 | 金标准键 |');
L.push('|---|---|---|---|');
for (const r of study) {
  const early = r.cols['2015'] ?? '—';
  const late = r.cols['2020'] ?? '—';
  L.push(`| ${early} | ${late} | ${esc(r.header || (r.labels[0] ?? ''))} | \`${r.key}\` |`);
}
L.push('');
L.push('> ⚠️ Sheet2 也是**两版布局**：2015 比 2016 起多一列 `提取人`（D），2016 起所有列左移一位。'
  + '`extractor` 只在 2015 的表里有列 —— 所以它显示为「—」。');
L.push('');
L.push('## 4. Sheet3 · 结局自身列');
L.push('');
L.push('| 列 | 列代码 | 原始表头 | 金标准键（我们评测用的名字） | 编码表 |');
L.push('|---|---|---|---|---|');
for (const r of outcomeTop) {
  const evalName = String(r.key).replace(/^outcome\./, 'outcome.').replace(/^follow_up\./, 'followUp.');
  L.push(`| ${r.col ?? '?'} | \`${r.code}\` | ${esc(r.field)} | \`${evalName}\` | ${esc(r.codes ? JSON.stringify(r.codes) : '').slice(0, 100)} |`);
}
L.push('');
L.push('## 5. Sheet3 · 三个时点块的列（B / E / F 前缀）');
L.push('');
L.push('列的命名规则：**块字母 + 字段码**。');
L.push('');
for (const [letter, b] of Object.entries(blocks)) L.push(`- \`${letter}\` = **${b.label}**（\`${b.name}\`）`);
L.push('');
L.push('| 列 | 列代码 | 原始表头（分组/字段） | 评测里的字段名 |');
L.push('|---|---|---|---|');
for (const r of timepointCols) L.push(`| ${r.col} | \`${r.code}\` | ${esc(r.headers.join(' / '))} | \`${r.key}\` |`);
L.push('');
L.push('## 6. 列位置跨年漂移：**两版布局**');
L.push('');
L.push('原始表格在 2019 → 2020 之间**删掉了一列**，之后所有列左移一位。所以同一个字段在两版里列号不同：');
L.push('');
L.push('| 层 | 原始表头 | 键 | 2015–2019 | 2020–2025 |');
L.push('|---|---|---|---|---|');
for (const d of drift.slice(0, 24)) {
  const early = d.variants[0]; const late = d.variants[d.variants.length - 1];
  L.push(`| ${d.level} | ${esc(d.header)} | \`${d.key}\` | ${early} | ${late} |`);
}
L.push('');
L.push(`共 **${drift.length}** 个字段受影响（列名不变、列号变）。完整清单见 \`build/gold_column_map.json\` 的 \`drift\`。`);
L.push('');
L.push('> 例外：`文献编号` 始终在 **A** 列（它是第一列，不受移位影响）。');
L.push('');
L.push('## 7. 覆盖核对：原始表里有、但金标准 json 没收录的列');
L.push('');
L.push(`Sheet1 未被收录 **${uncoveredSheet1.length}** 列：`);
L.push('');
L.push('| 列 | 原始表头 | 编码数 |');
L.push('|---|---|---|');
for (const r of uncoveredSheet1) L.push(`| ${r.col} | ${esc(r.field)} | ${r.codes} |`);
L.push('');
L.push(`Sheet3 未被收录 **${uncoveredSheet3.length}** 列（前 30）：`);
L.push('');
L.push('| 列 | 列代码 | 原始表头 |');
L.push('|---|---|---|');
for (const r of uncoveredSheet3.slice(0, 30)) L.push(`| ${r.col} | \`${r.code}\` | ${esc(r.field)} |`);
L.push('');
L.push('## 8. 与 `tools/canonical-field-map.mjs` 的关系（⚠️ 批注引用是旧版布局）');
L.push('');
L.push('- 提示词/编码器的真源是 **`tools/canonical-field-map.mjs`**（人工维护），不是自动提取的 legend。');
L.push('  `legendFor()` 在 `LEGENDS` 未命中时回退到它；`totalSessionsClassB` 只有 `desc`、**没有 `codes`** ——');
L.push('  这就是 `docs/21` §2.1 那个"整列 0%"的直接原因，修就在这一行。');
L.push('- 它里面的 `comment`（如 `N2`、`K2`、`D1`）用的是 **2015–2019 版布局**：');
L.push('  2020 起整体左移一列，所以 2020–2025 的「依据：单元格批注 X2」会指到隔壁列（如 `authorContact` 写 N2、实际 M2）。');
L.push('- 各年真值：见 `build/gold_column_map.json` 的 `layoutByYear`。');
L.push('');
L.push('### 8.1 报告生成器的列字母（已修）');
L.push('');
L.push('`tools/lib/field_labels.mjs` 负责把字段名翻成"工作簿第几列"，给医生的报告全靠它。它曾有两处**整体偏差**：');
L.push('');
L.push('| 问题 | 原因 | 修法 |');
L.push('|---|---|---|');
L.push('| Sheet1 的列字母是 **2015–2019 版**布局 | 合并各年定义时"先出现的优先"，2015 排最前 | 改成"最新年份优先"，并附注旧版字母 |');
L.push('| Sheet3 的列字母**少算一位**（如 OUTCOM 写成 H 列，真实 I 列） | 用 `anchorCol + outcome_columns.indexOf(code)` 推算，而 `outcome_columns`（151 项）漏了 `OI` 列（工作表共 152 列） | 改以 **legend 的真实单元格坐标**为准，推算只作兜底（兜底时补回 OI 那一列） |');
L.push('');
L.push('验证：`node tools/_label_check.mjs`（逐字段打印列字母）。');
L.push('');
L.push('## 9. ⚠️ 评测口径提醒');
L.push('');
L.push('- 时点块里的 `experimental` / `control` 两组，在 `tools/llm_eval.mjs` 里**共用同一个字段名**');
L.push('  （递归时不改 `scope`），所以 `end_of_treatment.continuous.estimate` 这类字段是**两组合并**的统计，不是单组。');
L.push('- `followUp.*`（结局级随访三列）在原始表里是 Sheet3 的 **DB/DC/DD**，与 `comparison.max_followup_*`（Sheet1 的 BP/BQ/BR）**不是同一列**。');
L.push('- `comparison.analyzed_n_experimental/_control` 的列名与内容不符（列名 analyzed N、内容为脱落人数），见 `docs/21` §6。');
L.push('- ⚠️ **`binary.difference_*` 的组名写错了**：`tools/gold_schema.mjs:96-98` 把 Sheet3 的');
L.push('  `DEST`/`DLVAR`/`DUVAR`（原始表头「组间差值的估计值 / 变异值（下限/上限）」）映射成 `binary.difference_*`，');
L.push('  但这三列在表里位于**连续型变量**区块中（前接 `BNCONT` 对照组例数、后接 `BINEVE` 二分类事件数）。');
L.push('  实测 **151 个时点块**里这三列装的**全是连续型均数差**（BDI 均数差 `-1.56`、EQ-5D `-0.01`、FSS `-0.43`），');
L.push('  同块二分类计数全为空 → 应归 `continuous.difference_*`。金标准与流水线用的是同一套名字，**不影响评分**，但命名误导。');
L.push('');
writeFileSync(join(ROOT, 'docs', '22-gold-column-map.md'), L.join('\n'), 'utf8');

if (!AS_JSON) {
  const cnt = (a) => a.length;
  console.log(`\n已写入 docs/22-gold-column-map.md 与 build/gold_column_map.json`);
  console.log(`  Sheet1 文章级 ${cnt(sheet1.article)} 列、比较组级 ${cnt(sheet1.comparison)} 列`);
  console.log(`  Sheet2 study 级 ${cnt(study)} 列`);
  console.log(`  Sheet3 结局自身列 ${cnt(outcomeTop)}、时点块列 ${cnt(timepointCols)}`);
  console.log(`  列位置跨年漂移 ${cnt(drift)} 个字段`);
  console.log(`  Sheet1 未收录 ${uncoveredSheet1.length} 列、Sheet3 未收录 ${uncoveredSheet3.length} 列`);
  console.log(`  （两个比较组字段 layoutShift: ${layoutShift?.perYear ?? '—'}）`);
  console.log('  Sheet1 未收录列：' + uncoveredSheet1.map((r) => `${r.col}:${r.field}`).join('、'));
  const miss = [...sheet1.article, ...sheet1.comparison].filter((r) => !r.colLetter);
  if (miss.length) console.log(`  ⚠ 未能与 legend 对上的字段 ${miss.length} 个：${miss.map((m) => m.key).join(', ')}`);
  console.log('\n── Sheet1 比较组级（节选）──');
  for (const r of sheet1.comparison.slice(0, 6)) console.log(`  ${r.colAnchor} ${String(r.header).padEnd(24)} ${r.key}`);
}
