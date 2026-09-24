/**
 * 生成**给临床医生看的讨论报告**（`build/report/医生讨论报告.md`）。
 *
 * 面向读者：做系统评价的临床研究者（不是工程师）。因此：
 *   · 不出现 prompt / skill / JSON / 缓存 这类实现细节；
 *   · 术语用循证医学的常用说法（ITT、符合方案集、95%CI、结局、时点…）；
 *   · 每个结论都给出**可核对的例子**（哪篇、哪个结局、金标准写的是什么、原文是什么）；
 *   · 需要医生拍板的地方，给"现状 → 我们的疑问 → 建议选项"，而不是只报错。
 *
 * 数据来源（都在 build/ 下，不触碰 Datas/）：
 *   build/eval/<year>.json            逐年评测结果（准确率、逐字段明细）
 *   build/gold_anomalies.json         金标准值级/字段级疑似错位
 *   build/gold_row_anomalies.json     金标准整行串篇（结局名在本篇找不到）
 *
 * 用法：node tools/report_clinicians.mjs [--out 路径]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studiesFromPdfNames } from '../packages/core/dist/index.js';
import { createFieldLabels } from './lib/field_labels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let OUT = 'build/report/医生讨论报告.md';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') OUT = argv[++i];

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const pct = (s) => {
  const n = s.hit + s['code-hit'] + s.wrong + s.missed;
  return n ? ((s.hit + s['code-hit']) / n) * 100 : 0;
};
const fmt = (v) => `${v.toFixed(1)}%`;

/*
 * 字段名 → 原始工作簿列名。
 * 报告里凡是提到具体字段，都必须同时给出"表格里是哪一列"——只给 `end_of_treatment.binary.n`
 * 这种内部键，医生没法对着自己的工作簿看。
 */
const LABELS = createFieldLabels(ROOT);

/* ------------------------------ 收集 ------------------------------ */

const years = [];
for (const f of existsSync(join(ROOT, 'build', 'eval')) ? readdirSync(join(ROOT, 'build', 'eval')) : []) {
  const m = /^(\d{4})\.json$/.exec(f);
  if (m) years.push(m[1]);
}
years.sort();

const evals = years.map((y) => ({ year: y, rep: readJson(join(ROOT, 'build', 'eval', `${y}.json`)) })).filter((x) => x.rep);
const goldVal = readJson(join(ROOT, 'build', 'gold_anomalies.json'));
const goldRows = readJson(join(ROOT, 'build', 'gold_row_anomalies.json'));

/*
 * Sheet2「备注」列的实测情况：金标准写的是什么、机器有没有填、占 Sheet2 分母多少。
 * 用来支撑"未报告要不要显式填 NR"这一条标准问题——数字都从实际比对结果里取，
 * 不在文案里手写，否则换了年份就过期。
 */
const REMARKS_STAT = (() => {
  let total = 0; let nonNr = 0;
  for (const { year } of evals) {
    const g = readJson(join(ROOT, 'build', 'gold', `${year}.json`));
    for (const a of g?.articles ?? []) {
      const r = a.study?.remarks?.raw;
      if (r === undefined) continue;
      total += 1;
      if (!/^NR$/i.test(String(r).trim())) nonNr += 1;
    }
  }
  let missed = 0; let den = 0;
  for (const { rep } of evals) {
    missed += rep.byField?.['study.remarks']?.missed ?? 0;
    const s2 = sheetStats(rep).sheet2Den;
    den += Number.isFinite(s2) ? s2 : 0;
  }
  return { total, nonNr, missed, den };
})();

/** 每篇研究的金标准文章数（用于说明覆盖率）。 */
function goldCount(y) {
  const g = readJson(join(ROOT, 'build', 'gold', `${y}.json`));
  return g?.articles?.length ?? 0;
}
/** 该年已抽取的研究数。 */
function extractedCount(y) {
  const d = join(ROOT, 'build', 'extraction', y);
  return existsSync(d) ? readdirSync(d).filter((f) => /^\d{4}-\d+\.json$/.test(f)).length : 0;
}

/* ------------------------------ 统计 ------------------------------ */

/**
 * 把一年一次的评测结果归并成"三张表"的口径。
 *
 * Sheet1 = 文章级 + 比较组级；Sheet2 = 结局分类；Sheet3 = 结局 × 时点。
 * 语义判定（自然语言字段）单独列出：它的分母会随"填上的字段变多"而变大，
 * 只看比例会被误导，所以比例与绝对数并列给出。
 */
function sheetStats(rep) {
  const t = rep.total ?? {};
  const sum = (...keys) => keys.reduce((a, k) => {
    const s = t[k] ?? { hit: 0, 'code-hit': 0, wrong: 0, missed: 0, extra: 0 };
    return {
      hit: a.hit + s.hit, 'code-hit': a['code-hit'] + s['code-hit'],
      wrong: a.wrong + s.wrong, missed: a.missed + s.missed, extra: a.extra + s.extra,
    };
  }, { hit: 0, 'code-hit': 0, wrong: 0, missed: 0, extra: 0 });
  const judged = rep.judged ?? [];
  const w = { identical: 1, same_meaning: 1, contains_correct: 0.5, has_error: 0, completely_different: 0 };
  const jScore = judged.reduce((a, j) => a + (w[j.verdict] ?? 0), 0);
  const s2 = sum('study');
  const judgedS1 = judged.filter((j) => /^(article|comparison)\./.test(j.field));
  return {
    sheet1: sum('article', 'comparison'),
    sheet1Judged: judgedS1,
    sheet2: s2,
    sheet2Den: s2.hit + s2['code-hit'] + s2.wrong + s2.missed,
    sheet2Judged: judged.filter((j) => /^study\./.test(j.field)),
    sheet3: sum('outcome'),
    sheet3Judged: judged.filter((j) => !/^(study|article|comparison)\./.test(j.field)),
    jScore, jTotal: judged.length,
  };
}

/* ------------------------------ 报告 ------------------------------ */

const L = [];
const W = (s = '') => L.push(s);

W('# 针刺 RCT 数据提取：机器提取与人工金标准的比对报告');
W();
W(`> 目的：把「机器自动提取」的结果与「人工金标准」逐项比对，用于和临床专家一起确认**提取标准**。`);
W(`> 报告只呈现事实与需要拍板的问题，不涉及实现细节。`);
W(`> **字段命名约定**：凡提到具体字段，都同时给出两个名字——`);
W(`> **原始表格列名**（你们工作簿里的列头，括号里是列字母，如「随机序列产生方法（第 AB 列）」）`);
W(`> 与 **提取用字段名**（我们系统内部的键，如 \`comparison.randomization_method\`，便于在产物文件里检索）。`);
W(`> ⚠️ **列字母以 2020–2025 那版工作簿为准**。2015–2019 的工作簿在文章级区域多一列，`);
W(`> 同一列的字母要**往后顺延一位**（如「治疗总次数」在 2020–2025 是 AZ 列、在 2015–2019 是 BA 列）；`);
W(`> 表里凡是两版不同的，都注明了「旧版布局为第 X 列」。`);
W(`> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
W();

/* ---------- 一、覆盖范围 ---------- */
W('## 一、这次比对覆盖了什么');
W();
W('| 年份 | 语料论文数 | 金标准论文数 | 已完成机器提取 | 已比对 |');
W('|---|---|---|---|---|');
let totPdf = 0; let totGold = 0; let totDone = 0; let totCompanion = 0;
for (const y of Array.from({ length: 11 }, (_, i) => String(2015 + i))) {
  const dir = join(ROOT, 'Datas', 'articles', y);
  /*
   * 语料篇数只数**正文** PDF：目录里还有同篇的附件/分册
   * （`2024-12-01.pdf`、`2022-06-sup.pdf` …），它们不是独立文章，
   * 数进来会让"语料篇数"比"金标准篇数"多出几篇，看起来像数据缺斤少两。
   */
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const { studies, skipped } = studiesFromPdfNames(files);
  const pdf = studies.length;
  const g = goldCount(y);
  const e = extractedCount(y);
  const ev = evals.find((x) => x.year === y) ? '✓' : '';
  totPdf += pdf; totGold += g; totDone += e; totCompanion += skipped.length;
  W(`| ${y} | ${pdf} | ${g} | ${e} | ${ev} |`);
}
W(`| **合计** | **${totPdf}** | **${totGold}** | **${totDone}** | ${evals.length} 个年份 |`);
W();
if (totCompanion) {
  W(`（另有 ${totCompanion} 份同篇附件/分册 PDF——如 \`2024-12-01.pdf\`、\`2022-06-sup.pdf\`——不算独立文章，未计入上表。）`);
  W();
}
if (evals.length === 11) {
  W('说明：11 个年份**全部**完成机器提取与比对，本报告中的数字为全量结果。');
} else {
  W('说明：机器提取是"逐篇独立"进行的，因此**未完成的年份不影响已完成年份的结论**。');
}
W();

/* ---------- 二、准确率总表 ---------- */
W('## 二、准确率（按年份 × 三张表）');
W();
W('三张表对应你们原有的工作簿：');
W();
W('- **Sheet1**：研究基本信息（题目、期刊、随机方法、盲法、针刺操作细节、例数等）');
W('- **Sheet2**：该研究报告了哪几类结局（疼痛 / 非疼痛症状 / 功能 / 生活质量 / 重要事件 / 死亡）');
W('- **Sheet3**：每个结局在每个时点的具体数值（效应量、变异值、例数等）');
W();
W('| 年份 | Sheet1 | Sheet2 | Sheet3 | Sheet3 中的数值类字段 |');
W('|---|---|---|---|---|');

const sheet3Numeric = (rep) => {
  const LEAF = new Set(['estimate', 'ci_lower', 'ci_upper', 'n', 'events', 'difference_estimate',
    'difference_ci_lower', 'difference_ci_upper', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6']);
  const rows = Object.entries(rep.byField ?? {})
    .filter(([k]) => /^(baseline|end_of_treatment|follow_up_end)\./.test(k))
    .filter(([k]) => LEAF.has(k.split('.').pop()));
  const s = rows.reduce((a, [, v]) => ({
    hit: a.hit + v.hit + (v['code-hit'] ?? 0), wrong: a.wrong + v.wrong, missed: a.missed + v.missed,
  }), { hit: 0, wrong: 0, missed: 0 });
  const n = s.hit + s.wrong + s.missed;
  return { ...s, n, rate: n ? (s.hit / n) * 100 : 0 };
};

/** 语义判定得分（完全一致/含义一致=1，包含正确信息=0.5，其余=0）。 */
const judgedScore = (items) => items.reduce(
  (a, j) => a + ({ identical: 1, same_meaning: 1, contains_correct: 0.5 }[j.verdict] ?? 0), 0);

for (const { year, rep } of evals) {
  const st = sheetStats(rep);
  const num = sheet3Numeric(rep);
  const s1j = st.sheet1Judged;
  const s1jScore = judgedScore(s1j);
  const s1 = s1j.length
    ? `${fmt(pct(st.sheet1))}（编码/数值）/ ${fmt(s1j.length ? (s1jScore / s1j.length) * 100 : 0)}（描述部分 ${s1jScore.toFixed(1)}/${s1j.length}）`
    : fmt(pct(st.sheet1));
  const s2j = st.sheet2Judged;
  const s2jScore = judgedScore(s2j);
  const s2 = s2j.length
    ? `${fmt(pct(st.sheet2))}（编码部分）/ ${fmt(s2j.length ? (s2jScore / s2j.length) * 100 : 0)}（描述部分 ${s2jScore.toFixed(1)}/${s2j.length}）`
    : fmt(pct(st.sheet2));
  W(`| ${year} | ${s1} | ${s2} | ${fmt(pct(st.sheet3))} | ${fmt(num.rate)}（${num.hit}/${num.n}） |`);
}
W();

if (evals.length) {
  const all = evals.map((x) => sheetStats(x.rep));
  const agg = (k) => {
    const s = all.reduce((a, x) => ({
      hit: a.hit + x[k].hit + x[k]['code-hit'], wrong: a.wrong + x[k].wrong,
      missed: a.missed + x[k].missed, extra: a.extra + x[k].extra,
    }), { hit: 0, wrong: 0, missed: 0, extra: 0 });
    const n = s.hit + s.wrong + s.missed;
    return { ...s, n, rate: n ? (s.hit / n) * 100 : 0 };
  };
  const s1 = agg('sheet1'); const s2 = agg('sheet2'); const s3 = agg('sheet3');
  /* 语义判定（描述性字段）：与严格口径并列给出，绝不合并成一个数 */
  const jAll = all.flatMap((x) => x.sheet1Judged);
  const jS1 = judgedScore(jAll);
  W('**合计（已比对年份）**：');
  W();
  W(`- Sheet1：编码/数值部分 ${fmt(s1.rate)}（比对 ${s1.n} 个字段：对 ${s1.hit} / 错 ${s1.wrong} / 漏 ${s1.missed}；另有"多填"${s1.extra} 个）；`
    + `描述性字段按"含义是否一致"判，得分 **${fmt(jAll.length ? (jS1 / jAll.length) * 100 : 0)}**（${jS1.toFixed(1)}/${jAll.length}）`);
  W(`- Sheet2：${fmt(s2.rate)}（${s2.n} 个字段：对 ${s2.hit} / 错 ${s2.wrong} / 漏 ${s2.missed}）`);
  W(`- Sheet3：${fmt(s3.rate)}（${s3.n} 个字段：对 ${s3.hit} / 错 ${s3.wrong} / 漏 ${s3.missed}；"多填"${s3.extra} 个）`);
  W();
  W('> "多填"不计入准确率分母：机器多提取的结局/时点，人工可以裁掉；**漏掉的才需要回头补**。');
  W('> Sheet1 分两段看：**编码/数值字段逐字比对**，**描述性字段（干预方法、对照组、随机方法、疗程、频次等）'
    + '按"含义是否一致"判定**——金标准常抄整句、机器抄要点，逐字比对会把同一句话判成两回事。');
  W();
  if (REMARKS_STAT.missed > 0) {
    const altN = s2.n - REMARKS_STAT.missed;
    W(`> Sheet2 的 ${s2.missed} 处"漏"里有 **${REMARKS_STAT.missed} 处来自"备注"列**：`);
    W('> 金标准这一列在已比对年份里全部填的是 `NR`（没有真正的备注内容）。'
      + (REMARKS_STAT.missed <= 2 ? '机器已按"没有内容就填 NR"输出，这一列此前是整列漏抽，现已基本对齐。' : '机器目前仍未输出该列。'));
    W(`> 若这几处按"等价的未报告"处理，**Sheet2 为 ${fmt(altN ? (s2.hit / altN) * 100 : 0)}**（${s2.hit}/${altN}）。`);
    W('> 这一列到底怎么算，见 §5.19。');
    W();
  }

  /*
   * 最常出错的字段。
   *
   * 对医生来说，"哪个字段最容易错"比"总体多少分"更有用：它直接指向
   * "这个字段的定义需要再讲清楚"，而不是笼统地说"机器不行"。
   * 只列出现次数 ≥ 20 的字段，避免小样本噪声。
   */
  const merged = new Map();
  for (const { rep } of evals) {
    for (const [k, s] of Object.entries(rep.byField ?? {})) {
      const cur = merged.get(k) ?? { hit: 0, 'code-hit': 0, wrong: 0, missed: 0 };
      cur.hit += s.hit ?? 0; cur['code-hit'] += s['code-hit'] ?? 0;
      cur.wrong += s.wrong ?? 0; cur.missed += s.missed ?? 0;
      merged.set(k, cur);
    }
  }
  const worst = [...merged.entries()]
    .map(([k, s]) => ({ k, ...s, n: s.hit + s['code-hit'] + s.wrong + s.missed }))
    .filter((x) => x.n >= 20)
    .sort((a, b) => (a.hit / a.n) - (b.hit / b.n))
    .slice(0, 15);
  if (worst.length) {
    W('### 2.1 最容易出错的字段（出现 ≥20 次，按正确率升序）');
    W();
    W('> 每个字段给两行名字：**原始表格列名**（你们工作簿里的列头，括号里是列字母）与**提取用的字段名**'
      + '（我们系统内部用的键，便于你们在产物文件里检索）。');
    W();
    W('| 原始表格列名 | 提取用字段名 | 正确率 | 对 / 错 / 漏 | 这一列是什么意思 |');
    W('|---|---|---|---|---|');
    const WHY = {
      'comparison.needle_count_text': '用针数目（原文写法千差万别：有的写穴名清单、有的写范围）',
      'comparison.needle_count_min': '用针数目的最小值',
      'comparison.insertion_depth_text': '进针深度的原文描述',
      'comparison.dropout_total': '脱落/退出总人数',
      'comparison.frequency_class': '治疗频次分类（高低频）',
      'comparison.randomization_method': '随机序列产生方法（原文表述差异大）',
      'comparison.allocation_concealment': '分配隐藏方法',
      'comparison.control_type': '对照组类型编码',
      'comparison.control_type_converted': '对照组类型的换算编码',
      'comparison.blinding_outcome_assessor': '结局评价者是否设盲',
      'comparison.max_followup_value': '最长随访时间的数值',
      'comparison.prior_acupuncture': '既往是否接受过针刺',
      'comparison.patient_expectation': '患者期望值',
      'comparison.deqi': '是否得气',
      'comparison.stimulation_intensity': '刺激强度',
      'article.impact_factor_2019': '期刊 2019 年影响因子（**论文里没有，已改为查 IF-SCI-2019.xlsx**）',
      'article.author_contact': '作者联系方式',
      'article.trial_center_count': '试验中心数量',
      'judged.outcome.p_value': '结局的 P 值（一边有数值、一边写"未报告"，见 §5 相关条目）',
      'judged.outcome.p_value_range': 'P 值所属区间（同上）',
      'outcome.p_value_range': 'P 值所属区间（P<0.05 / P>0.05）',
      'comparison.control': '对照组名称的写法（金标准常在括号里补充说明）',
      'outcome.subconstruct_code': '结局子类编码（分类口径见 §5）',
      'comparison.dropout_total': '脱落/退出总人数',
      'study.remarks': '结局分类的"备注"列（**机器目前不填这一列**；金标准此列全部写 `NR`）',
      'study.primary_outcome': '论文声明的主要结局',
      'study.outcome_mortality': '是否报告了死亡率结局',
      'outcome.primary_outcome_timepoint': '该结局相对主要结局的时点关系',
      'end_of_treatment.binary.n': '二分类（事件）结局**每组的例数**（机器只抽了事件数，没抽例数）',
      'baseline.binary.n': '基线时二分类结局每组的例数（同上）',
      'follow_up_end.binary.n': '随访时二分类结局每组的例数（同上）',
      'baseline.binary.events': '基线时的**事件发生数**（机器基本没抽这一格）',
      'baseline.binary.difference_estimate': '基线时的组间差值（机器没抽；基线本来就不该有组间疗效差，需确认金标准此处是否该填）',
      'baseline.binary.difference_ci_lower': '基线组间差值的区间（同上）',
      'baseline.binary.difference_ci_upper': '基线组间差值的区间（同上）',
      'follow_up_end.binary.events': '随访时的事件发生数（同上）',
      'end_of_treatment.binary.rr': '相对危险度 RR 及其区间（机器目前不抽）',
      'end_of_treatment.binary.rr_ci_lower': 'RR 的 95% 区间（同上）',
      'end_of_treatment.binary.rr_ci_upper': 'RR 的 95% 区间（同上）',
      'follow_up_end.binary.rr': '相对危险度 RR 及其区间（同上）',
    };
    for (const w of worst) {
      const d = LABELS.describe(w.k);
      W(`| ${d.names.join(' / ')} | \`${w.k}\` | ${fmt((w.hit / w.n) * 100)} | ${w.hit} / ${w.wrong} / ${w.missed} | ${WHY[w.k] ?? ''} |`);
    }
    W();
    W('> 读表提示：提取用字段名以 `judged.` 开头的，是**语义判定**那一类的记账（结局名称、P 值写法等自然语言字段），');
    W('> 其余是严格比对（编码 / 数值）的结果；两套分数不合并。');
    W();
    W('> 注意：影响因子这类**论文里根本没有**的列必然全错（现已改为查 IF-SCI-2019.xlsx，见 §2.3），');
    W('> 建议单独处理，不要与"能从论文里读出来的字段"混在一起看。');
    W();

    /*
     * 完全没填过的列：hit=0 且 wrong=0（一处都没抽出来），但金标准有值。
     * 这类不是"抽错"，而是"这一列机器压根没做"——对医生来说是好消息（不涉及理解分歧，
     * 只需要确认是否需要补做），因此单独列出来，不与上面的"抽错"混在一起。
     */
    const never = [...merged.entries()]
      .map(([k, s]) => ({ k, ...s, n: s.hit + s['code-hit'] + s.wrong + s.missed }))
      .filter((x) => x.hit + x['code-hit'] + x.wrong === 0 && x.missed >= 5)
      .sort((a, b) => b.missed - a.missed)
      .slice(0, 12);
    if (never.length) {
      W('### 2.1.1 机器完全没有提取的列（金标准有值，但一处都没抽到）');
      W();
      W('这类不是"抽错了"，而是"这一列/这一格我们目前没有做"。请确认是否需要补做：');
      W();
      W('| 原始表格列名 | 提取用字段名 | 金标准有值 | 说明 |');
      W('|---|---|---|---|');
      for (const x of never) {
        W(`| ${LABELS.describe(x.k).names.join(' / ')} | \`${x.k}\` | ${x.missed} 处 | ${WHY[x.k] ?? ''} |`);
      }
      W();
      /*
       * 补一句"这一类里哪一格最要紧"。数字必须从统计里取：
       * 写死过一次（当时是 64/6/8），随着比对年份变多立刻变成错的。
       */
      const pick = (k) => never.find((x) => x.k === k)?.missed ?? 0;
      const nSum = pick('end_of_treatment.binary.n') + pick('follow_up_end.binary.n') + pick('baseline.binary.n');
      if (nSum > 0) {
        W('> 其中"二分类结局的每组例数"这一项影响最大：金标准在这类结局里同时记了**事件数**与**例数**，');
        W(`> 机器只抽到事件数，例数整格缺失（疗程结束 ${pick('end_of_treatment.binary.n')} 处、`
          + `随访 ${pick('follow_up_end.binary.n')} 处、基线 ${pick('baseline.binary.n')} 处）。`);
        W('> 这不是判断分歧，是漏做，补齐即可；但它会连带影响"率"的核对，建议优先补。');
        W();
      }
    }

    /*
     * 趋势与解读。
     *
     * 这一节是**必须写**的：2015 年是我们做开发时反复调试的年份，它的分数天然偏高，
     * 不能拿它代表整体水平；把这一点说出来，医生才能正确判断"这套自动提取现在能用在哪"。
     */
    W('### 2.2 趋势与解读（请连这一节一起看）');
    W();
    const first = evals.find((e) => e.year === '2015');
    const others = evals.filter((e) => e.year !== '2015');
    if (first && others.length) {
      const f1 = sheetStats(first.rep); const f3 = sheetStats(first.rep);
      const o1 = others.map((o) => sheetStats(o.rep));
      /* 逐篇平均（每年一篇），不是把各年字段数加总——加总会被字段多的年份带偏 */
      const avg = (k, list) => {
        const rs = list.map((x) => pct(x[k]));
        return rs.reduce((a, b) => a + b, 0) / rs.length;
      };
      W(`- **2015 是开发年份**（我们在这一年上反复调试规则），它的分数（Sheet1 ${fmt(pct(f1.sheet1))}、`
        + `Sheet3 ${fmt(pct(f3.sheet3))}）**明显高于**其余 ${others.length} 年的平均（Sheet1 ${fmt(avg('sheet1', o1))}、`
        + `Sheet3 ${fmt(avg('sheet3', o1))}）——这是"在训练样本上考高分"的典型现象。`);
      W('  也就是说：**不要把 2015 的分数当成整体水平**，其余年份的读数更接近真实使用场景。');
    }
    W(`- 主要失分来自两类：**漏**（金标准有、自动提取没抽到）与**错**（抽到了但不对）。`);
    W(`  上面的合计行给出了绝对数——漏的必须补，错的必须改；两类改法不同。`);
    W(`- 描述性字段（结局名称、测量工具、备注等）的正确率明显低于编码字段：`);
    W(`  这不是"读错了"，而是**同一件事的写法不同**（如金标准写 \`fibromyalgia/VAS\`，`
      + `自动提取写 \`pain intensity/PainVAS\`）。这类需要统一写法规范，见第五节。`);
    W('- Sheet3 的"多填"数量很大：自动提取会把结果表里的量表分项也当作独立结局。');
    W('  多填的可以人工裁掉，**不影响漏项**，但会增加复核工作量。');
    W();

    /*
     * 2.3 只看"文章基本信息"（metadata）。
     *
     * 这一节回答一个很实际的问题："如果只做文章级信息，能不能做到九成以上？"
     * 数字全部来自 tools/metadata_ceiling.mjs 的实测（含对外部表/口径/编码表三类修正的分解），
     * 不在这里手写，避免过期。
     */
    const mc = readJson(join(ROOT, 'build', 'metadata_ceiling.json'));
    if (mc?.scenarios?.length) {
      W('### 2.3 只看"文章基本信息"这一块（题目/期刊/作者/资金/病种/国家…）');
      W();
      W(`这一块共 ${mc.total.fields} 个字段 × 224 篇 = ${mc.total.values} 个值。按不同口径算出来的分数：`);
      W();
      W('| 口径 | 准确率 | 说明 |');
      W('|---|---|---|');
      const WHY = {
        '①': '当前口径：**编码/数值字段逐字比对，描述性字段（题目/期刊/作者/联系方式/病种/国家）按"含义是否一致"判定**',
        '②': '发表年份按语料归类年推导、单中心试验填 1 而非 NR——**这两项与"读懂论文"无关**',
        '③': '把取值表与工作簿对齐（离群值分析/资金/国家分类等，见 §5.17）后可再回收',
      };
      /* 说明按"最长前缀匹配"取：否则 `①b` 会命中 `①` 的说明（实测踩过） */
      const whyKeys = Object.keys(WHY).sort((a, b) => b.length - a.length);
      for (const s of mc.scenarios) {
        const key = whyKeys.find((k) => s.label.startsWith(k)) ?? '';
        W(`| ${s.label} | ${fmt(s.rate)} | ${WHY[key] ?? ''} |`);
      }
      W();
      W('**结论**：只做文章基本信息，**九成是可以做到的**，但要同时满足三件事：');
      W(`① 判分要承认"写法差异"——描述性字段已改按"含义是否一致"判定（与结局字段同一口径）；`);
      W(`② 论文里没有的信息（发表年份、单中心例数等）按约定/外部数据补（值 ${mc.gains.externalAndPolicy} 个字段）；`);
      W('③ **§5.17 那几张取值表要由你们确认**——这一项值多少，取决于你们给的表有多准，'
        + `完全对齐时上限是 ${mc.gains.codeTableMax} 个字段（决定最终落在 86% 还是 91%）。`);
      W();
      W('现在还"靠读懂论文才能解决"的错只剩约 '
        + `${mc.residualReadErrors} 个字段（${((mc.residualReadErrors / mc.total.values) * 100).toFixed(0)}%），`
        + '主要是：作者联系方式（金标准常把邮箱按原样抄，含 OCR 空格）、病种归类、随机/盲法描述。');
      W();
      W('各字段现状（按失分数排序，共 18 个）。同样给出两行名字：表格列名 + 提取用字段名：');
      W();
      W('| 原始表格列名 | 提取用字段名 | 正确率 | 对 / 错 / 漏 |');
      W('|---|---|---|---|');
      const fields = Object.entries(mc.perField).sort((a, b) => a[1].rate - b[1].rate);
      for (const [k, v] of fields) {
        const full = `article.${k}`;
        W(`| ${LABELS.describe(full).names.join(' / ')} | \`${full}\` | ${fmt(v.rate)} | ${v.hit} / ${v.wrong} / ${v.missed} |`);
      }
      W();
      W('> 读表提示：**影响因子、发表年份、试验中心数量**这三行不是"读错"，是数据/约定问题；');
      W('> **离群值/影响力分析、资金、国家分类**这几行取决于取值表（§5.17）；');
      W('> 真正需要提升"读懂论文"能力的只有**作者联系方式、疾病名称、随机/盲法描述**等少数几项。');
      W();
    }
  }
}

/* ---------- 三、判定口径 ---------- */
W('## 三、"算对"是怎么判定的（请重点看这一节）');
W();
W('1. **编码类字段**（如"随机方法=2 计算机随机"）：要求**编码完全一致**，写中文或英文描述都算错。');
W('2. **数值类字段**（效应量、95%CI、例数）：按数值比对，允许 `-41` 与 `-41.0` 这类写法差异；');
W('   相差超过 0.5%（或 0.05）即判错。');
W('3. **描述类字段**（结局名称、测量工具、备注等自然语言）：不用字符匹配——写法不同不等于错。');
W('   这类由模型按四级判定：**完全一致 / 含义一致 / 包含正确信息但有出入 / 明显错误**；');
W('   前两级算对，第三级算半分，第四级算错。');
W('4. **结局行的对齐**：金标准一条"结局"与机器一条"结局"按名称+工具对齐；');
W('   两边条数常常不等（金标准 4 条 / 机器 7 条），对不上的金标准行整行计入"漏"。');
W();

/* ---------- 四、疑似金标准问题 ---------- */
W('## 四、疑似金标准本身有问题的条目（需你们复核）');
W();
W('判断依据只有两条，都很硬：');
W();
W('1. **金标准里的这个值，在原文里找不到**（或与原文明显不符）；');
W('2. **金标准自身在同一篇里自相矛盾**（同一件事两处写法/口径不一致）。');
W();
W('以下条目**已从准确率统计中剔除**（只记录、不扣分），请你们逐条确认是"金标准要改"还是"机器理解错"。');
W();

/* 值级 */
const valByYear = {};
for (const a of goldVal?.anomalies ?? []) (valByYear[a.year] ??= []).push(a);
const valTotal = (goldVal?.anomalies ?? []).length;

/**
 * 「该值在原文里找不到」这类发现的**复核结论**。
 *
 * 原始判据是"逐字匹配"，偏严：论文写 `week 24`、`24-week`、小数点被排版吃掉，
 * 都会被判成"找不到"。这些误报如果直接拿去当排除项，准确率会失真（实测 2024 年
 * 487 条里有 250 条其实能在原文里找到）。所以先用 tools/gold_evidence_check.mjs
 * 做一次宽容复核，报告里把三档结论分别交代清楚：
 *   found  → 其实在文中（检索误报，不列为问题）
 *   weak   → 逐位数字能找到、写法可疑（单独列出供参考，不计入问题）
 *   strong → 连逐位数字都找不到（真问题）
 *   unknown→ 该篇没有解析产物，无法复核（按原判据列为问题）
 */
const recheck = readJson(join(ROOT, 'build', 'gold_evidence_check.json'));
const VERDICT_OF = new Map();
for (const it of recheck?.items ?? []) {
  VERDICT_OF.set(`${it.year}|${it.articleId}|${it.scope ?? ''}|${it.field ?? ''}|${String(it.value ?? '').trim()}`, it.verdict);
}
/*
 * ⚠️ 判据要匹配实际的 reason 文案「值未在论文中出现（疑似错误金标准）」。
 * 起初写成 /不在论文|找不到|原文/ —— 与文案对不上，结果这 1900+ 条全掉进"其他"，
 * 复核结论也挂不上去（§4.1 的说明段整段消失）。改判据时请连同 gold_vs_paper.mjs 的
 * REASON 常量一起看。
 */
const ABSENT_RE = /未在论文中|不在论文|找不到|原文/;
const isAbsentReason = (reason = '') => ABSENT_RE.test(reason);
const verdictOf = (a) => VERDICT_OF.get(`${a.year}|${a.articleId}|${a.scope ?? ''}|${a.field ?? ''}|${String(a.value ?? '').trim()}`) ?? 'unknown';

/**
 * 归类 + 去重。
 *
 * 为什么要去重：同一个问题会按"结局行 × 时点"重复报很多遍
 * （例如某篇的 estimate_type 写成了 4，4 条结局各报一次）。给医生看的清单应当
 * 一行一个问题，并给出"出现次数"，否则 260 条里大部分是同一件事的复制。
 */
const KIND_OF = (reason = '') => {
  if (/^影响因子与 IF-SCI-2019/.test(reason)) return '影响因子与 2019 年 JCR 表不一致';
  if (/^金标准期刊名不在/.test(reason)) return '金标准的期刊名本身有问题（影响因子无法核对）';
  if (/编码超出该列取值表/.test(reason)) return '编码不在允许取值内';
  if (/自由文本|列错位/.test(reason)) return '编码列里写成了文字（疑似整列错位）';
  if (ABSENT_RE.test(reason)) return '该值在原文里找不到';
  if (/行号|串|不属于/.test(reason)) return '整行疑似属于别的文献';
  return '其他';
};
const KIND_WHY = {
  '影响因子与 2019 年 JCR 表不一致': '以 Datas/IF-SCI-2019.xlsx（2019 年 SCIE 全刊表）为准，金标准填的数值与表不符（多为偏高，疑为别的年度）。**请确认以哪一年为准**。',
  '金标准的期刊名本身有问题（影响因子无法核对）': '金标准"期刊名称"列填的不是本刊（如把学会名当刊名，或串成别的文章的刊名），影响因子无从核对。',
  '编码不在允许取值内': '该列的取值表里有固定几个编码，金标准填了表外的数字——需要确认是"应新增编码"还是"填错了"。',
  '编码列里写成了文字（疑似整列错位）': '编码列里出现了原文字句（如把"最差情况分析"写进应当填数字的格子）。常见原因是表格列错位，或该列实际允许填文字。',
  '该值在原文里找不到': '机器回到 PDF 原文里检索这个值，连"逐位数字"都找不到——需要确认是原文表述不同，还是这个值来自别处。',
  '整行疑似属于别的文献': '该行结局的名称在这篇论文里完全不存在，很可能是行被串到了别的文献。',
  '其他': '需要人工判断。',
};

const dedup = new Map();
for (const a of goldVal?.anomalies ?? []) {
  const kind = KIND_OF(a.reason);
  const key = `${a.year}|${a.articleId}|${a.scope ?? ''}|${a.field ?? ''}|${String(a.value ?? '').slice(0, 24)}|${kind}`;
  const cur = dedup.get(key);
  if (cur) cur.count++;
  else dedup.set(key, { ...a, kind, count: 1, verdict: isAbsentReason(a.reason) ? verdictOf(a) : null });
}
const allUnique = [...dedup.values()].sort((a, b) => b.count - a.count || a.year.localeCompare(b.year));
/** 真正列为问题的（误报已剔除）。 */
const valUnique = allUnique.filter((v) => !(v.verdict === 'found' || v.verdict === 'weak'));
/** 复核后不算问题的（写法差异 / 逐位数字能找到）。 */
const softUnique = allUnique.filter((v) => v.verdict === 'found' || v.verdict === 'weak');
const absentUnique = allUnique.filter((v) => v.kind === '该值在原文里找不到');
const absentRawCount = absentUnique.reduce((a, v) => a + v.count, 0);

W(`### 4.1 值或编码与规则对不上（原始 ${valTotal} 条记录，去重后 ${valUnique.length} 个问题）`);
W();
if (softUnique.length) {
  W('> 说明：原始记录里有一类是"该值在原文里找不到"。这条判据按**逐字匹配**做的，偏严——');
  W(`> 论文里写成 \`week 24\`／\`24-week\`、小数点被排版吃掉，都会被误判。`);
  W(`> 我们把这类（${absentRawCount} 条记录）**逐条放宽写法重新检索了一遍**：`);
  W(`> · 复核后其实**能在原文里找到**的，不再列为问题（${softUnique.filter((v) => v.verdict === 'found').length} 个）——属检索误报；`);
  W(`> · 逐位数字能找到、但写法仍可疑的，单列在 §4.3 供参考（${softUnique.filter((v) => v.verdict === 'weak').length} 个）；`);
  W(`> · 连逐位数字都找不到的（${absentUnique.filter((v) => v.verdict !== 'found' && v.verdict !== 'weak').length} 个），才作为问题列出。`);
  W();
}

if (valUnique.length) {
  const kindCount = {};
  for (const v of valUnique) kindCount[v.kind] = (kindCount[v.kind] ?? 0) + 1;
  W('先按类型看规模：');
  W();
  W('| 问题类型 | 问题数 | 说明 |');
  W('|---|---|---|');
  for (const [k, n] of Object.entries(kindCount).sort((a, b) => b[1] - a[1])) W(`| ${k} | ${n} | ${KIND_WHY[k] ?? ''} |`);
  W();
  W('逐条清单（按出现次数排序，最多列 40 条）：');
  W();
  W('| 年份 | 篇号 | 原始表格列名 | 提取用字段名 | 金标准填写 | 出现 | 问题类型 |');
  W('|---|---|---|---|---|---|---|');
  for (const v of valUnique.slice(0, 40)) {
    const where = `${v.scope ?? ''}${v.field ? `.${v.field}` : ''}`.replace(/^\./, '');
    W(`| ${v.year} | ${v.articleId} | ${LABELS.describe(where).names.join(' / ')} | \`${where}\` | ${String(v.value ?? '').slice(0, 32)} | ${v.count} | ${v.kind} |`);
  }
  if (valUnique.length > 40) W(`| … | | | | | | 其余 ${valUnique.length - 40} 个问题见 build/gold_anomalies.json |`);
  W();
} else {
  W('（尚未运行金标准排查工具：`pnpm gold:anomalies`）');
  W();
}

/* 整行串篇 */
const rowFindings = goldRows?.findings ?? [];
W(`### 4.2 整行归属可疑（共 ${rowFindings.length} 条）`);
W();
if (rowFindings.length) {
  W('判定方式：某条结局的**结局名称在该篇论文里完全找不到**——这类行很可能是"串到了别的文献"。');
  W();
  W('| 年份 | 篇号 | 行 | 结局名称 | 金标准自带的文献编号 | 判断依据 |');
  W('|---|---|---|---|---|---|');
  for (const f of rowFindings) {
    W(`| ${f.year} | ${f.articleId} | 第 ${f.rowIndex + 1} 行 | ${f.outcomeName} | ${f.literatureCode} | ${(f.evidence?.missingTokens ?? []).join('、')} 在本篇查不到 |`);
  }
  W();
  W('> 例：2015-06 名下的「2.maximum anxiety」两行，全文没有 anxiety/VAS 字样，');
  W('> 而金标准自带的文献编号（EN016-112/122）指向的是 2015-05 那篇。');
  W('> 即：2015-05 的 4 行（疼痛/焦虑 × 2 个比较组）被拆分到了两个文献块里。');
  W();
} else {
  W('（尚未运行整行排查：`pnpm gold:rows`，需要该年份已完成解析）');
  W();
}

/*
 * 4.3 写法可疑的一组：复核时"逐位数字能找到、但原写法没找到"。
 * 单独列出而不是混进问题清单：这些大概率是同一件事的不同写法，不是金标准错。
 */
if (softUnique.length) {
  W(`### 4.3 写法可疑、暂不算问题的条目（${softUnique.length} 个，供参考）`);
  W();
  W('这类值在原文里**逐字找不到**，但把写法放宽之后就能对上——多数是"同一件事的不同写法"，');
  W('也可能是我们的检索手段还不够。分两种，见下表"复核结论"列：');
  W();
  W('- **复核后能在原文中找到**：论文里其实是同一件事的另一种写法（如金标准写 `24 weeks`，原文写 `week 24`）；');
  W('- **逐位数字能找到、写法可疑**：原文里有这几个数字，但上下文（单位、所在表格）对不上，值得人工看一眼。');
  W();
  W('它们**没有**从准确率统计中剔除——即这些条目在准确率里仍按"没抽到/抽错"计算，请仅在核对具体论文时参考：');
  W();
  W('| 年份 | 篇号 | 原始表格列名 | 提取用字段名 | 金标准填写 | 复核结论 |');
  W('|---|---|---|---|---|---|');
  for (const v of softUnique.slice(0, 20)) {
    const where = `${v.scope ?? ''}${v.field ? `.${v.field}` : ''}`.replace(/^\./, '');
    const label = v.verdict === 'found' ? '复核后能在原文中找到' : '逐位数字能找到、写法可疑';
    W(`| ${v.year} | ${v.articleId} | ${LABELS.describe(where).names.join(' / ')} | \`${where}\` | ${String(v.value ?? '').slice(0, 32)} | ${label} |`);
  }
  if (softUnique.length > 20) W(`| … | | | | | 其余 ${softUnique.length - 20} 个见 build/gold_evidence_check.json |`);
  W();
}

/* ---------- 五、标准界定不清 ---------- */
W('## 五、标准界定不清、需要你们拍板的地方');
W();
W('以下每一条都是我们在比对中**反复遇到**的分歧点。每条给出：现状（金标准实际怎么做的）→ 疑问 → 建议选项。');
W('这些点不解决，任何自动提取（以及不同提取人之间）都会长期不一致。');
W();
const CRITERIA = [
  {
    t: '例数（n）取"随机化人数"还是"实际分析人数"',
    fields: ['end_of_treatment.continuous.n', 'follow_up_end.continuous.n'],
    now: '同一篇里两种口径混用。例如 2015-01：疗程结束时取的是**完成治疗**的 78/81 例，',
    now2: '而随访结束时取的是**随机化**的 80/82 例；两个数字原文都能找到。',
    q: '同一结局的两个时点，例数要不要统一口径？',
    opts: [
      '统一取"该时点实际纳入分析的人数"（更贴近统计结果，但每篇要逐表核对）',
      '统一取"随机化人数"（容易取，但与效应量的分析集可能不一致）',
      '按金标准现状：逐时点取该表实际用的例数，并在备注里写明口径',
    ],
  },
  {
    t: '效应量取 ITT 还是符合方案集（PP）',
    now: '原文常并排列出两套结果（同一表格里既有"完成治疗"组，也有"意向治疗"组）。',
    now2: '金标准多数取 ITT，但个别篇取了 PP；两套数字往往只差 0.2~0.5。',
    q: '是否统一规定"一律取 ITT（意向性治疗）"？如果原文只报告 PP 怎么办？',
    opts: ['一律取 ITT；缺 ITT 时取 PP 并在备注注明', '优先 ITT，但以原文"主要分析"声明为准', '允许两套都记（工作量翻倍）'],
  },
  {
    t: '变异值（离散度）与 95%CI 的关系',
    fields: ['end_of_treatment.continuous.variance_type', 'end_of_treatment.continuous.ci_lower', 'end_of_treatment.continuous.ci_upper'],
    now: '工作簿里"变异值下限/上限"两列，实际装的是**离散度**：',
    now2: '报 SD 时只填下限一列（如 `52.3 (15.7)` → 下限填 15.7）；报 95%CI 时上下限都填。',
    q: '这个理解对吗？另外"变异值类型"一格实际出现过多选（如「3/2」），与批注"只选 1 个"矛盾。',
    opts: [
      '维持现状（按离散度类型填下限/上限）',
      '改为允许多选（同时报告 SD 与 CI 时都记），并明确优先顺序',
      '把"变异值"与"95%CI"拆成两列，各自独立',
    ],
  },
  {
    t: '组间差值什么时候记',
    fields: ['end_of_treatment.binary.difference_estimate', 'end_of_treatment.binary.difference_ci_lower', 'end_of_treatment.binary.difference_ci_upper'],
    now: '有的篇记了"两组之差及 95%CI"，有的篇只记各组自己的值；',
    now2: '没有记的篇，原文里其实也有差值列。',
    q: '是否规定：只要原文给出组间差值（含 95%CI）就必须记录？',
    opts: ['一律记录（推荐，便于后续合并）', '只记录原文"主要分析"给出的差值', '维持现状（按提取人判断）'],
  },
  {
    t: '结局行的粒度：一条结局 = ？',
    now: '金标准按（比较组 × 结局指标）一行；但三臂试验里会出现"对照组 vs 对照组"这种不该算比较组的组合。',
    q: '比较组是否限定为"一个试验组 vs 一个对照组"？三臂试验应产出几条？',
    opts: [
      '限定为试验组 vs 对照组；三臂=2 条（试验组分别对 2 个对照）',
      '允许对照之间也成对（最多 3 条）',
      '按原文表格的行数来，不做规定',
    ],
  },
  {
    t: '量表的分域（subscale）要不要单独成行',
    fields: ['outcome.name', 'outcome.instrument'],
    now: '金标准对 RQLQ(S) 只收录了一个域（"③sleep domain"）加一个总分，其余 6 个域没进表；',
    now2: '而同量表的分项在另一篇里又被当作独立结局。',
    q: '同一量表的多个域：全收、只收论文当作独立结局声明的、还是只收总分？',
    opts: ['只收论文明确声明的结局（推荐）', '所有域都收（会把结局行数放大数倍）', '只收总分'],
  },
  {
    t: '同一结局有多张分析表时取哪一张',
    now: '原文常同时给出：主要分析表（如混合效应模型 + 全分析集）、敏感性分析表（协方差分析）、符合方案集表。',
    q: '是否统一取"主要分析 + 全分析集"那张？',
    opts: ['统一取主要分析（推荐）', '取报告 95%CI 的那张', '逐篇按提取人判断并在备注说明'],
  },
  {
    t: '结局分类（construct / subconstruct）的口径',
    fields: ['outcome.construct_code', 'outcome.subconstruct_code'],
    now: '实测分歧：SF-12（生活质量量表）被归为"功能"，而 EQ-5D 被归为"生活质量"；',
    now2: '抑郁量表 BDI 被归为"肌肉骨骼功能"，焦虑 VAS 被归为"其他症状"。',
    q: '是否按"量表性质"分类（如 SF-12、SF-36 一律算功能；EQ-5D、RQLQ 算生活质量）？',
    opts: ['按量表性质统一（推荐，可写成对照表）', '按结局名称字面判断', '两套并存：同时记量表性质与论文表述'],
  },
  {
    t: '"等级资料"两档（无法转二分类 / 已转二分类）的界限',
    fields: ['outcome.special_data_flag', 'outcome.measurement_type'],
    now: '同一类 4 级评分，有的篇记"无法转二分类"，有的篇记"已转二分类"，看不出判据。',
    q: '判据是不是"论文是否给出了二分后的结果（如有效/无效人数）"？',
    opts: ['按"论文是否给出二分结果"判定（推荐）', '按量表本身是否有序判定', '该字段改为备注说明'],
  },
  {
    t: '"主要结局测量时点"怎么填',
    fields: ['outcome.primary_outcome_timepoint'],
    now: '金标准里多数填"治疗结束后"，但同一结局在随访也有数据时，规则不明（有的填"两者都有"、有的填"非主要结局"）。',
    q: '这一列到底是"该结局自己的测量时点"，还是"它相对主要结局的关系"？',
    opts: ['按批注字面：相对于主要结局的关系（推荐，但需明确"非主要结局"占多数）', '改成"该结局实际测量了哪些时点"'],
  },
  {
    t: '"是否对基线做了调整"何时填"不清楚"',
    fields: ['outcome.baseline_adjusted'],
    now: '实测：论文用了校正回归（把基线作为协变量）却被填"否"；也有该填"不清楚"的地方填了"否"。',
    q: '是否规定：使用 ANCOVA / 混合效应模型 / 回归并纳入基线 → 一律填"是"？',
    opts: ['按上述规定（推荐）', '按论文是否有"adjusted"字样', '保留判断空间，但要求写备注'],
  },
  {
    t: '时点如何划分：原文的 T0–T1 / T0–T2 与"第 1 月 / 第 3 月"',
    now: '本课题只设三个时点（基线、疗程结束、随访结束）。',
    now2: '但原文常有更多时点（如治疗后 1 个月、3 个月、6 个月、12 个月），个别篇把"第 3 月"当作疗程结束。',
    q: '多时点时如何映射？是否只保留"方案规定的主要时点"与"最后一个随访"？',
    opts: [
      '只保留方案规定的主要时点 + 最长的随访时点（推荐）',
      '保留全部时点（工作簿需加列）',
      '按"距治疗结束最近"的时点折算',
    ],
  },
  {
    t: '资源使用类指标（合并用药、就诊次数、成本）算不算结局',
    now: '这类指标被排除在六类结局之外，但金标准里又出现过；',
    q: '是否明确：只收"患者重要结局"六类，资源使用另设一列记录？',
    opts: ['另设一列记录，不进六类（推荐）', '算"重要事件类"', '完全舍弃'],
  },
  {
    t: '发表年份取"语料年份"还是"印刷年份"',
    fields: ['article.publication_year'],
    now: '金标准统一用语料年份；但个别论文页脚印的是次年（如语料 2015、页脚 2016），个别更晚。',
    q: '是否统一以"文献编号的年份"为准，并在备注里记录页脚年份差异？',
    opts: ['以文献编号年份为准（推荐）', '以页脚/DOI 印刷年为准'],
  },
  {
    t: '影响因子（2019）这类"论文里没有"的字段',
    fields: ['article.impact_factor_2019'],
    now: '金标准填了各期刊 2019 年影响因子；这类数值只能查外部期刊目录，论文里没有。',
    q: '是否由人工/外部表统一补录，不纳入自动提取的准确率统计？',
    opts: ['由外部表补录，不参与自动提取评分（推荐）', '自动提取时留空，人工补', '保留现状（该项自动提取必错）'],
  },
  {
    t: 'P 值取哪一个：组间比较、组内前后比较、还是区间写法',
    fields: ['outcome.p_value', 'outcome.p_value_range'],
    now: '这是目前分歧最集中的一项：语义判定里 P 值有 23 组**全部不一致**，两种方向都有——',
    now2:
      '· 金标准写了具体数值（如 0.175、0.02），我们填"未报告"；\n' +
      '  · 金标准填"未报告"，我们在论文里找到了数值（如 <0.001、0.01）。\n' +
      '  原因通常是论文同时给出多种 P 值：①两组之间的比较；②每组治疗前后的比较；③校正/多重比较后的 P。',
    q: '这一列到底要哪一个？以及"P<0.001"这类**区间写法**算不算"报告了 P 值"？',
    opts: [
      '统一取"组间比较"的 P 值；论文只给区间写法时照抄（如 <0.001）（推荐，最贴近疗效判断）',
      '组间比较优先，没有组间时才取组内前后比较，并在备注写明来源',
      '维持现状（按提取人判断），但要求填备注说明取自哪一种比较',
    ],
  },
  {
    t: '工作簿里若干列的填写，与列头/取值表不符（需对着工作簿确认）',
    fields: ['comparison.stimulation_intensity', 'comparison.deqi', 'comparison.needle_retention_class',
      'article.funding_1', 'article.condition_system', 'article.outliers_influential'],
    now: '统计中有上百处"填了取值表以外的内容"。逐列看，分两种情形，需要你们打开工作簿核对：',
    now2:
      '**情形一：填进去的是别列的内容**——如"刺激强度"列里填 `20min / 30 minutes / 48 hours`（这是留针时间或随访时间）；' +
      '"得气"列里填 `PC6，5mm, ST36，10mm`（这是穴位与进针深度）；"留针时间分类"列里填数字 3~10（该列文档里只列了 2 个选项）。\n' +
      '  **情形二：该列实际取值比文档更长**——如"资金1"列文档写 1=有/2=未报告，实际出现 3~7；' +
      '"疾病系统"列出现 `8;14`、`2;9` 这种**多选**写法（文档里是单选码）。',
    q: '请对照工作簿确认：是填写时串列了，还是这些列的真实取值表比文档里更长/允许多选？',
    opts: [
      '逐列确认并更新取值表（推荐：一次性把列含义与取值表对齐，之后所有提取人/机器都按同一张表）',
      '保留现状，但在评审时把这几列排除在准确率统计外（我们目前已经这么做了）',
      '把这些列改为"自由文本"，不做编码',
    ],
  },
  {
    t: '工作簿里四组重复表头的真实含义',
    fields: ['comparison.prior_acupuncture_experimental', 'comparison.randomized_n_experimental', 'comparison.analyzed_n_experimental'],
    now: 'Sheet1 里"试验组/对照组"这组表头重复出现 4 次，程序按顺序命名为"性别、既往针刺、随机例数、分析例数"，',
    now2: '但每列真正的含义写在单元格批注里：分别是**随机例数**、**主要结局时点样本量**、**脱落人数**。',
    q: '是否统一按批注含义重命名这些列？（会影响已有数据的列对应关系）',
    opts: ['按批注含义重命名（推荐，一次性理清）', '保留列名，但在表头写明含义', '维持现状'],
  },
  {
    t: '"未报告"要不要显式填 NR（含 Sheet2 的"备注"列）',
    fields: ['study.remarks'],
    now: `Sheet2 里六个结局分类列，未报告时金标准都显式写了 \`NR\`，机器也照此输出，这部分完全对得上。`,
    now2:
      (REMARKS_STAT.nonNr === 0
        ? `**"备注"列金标准在已比对年份里共 ${REMARKS_STAT.total} 处，每一处写的都是 \`NR\`**（没有一条真正的备注内容）。`
        : `**"备注"列金标准在已比对年份里共 ${REMARKS_STAT.total} 处，其中 ${REMARKS_STAT.total - REMARKS_STAT.nonNr} 处写的是 \`NR\`**。`) +
      (REMARKS_STAT.missed <= 2
        ? `机器现在也按"没有内容就填 NR"输出，这一列已从"整列漏抽"（原先 ${REMARKS_STAT.total} 处全漏）`
          + `变成只差 ${REMARKS_STAT.missed} 处。`
        : '机器目前没有输出这一列，于是被计为 ' + REMARKS_STAT.missed + ' 处"漏"'
          + (REMARKS_STAT.den ? '，占到 Sheet2 分母的 ' + ((REMARKS_STAT.missed / REMARKS_STAT.den) * 100).toFixed(0) + '%' : '') + '。') +
      '\n  同类情形还有"资金2""注册号"等列：金标准习惯把"没有"也写成 `NR`，而不是留空。',
    q: '约定是否为：**任何"论文未报告"的字段都必须显式填 NR**（而不是留空）？如果是，机器照做即可；',
    q2: '如果留空与 NR 等价，则这类"漏"不应计入准确率（我们会在评分口径里改掉）。',
    opts: [
      '统一：未报告一律显式填 NR（推荐，便于计数与核对）',
      '留空与 NR 等价，评分时视为相同（改评分口径即可）',
      '两列（如"备注"）改为自由文本，无内容就留空，不做评分',
    ],
  },
];

/*
 * 5.0 汇总表：把下面 19 条问题**按字段**拉平，一行一个字段，直接给出「原始表格列」。
 * 医生打开工作簿时对着这张表逐列看即可，不必把 19 段文字读一遍。
 * 列字母取**当前版布局（2020–2025）**；2015–2019 的工作簿整体多一列，表里已注明旧版字母。
 */
W('### 5.0 需要你们明确标准的字段一览（先看这张表）');
W();
W('下表的每一行 = 一个需要你们定标准的字段。**列字母以当前版工作簿（2020–2025）为准**；');
W('2015–2019 的工作簿在这一列之前多一列，同一字段的字母顺延一位，表里已注明「旧版布局为第 X 列」。');
W('讨论细节见对应的 5.x 小节。');
W();
W('| # | 工作表 | 原始表格列（列名｜列字母） | 提取用字段名 | 需要明确什么 |');
W('|---|---|---|---|---|');
{
  const FIELD_LEVEL = { 'Sheet1 文章级': 1, 'Sheet1 比较组': 2, 'Sheet2 结局分类': 3, 'Sheet3 结局级': 4 };
  const rows = [];
  CRITERIA.forEach((c, i) => {
    for (const k of c.fields ?? []) {
      const d = LABELS.describe(k);
      const sheet = FIELD_LEVEL[d.where] ? d.where : (d.where.startsWith('Sheet3') ? 'Sheet3 时点数值' : d.where);
      rows.push({ no: `5.${i + 1}`, sheet, col: d.names.join(' / '), key: k, what: c.t, order: FIELD_LEVEL[d.where] ?? 9 });
    }
    if (!(c.fields ?? []).length) {
      rows.push({ no: `5.${i + 1}`, sheet: '（结构类）', col: '—（不是单一列，见该小节）', key: '—', what: c.t, order: 0 });
    }
  });
  rows.sort((a, b) => {
    const na = Number(a.no.slice(2)); const nb = Number(b.no.slice(2));
    return na - nb || a.order - b.order || a.col.localeCompare(b.col);
  });
  for (const r of rows) {
    W(`| ${r.no} | ${r.sheet} | ${r.col} | \`${r.key}\` | ${r.what} |`);
  }
}
W();
W(`> 表中共 ${new Set(CRITERIA.flatMap((c) => c.fields ?? [])).size} 个字段、${CRITERIA.length} 个问题；`
  + '带「（结构类）」的是粒度/口径问题，不对应单一列。');
W();

CRITERIA.forEach((c, i) => {
  W(`### 5.${i + 1} ${c.t}`);
  W();
  W(`- **现状**：${c.now}`);
  if (c.now2) W(`  ${c.now2}`);
  /* 提到具体列的地方，一律给出"表格列名 + 提取用字段名"，方便对着工作簿看 */
  if (c.fields?.length) {
    const items = c.fields.map((k) => `${LABELS.describe(k).names.join(' / ')}｜\`${k}\``);
    W(`- **涉及列**：${items.join('；')}`);
  }
  W(`- **疑问**：${c.q}`);
  if (c.q2) W(`  ${c.q2}`);
  W('- **可选口径**：');
  for (const o of c.opts) W(`  - ${o}`);
  W();
});

/* ---------- 六、典型案例：一篇看明白 ---------- */
/*
 * 挑一篇"把上面多数问题一次撞齐"的文章逐字段摊开。
 * 2020-02 同时具备：多比较组、穴位按压（不适用留针）、原文单位不在取值表里、
 * 疗程写成"<1 天"、随访只写到"住院期间"、脱落人数为 0、
 * 以及最关键的——**金标准 8 条结局行 vs 机器 2 条**。
 */
const CASE_ID = '2020-02';
{
  const cy = CASE_ID.split('-')[0];
  const cg = readJson(join(ROOT, 'build', 'gold', `${cy}.json`));
  const cart = (cg?.articles ?? []).find((a) => a.article_id === CASE_ID);
  const cp = readJson(join(ROOT, 'build', 'extraction', cy, `${CASE_ID}.json`));
  const V = (o) => (o && typeof o === 'object' ? String(o.raw ?? '') : String(o ?? ''));
  const camelKey = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const SENT = /^\s*(NR|NA|NE)?\s*$/i;

  if (cart && cp) {
    W('## 六、典型案例：`' + CASE_ID + '` 一篇看明白');
    W();
    W(`**${V(cart.article?.title)}**`);
    W();
    W(`（${V(cart.article?.journal)}，${V(cart.article?.publication_year)}）`);
    W();
    W('选它的原因：这一篇把报告第五节里的多数问题**一次撞齐**了——多比较组、穴位按压（不适用留针）、');
    W('原文的频次单位不在取值表里、疗程写成「<1 天」、随访只写到「住院期间」、脱落人数为 0，');
    W('以及最容易看出来的：**金标准记了 8 条结局行，机器只记了 2 条**。');
    W();
    const gN = (cart.comparisons ?? []).length; const pN = (cp.comparisons ?? []).length;
    const gO = (cart.outcomes ?? []).length; const pO = (cp.outcomes ?? []).length;
    W(`- 比较组：金标准 **${gN}** 个 ／ 机器 **${pN}** 个`);
    W(`- 结局行：金标准 **${gO}** 条 ／ 机器 **${pO}** 条`);
    W();

    /* 结局行对照 */
    W('### 6.1 结局行（Sheet3 的「结局名称 OUTCOM / 测量工具 INSTRU」两列）');
    W();
    W('| 来源 | 结局名称（列 OUTCOM） | 测量工具（列 INSTRU） | P 值（列 PVALNUM） | 取值范围（列 RANGE） |');
    W('|---|---|---|---|---|');
    (cart.outcomes ?? []).forEach((o) => {
      W(`| 金标准 | ${V(o.outcome?.name)} | ${V(o.outcome?.instrument)} | ${V(o.outcome?.p_value)} | ${V(o.outcome?.measurement_range)} |`);
    });
    (cp.outcomes ?? []).forEach((o) => {
      W(`| 机器 | ${V(o.outcome?.name)} | ${V(o.outcome?.instrument)} | ${V(o.outcome?.pValue)} | ${V(o.outcome?.measurementRange)} |`);
    });
    W();
    W('**这就是需要你们定标准的地方**：金标准把「疼痛 VAS 评分」和「三种补救镇痛药的用量」');
    W('（对乙酰氨基酚 / 双氯芬酸 / 哌替啶——药名写在**测量工具**列 INSTRU 里，应是"该药的用量"）各记一行，两个比较组共 8 行；');
    W('机器只认「疼痛」这一个结局，两个比较组各 1 行。');
    W('换句话说：**「结局」的边界是"一个指标"还是"一个指标 × 一种测量方式"，两边理解不同**（见 §5.5、§5.6）。');
    W('机器抽到的 VAS 那两行本身是对的（P 值、取值范围、两组例数与基线值都对得上），只是没按金标准的粒度拆行。');
    W();

    /* 比较组级字段对照 */
    const CASE_KEYS = [
      ['干预方法名称', 'intervention', '机器用了提示词规定的「干预+合并治疗」写法，金标准照抄论文组名'],
      ['对照组名称', 'control', '同上'],
      ['对照组类型', 'control_type', '编码口径分歧：金标准 2=「非刺入假针刺」，机器 5=「假针+其他疗法」——差别在于算不算"合并常规护理"'],
      ['比较类型', 'comparison_type', '同上：金标准 2=「针刺 vs 假针/安慰针」，机器 4=「针刺+其他疗法 vs 假针+其他疗法」'],
      ['治疗频次描述', 'frequency_desc', '写法差异（金标准抄整句，机器抄要点）'],
      ['治疗频次数值', 'frequency_value', '第 1 个比较组机器填 NR：原文说的是"产后第 2、4 小时各一次"，机器没把它算成"频次数值"'],
      ['治疗频次单位', 'frequency_unit', '**金标准填的是原文单位 `Sessions per labor`，不在取值表（1=天/2=周/3=1小时）里**；机器填 NR 或 1。这列怎么记要定（见 §5.17）'],
      ['治疗总次数', 'total_sessions', '两边一致（2 次）'],
      ['治疗总次数治疗分类', 'total_sessions_class_a', '**金标准 2（手术+非穴位按压），机器 3（慢性+穴位按压）**：剖宫产算"手术"还是"慢性"？穴位按压算"穴位按压"类吗？（见 §5.17）'],
      ['治疗总次数分类', 'total_sessions_class_b', '**金标准 2，机器 NR**。这一列在原始工作簿里只有列头写着 `1high 2low`、没有取值表/批注，机器无从下手（全库该列 153 处全部落空）'],
      ['留针时间分类', 'needle_retention_class', '**金标准 NA（穴位按压没有留针），机器 2**。该列列头写的两个选项是"手术+非穴位按压 / 慢性病+非穴位按压"，与"留针时间"字面无关，需要改列头或改取值表'],
      ['疗程', 'course_desc', '金标准把"住院期间即刻完成"写成 `<1 day (during immediate postpartum)`，机器填 NR'],
      ['疗程数值', 'course_value', '**金标准写 `<1`**——"小于 1"怎么进数值列？机器遇到这种写法会填 NR'],
      ['疗程单位', 'course_unit', '金标准 1（天）'],
      ['最长随访时间', 'max_followup_desc', '**金标准写的是定性描述 `outcomes measured only during hospitalization`**，机器填 NR（见 §5.19）'],
      ['随机样本量', 'randomized_n', '两边一致（88）'],
      ['试验组', 'analyzed_n_experimental', '**这一列的真实含义是"试验组脱落人数"**（列头只写"试验组"，批注里写脱落人数）。金标准 0=没有脱落；机器在第 2 个比较组填了 NR（见 §5.19）'],
      ['对照组', 'analyzed_n_control', '同上'],
      ['主要结局脱落总人数', 'dropout_total', '同上（第 2 个比较组金标准 0、机器 NR）'],
      ['盲结局评价者', 'blinding_outcome_assessor', '金标准 3=未报告，机器 2=否——"没写"与"明确说没做"的界限（见 §5.19）'],
    ];
    W('### 6.2 比较组级字段逐项对照（Sheet1 右半，每个比较组一段）');
    W();
    W('下表取第 1 个比较组（`' + CASE_ID + '-01`）为例；括号里是当前版工作簿的列字母。');
    W();
    W('| 原始表格列 | 提取用字段名 | 金标准 | 机器 | 这一处为什么需要定标准 |');
    W('|---|---|---|---|---|');
    const g1 = (cart.comparisons ?? [])[0] ?? {}; const p1 = (cp.comparisons ?? [])[0] ?? {};
    for (const [zh, k, why] of CASE_KEYS) {
      const gv = V(g1[k]); const pv = V(p1[camelKey(k)]);
      if (SENT.test(gv) && SENT.test(pv)) continue;
      const col = LABELS.describe(`comparison.${k}`).names[0] ?? zh;
      W(`| ${col} | \`comparison.${k}\` | ${gv || '（空）'} | ${pv || '（空）'} | ${why} |`);
    }
    W();
    W('> 上表里「机器的值」是自动提取的结果；有些格子看起来"机器错"，但按提示词它并没有违背规则——');
    W('> 规则本身没定清楚（例如"剖宫产算不算手术类""频次单位不在取值表时怎么记"）。这类必须先定标准，再谈准确率。');
    W();
  }
}

/* ---------- 七、方法附录 ---------- */
const parseHealth = readJson(join(ROOT, 'build', 'parse_health.json'));
W('## 七、附：方法与可复现性（一页）');
W();
W('- **原文解析**：用 MinerU（本地运行，不联网）把 PDF 转成带页码与坐标的结构化文本与表格；');
W('  表格按行列还原，图表保留切图，**不丢弃任何表格与图片**（有专门的保真检查脚本）。');
W('- **机器提取**：按"先判结构、再抽字段"的顺序分段进行——');
W('  研究结构（几个组、几个比较组）→ 文章基本信息 → 每个比较组 → 结局清单 → 每个结局的数值。');
W('  每一次提取都要求模型给出**原文出处**，程序再用这段原文回到 PDF 里定位坐标；');
W('  定位不到的字段直接丢弃并记录，**不允许编造**。');
W('- **人工复核**：界面上可以逐字段核对、改值、框选原文作为证据、回滚；');
W('  人工修改**另存一层**（不改写机器结果），因此随时能给出"机器原值 vs 人工值"的差异，');
W('  这本身就是评估提取质量的关键指标。');
W('- **联网核验**：用 Crossref 核对题名/期刊/年份等元信息，作为外部权威值单独列出；');
W('  与 PDF 不一致时只提示，不自动改写。');
W('- **可复现**：所有中间产物（解析结果、每次模型请求的输入输出、评测报告）都留在 `build/` 下；');
W('  同样的输入重跑会命中缓存，结果一致。');
W();
if (parseHealth?.total) {
  const t = parseHealth.total;
  W(`- **已知的解析局限**：${t.papers} 篇里共 ${t.tables} 张表格，其中 **${t.emptyTables} 张（${((t.emptyTables / t.tables) * 100).toFixed(1)}%）**`);
  W(`  因跨页续表而没能完整还原，涉及 **${t.affectedPapers} 篇**。这些论文的数值提取会偏低——`);
  W(`  这是"原文没读全"，不是"读错了"，建议在复核这些论文时特别留意。`);
} else {
  W('- 解析局限统计：运行 `node tools/parse_health.mjs` 可得到"跨页表格未完整还原"的篇数。');
}
W();

/* ---------- 写盘 ---------- */
const outPath = resolve(ROOT, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, L.join('\n'), 'utf8');
console.log(`报告已生成：${outPath}`);
console.log(`  覆盖年份：${evals.map((e) => e.year).join(', ') || '（无评测报告）'}`);
console.log(`  疑似金标准问题：值级 ${valTotal} 条 + 整行 ${rowFindings.length} 条`);
console.log(`  待拍板的标准问题：${CRITERIA.length} 条`);
