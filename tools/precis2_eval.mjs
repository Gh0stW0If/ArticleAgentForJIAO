/**
 * PRECIS-2 评分评测：机器 vs 06 表人工评分
 *
 * 口径（与 05 §8 一致）：
 *   - `3-B` 记 3；`3-U` 记 3 **仅用于数值比较**，但单独计数并在报告里标出；
 *   - `N/A` 不进数值分母，只有双方都 N/A 才算一致；
 *   - 缺分（人工或机器为空）不进分母；
 *   - 同时报「完全一致（整数相等）」「±1 以内」「二次加权 kappa」「平均有符号差」「MAE」。
 *
 * ⚠️ 不要把 kappa 当成"准确率"：PRECIS-2 是九维剖面，没有官方总分；
 *    人工评分本身有主观性，kappa 是**机器-人一致性**，不是机器对错。
 *
 * 用法：
 *   node tools/precis2_eval.mjs                 # 所有已有产物
 *   node tools/precis2_eval.mjs --years 2015
 *   node tools/precis2_eval.mjs --md            # 只重写 markdown（默认也写）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from './lib/precis2_gold.mjs';

const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = (() => {
  const out = { years: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--years') out.years = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
})();

const goldFile = join(ROOT, 'build', 'precis2', 'gold.json');
if (!existsSync(goldFile)) {
  console.error('缺少 build/precis2/gold.json —— 先跑 node tools/lib/precis2_gold.mjs');
  process.exit(2);
}
const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
const goldById = new Map(gold.studies.map((s) => [s.studyId, s]));

/** 读机器产物。 */
const machine = [];
const years = args.years ?? readdirSync(join(ROOT, 'build', 'precis2'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
  .map((d) => d.name)
  .sort();
for (const year of years) {
  const dir = join(ROOT, 'build', 'precis2', year);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    machine.push(rec);
  }
}

const labelOf = (d) => (d ? d.label ?? null : null);
const numOf = (d) => (d && d.numeric !== null && d.numeric !== undefined ? d.numeric : null);

/** 二次加权 kappa（1..5）。 */
function quadraticKappa(pairs) {
  if (!pairs.length) return null;
  const k = 5;
  const O = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [a, b] of pairs) O[a - 1][b - 1]++;
  const n = pairs.length;
  const row = O.map((r) => r.reduce((s, v) => s + v, 0));
  const col = Array.from({ length: k }, (_, j) => O.reduce((s, r) => s + r[j], 0));
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      po += O[i][j] * (1 - ((i - j) ** 2) / ((k - 1) ** 2));
      pe += (row[i] * col[j] / n) * (1 - ((i - j) ** 2) / ((k - 1) ** 2));
    }
  }
  po /= n;
  pe /= n;
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

const num = (x) => (x === null ? '—' : x.toFixed(2));
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

const perDomain = {};
const perYear = {};
const allPairs = [];
const strictPairs = [];
let compared = 0;
let strictCompared = 0;
let strictExact = 0;
let strictNear = 0;

for (const rec of machine) {
  const g = goldById.get(rec.studyId);
  if (!g) continue;
  const y = rec.studyId.slice(0, 4);
  perYear[y] ??= { n: 0, exact: 0, near: 0, compared: 0 };
  perYear[y].n++;

  for (const d of DOMAINS) {
    perDomain[d.key] ??= {
      key: d.key, en: d.en, zh: d.zh,
      n: 0, compared: 0, exact: 0, near: 0,
      machineSum: 0, humanSum: 0, absSum: 0, signedSum: 0,
      naBoth: 0, naMachine: 0, naHuman: 0, missing: 0,
      uncertain: 0, ungrounded: 0, invalid: 0,
      pairs: [],
    };
    const acc = perDomain[d.key];
    acc.n++;

    const md = rec.payload?.domains?.[d.key];
    const hd = g.domains?.[d.key];
    if (!md) { acc.missing++; continue; }
    if (md.invalid) acc.invalid++;
    if (md.uncertain) acc.uncertain++;
    if (md.grounded === false && !md.absenceBased) acc.ungrounded++;

    const ml = labelOf(md);
    const hl = labelOf(hd);

    if (hl === 'N/A' || ml === 'N/A') {
      if (hl === 'N/A' && ml === 'N/A') {
        acc.naBoth++; acc.compared++; acc.exact++;
        perYear[y].compared++; perYear[y].exact++;
      } else if (ml === 'N/A') acc.naMachine++;
      else acc.naHuman++;
      continue;
    }

    const mv = numOf(md);
    const hv = numOf(hd);
    if (mv === null || hv === null) { acc.missing++; continue; }

    acc.compared++;
    compared++;
    acc.machineSum += mv;
    acc.humanSum += hv;
    acc.absSum += Math.abs(mv - hv);
    acc.signedSum += mv - hv;
    acc.pairs.push([mv, hv]);
    allPairs.push([mv, hv]);
    if (mv === hv) { acc.exact++; perYear[y].exact++; } else { /* exact 只在比较过的对上算 */ }
    if (Math.abs(mv - hv) <= 1) { acc.near++; perYear[y].near++; }
    perYear[y].compared++;

    /*
     * 严格口径：把 3-U 从"可比较"里拿掉。
     * 3-U 在数值上记 3 只是为了数据管理；把它当成一个人给的 3 会**高估**一致率。
     */
    if (!md.uncertain) {
      acc.comparedStrict = (acc.comparedStrict ?? 0) + 1;
      acc.strictPairs ??= [];
      acc.strictPairs.push([mv, hv]);
      if (mv === hv) acc.strictExact = (acc.strictExact ?? 0) + 1;
      if (Math.abs(mv - hv) <= 1) acc.strictNear = (acc.strictNear ?? 0) + 1;
      strictCompared++;
      strictPairs.push([mv, hv]);
      if (mv === hv) strictExact++;
      if (Math.abs(mv - hv) <= 1) strictNear++;
    }
  }
}

for (const acc of Object.values(perDomain)) {
  acc.exactRate = acc.compared ? acc.exact / acc.compared : null;
  acc.nearRate = acc.compared ? acc.near / acc.compared : null;
  acc.mae = acc.compared ? acc.absSum / acc.compared : null;
  acc.meanSigned = acc.compared ? acc.signedSum / acc.compared : null;
  acc.meanMachine = acc.compared ? acc.machineSum / acc.compared : null;
  acc.meanHuman = acc.compared ? acc.humanSum / acc.compared : null;
  acc.kappa = quadraticKappa(acc.pairs);
  acc.strictExactRate = acc.comparedStrict ? (acc.strictExact ?? 0) / acc.comparedStrict : null;
  acc.strictKappa = quadraticKappa(acc.strictPairs ?? []);
  delete acc.pairs;
  delete acc.strictPairs;
}

const strict = {
  compared: strictCompared,
  exact: strictExact,
  near: strictNear,
  exactRate: strictCompared ? strictExact / strictCompared : null,
  nearRate: strictCompared ? strictNear / strictCompared : null,
  kappa: quadraticKappa(strictPairs),
  note: '严格口径：把 3-U 从可比较格里拿掉（3-U 不是"3 分"，是"不知道"）。',
};

const overall = {
  machineStudies: machine.length,
  matchedStudies: machine.filter((r) => goldById.has(r.studyId)).length,
  goldStudies: gold.studies.length,
  comparedCells: compared,
  exact: Object.values(perDomain).reduce((s, a) => s + a.exact, 0),
  near: Object.values(perDomain).reduce((s, a) => s + a.near, 0),
  kappa: quadraticKappa(allPairs),
  mae: compared ? Object.values(perDomain).reduce((s, a) => s + a.absSum, 0) / compared : null,
  meanSigned: compared ? Object.values(perDomain).reduce((s, a) => s + a.signedSum, 0) / compared : null,
  ungrounded: Object.values(perDomain).reduce((s, a) => s + a.ungrounded, 0),
  uncertain: Object.values(perDomain).reduce((s, a) => s + a.uncertain, 0),
};
overall.exactRate = compared ? overall.exact / compared : null;
overall.nearRate = compared ? overall.near / compared : null;

const report = {
  generatedAt: new Date().toISOString(),
  model: machine[0]?.model ?? null,
  skill: machine[0]?.skill ?? null,
  note: 'kappa 为二次加权（1–5）；3-U 记 3 但单独计数；N/A 只在双方都 N/A 时算一致。',
  overall,
  strict,
  perDomain,
  perYear,
};

mkdirSync(join(ROOT, 'build', 'precis2'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'precis2', 'eval.json'), JSON.stringify(report, null, 2), 'utf8');

/* ------------------------------- Markdown ------------------------------- */

const lines = [];
lines.push('# PRECIS-2 机器 vs 人工评分一致性');
lines.push('');
lines.push(`> 生成于 ${report.generatedAt} ｜ 模型 ${report.model ?? '—'} ｜ SKILL ${report.skill?.id ?? '—'}@${report.skill?.version ?? '—'}`);
lines.push('>');
lines.push('> **口径**：九领域逐格比较；`3-B`/`3-U` 记 3（3-U 单独计数）；`N/A` 只在双方都 N/A 时算一致；');
lines.push('> 缺分不进分母。kappa 为二次加权，衡量**一致性**，不是机器对错。');
lines.push('');
lines.push('## 总览');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('|---|---|');
lines.push(`| 有机器产物的研究 | ${overall.machineStudies} |`);
lines.push(`| 能与金标准匹配的研究 | ${overall.matchedStudies} / ${overall.goldStudies} |`);
lines.push(`| 可比较领域格数 | ${overall.comparedCells} |`);
lines.push(`| 完全一致（整数相等） | ${overall.exact} / ${overall.comparedCells} = **${pct(overall.exactRate)}** |`);
lines.push(`| ±1 以内 | ${overall.near} / ${overall.comparedCells} = **${pct(overall.nearRate)}** |`);
lines.push(`| 二次加权 kappa | **${num(overall.kappa)}** |`);
lines.push(`| MAE | ${num(overall.mae)} |`);
lines.push(`| 平均有符号差（机器 − 人） | ${overall.meanSigned === null ? '—' : (overall.meanSigned > 0 ? '+' : '') + overall.meanSigned.toFixed(2)} |`);
lines.push(`| 未接地分数（无引文） | ${overall.ungrounded} |`);
lines.push(`| 3-U 次数 | ${overall.uncertain} |`);
lines.push('');
lines.push('## 严格口径（3-U 不算可比较）');
lines.push('');
lines.push('> 3-U 是「信息不足」，不是「3 分」。把 3-U 按 3 计会高估一致率；下表把它拿掉。');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('|---|---|');
lines.push(`| 可比较格 | ${strict.compared} |`);
lines.push(`| 完全一致 | ${strict.exact} / ${strict.compared} = **${pct(strict.exactRate)}** |`);
lines.push(`| ±1 | ${strict.near} / ${strict.compared} = **${pct(strict.nearRate)}** |`);
lines.push(`| 二次加权 kappa | **${num(strict.kappa)}** |`);
lines.push('');
lines.push('## 逐领域');
lines.push('');
lines.push('| 领域 | n | 可比较 | 完全一致 | ±1 | kappa | 严格 kappa | MAE | 机器均值 | 人工均值 | 平均差 | 3-U | 未接地 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const d of DOMAINS) {
  const a = perDomain[d.key];
  lines.push(`| ${d.en} (${d.zh}) | ${a.n} | ${a.compared} | ${pct(a.exactRate)} | ${pct(a.nearRate)} | ${num(a.kappa)} | ${num(a.strictKappa)} | ${num(a.mae)} | ${num(a.meanMachine)} | ${num(a.meanHuman)} | ${a.meanSigned === null ? '—' : (a.meanSigned > 0 ? '+' : '') + a.meanSigned.toFixed(2)} | ${a.uncertain} | ${a.ungrounded} |`);
}
lines.push('');
lines.push('## 分年');
lines.push('');
lines.push('| 年份 | 机器产物 | 可比较格 | 完全一致 | ±1 |');
lines.push('|---|---|---|---|---|');
for (const y of Object.keys(perYear).sort()) {
  const a = perYear[y];
  lines.push(`| ${y} | ${a.n} | ${a.compared} | ${a.compared ? pct(a.exact / a.compared) : '—'} | ${a.compared ? pct(a.near / a.compared) : '—'} |`);
}
lines.push('');
lines.push('## 读法提醒');
lines.push('');
lines.push('- **完全一致低不代表机器"错"**：PRECIS-2 相邻档位（如 3-B 与 4）差异很细，人工之间也未必一致；');
lines.push('- 看 **平均有符号差**：正数=机器比人更偏实用，负数=机器更偏解释；这是最该拿去和医生讨论的一列；');
lines.push('- 看 **未接地分数**：它说明有多少分数没有可定位的原文证据，必须优先人工复核；');
lines.push('- 看 **逐领域 kappa**：某领域接近 0 说明该领域的规则还没有被机器学会，而不是"评分随机"。');

writeFileSync(join(ROOT, 'build', 'precis2', 'eval.md'), lines.join('\n'), 'utf8');
console.log(lines.slice(0, 30).join('\n'));
console.log(`\n→ build/precis2/eval.json / eval.md`);
