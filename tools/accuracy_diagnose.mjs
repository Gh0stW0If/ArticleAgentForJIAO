/**
 * 准确率**失分归因**：不问"多少分"，问"分丢在哪"。
 *
 * 为什么单独做这个：
 *   `accuracy_overview.mjs` 给的是三个工作表的准确率数字，但那个数字是**混合口径**，
 *   直接看数字会得出错误结论。举例：Sheet3 只有 36%，很容易读成"模型抽结局很差"；
 *   而拆开看会发现失分里有很大一块根本不是"抽错"，而是**整条结局行没配上**——
 *   那一行的几十个叶子会被整体计成「漏抽」。要改的东西（提示词？对齐？
 *   金标准取舍？）完全不同，所以必须先把失分按性质拆开。
 *
 * 计分口径（与 `llm_eval.mjs` 完全一致，这里只做聚合，不重新判定）：
 *   · 严格比较：`hit` / `code-hit`(=contains_correct，半分) / `wrong` / `missed`，`extra` 不进分母；
 *   · 语义判定装在 `byField` 的 `judged.<scope>.<field>` 键里，
 *     identical|same_meaning→hit、contains_correct→code-hit、unknown→extra、其余→wrong；
 *   · 加权分 w = hit + 0.5×code-hit，准确率 = w / (hit+code-hit+wrong+missed)。
 *
 * 用法：
 *   node tools/accuracy_diagnose.mjs                 # 11 年合并：总览 + 归因 + 失分榜 + 分层
 *   node tools/accuracy_diagnose.mjs --year 2025     # 只看某年
 *   node tools/accuracy_diagnose.mjs --top 30
 *   node tools/accuracy_diagnose.mjs --field outcome.subconstruct_code   # 值级对照（看是"抽错"还是"口径不一致"）
 *   node tools/accuracy_diagnose.mjs --field end_of_treatment.continuous.ci_lower --limit 15
 *   node tools/accuracy_diagnose.mjs --leaf ci_lower   # 逐路径分解一个叶子：错在"没配对"还是"真抽错"
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camelToSnake } from './lib/keys.mjs';
import { alignOutcomes, normText, outcomeSimilarity, MIN_SCORE } from './lib/align.mjs';
import { VERDICT_WEIGHT } from './lib/judge.mjs';
import { numericEqual } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const TOP = Number(arg('top', 20));
const FIELD = arg('field', null);
const LEAF = arg('leaf', null);
const LIMIT = Number(arg('limit', 12));
const ALL_YEARS = ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
const YEARS = ONLY_YEAR ? [ONLY_YEAR] : ALL_YEARS;

/* 中文按 2 列宽对齐，否则表格对不齐（padEnd 数的是码元，不是显示宽度） */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const dw = (s) => [...String(s)].reduce((a, c) => a + (WIDE.test(c) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dw(s)));
const padr = (s, n) => ' '.repeat(Math.max(0, n - dw(s))) + String(s);
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const n1 = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/* ------------------------------ 载入 + 聚合 ------------------------------ */

const mk = () => ({ hit: 0, 'code-hit': 0, wrong: 0, missed: 0, extra: 0 });
const add = (a, b) => {
  for (const k of ['hit', 'code-hit', 'wrong', 'missed', 'extra']) a[k] += b[k] ?? 0;
  return a;
};
const den = (s) => s.hit + s['code-hit'] + s.wrong + s.missed;
const wsum = (s) => s.hit + 0.5 * s['code-hit'];
/** 失分 = 分母上拿不到的分（半分算丢一半） */
const lost = (s) => den(s) - wsum(s);

const sheetOf = (field) => {
  const f = String(field).replace(/^judged\./, '');
  if (/^(article|comparison)\./.test(f)) return 1;
  if (/^study\./.test(f)) return 2;
  return 3;
};

const byField = new Map();
const perSheet = { 1: mk(), 2: mk(), 3: mk() };
/** 语义判定单独记一份（与严格比较同构），这样才能把「语义不合格」从「抽错」里分出来 */
const judgedSheet = { 1: mk(), 2: mk(), 3: mk() };
const yearsLoaded = [];

/**
 * 按**字段前缀**三分（不是二分）。
 *
 * `llm_eval.mjs` 早期用 `!field.startsWith('study.')` 判"是不是 Sheet3"，
 * 把 `article.*` / `comparison.*` 的语义条目并进了 Sheet3；2015 已修，
 * 而 2016–2025 的报告是 2026-09-25 用修好的代码重跑的，所以这里仍自己分一次，
 * 与 `accuracy_overview.mjs` 保持同一口径（不依赖报告里存的分组）。
 */

/** verdict → 计分桶（与 llm_eval.mjs 第 647 行的映射一致） */
const verdictBucket = (v) =>
  v === 'identical' || v === 'same_meaning' ? 'hit'
    : v === 'contains_correct' ? 'code-hit'
      : v === 'unknown' ? 'extra' : 'wrong';

for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  yearsLoaded.push(y);
  const rep = JSON.parse(readFileSync(f, 'utf8'));

  /*
   * ⚠️ 工作表合计必须取自 `report.total`，**不能**用 byField 求和。
   *
   * 因为 `llm_eval.mjs` 对"金标准整行没配上"的处理是：
   *   for (k < countFieldLeaves(g)) addTo(art.outcome, 'missed')
   * 只加到工作表合计上，**不记到任何字段** —— byField 求和会漏掉这块，
   * 而它恰恰是 Sheet3 漏抽的大头（实测直接把漏抽低估成 1/5）。
   */
  const t = rep.total ?? {};
  add(perSheet[1], t.article ?? {});
  add(perSheet[1], t.comparison ?? {});
  add(perSheet[2], t.study ?? {});
  add(perSheet[3], t.outcome ?? {});

  for (const j of rep.judged ?? []) {
    add(judgedSheet[sheetOf(j.field)], { [verdictBucket(j.verdict)]: 1 });
  }

  for (const [key, s] of Object.entries(rep.byField ?? {})) {
    if (!byField.has(key)) byField.set(key, mk());
    add(byField.get(key), s);
  }
}

/** 严格比较 + 语义判定的合并口径（= accuracy_overview 的 n / w） */
const cell = (i) => {
  const all = mk(); add(all, perSheet[i]); add(all, judgedSheet[i]);
  return all;
};
const total = mk();
for (const i of [1, 2, 3]) add(total, cell(i));
const hasLeaves = byField.size > 0;

console.log(`\n══ 准确率失分归因（${yearsLoaded.length} 年：${yearsLoaded[0]}–${yearsLoaded.at(-1)}，口径同 accuracy_overview）══`);
if (!yearsLoaded.length) {
  console.log('\n  ⚠ 没有找到 build/eval/<year>.json，先跑评测：node tools/llm_eval.mjs --year 2025\n');
  process.exit(0);
}
if (!hasLeaves) {
  console.log('\n  ⚠ 报告里没有 byField（年代较早的报告没写这一项），只能给到工作表级别，跳过字段级归因。');
}

/* ------------------------------ §1 谁在丢分 ------------------------------ */

const LABEL = { 1: 'Sheet1（文章级+比较组）', 2: 'Sheet2（结局分类）', 3: 'Sheet3（结局×时点）' };
console.log('\n§1 谁在丢分\n');
console.log(`  ${pad('工作表', 24)}${padr('分母', 8)}${padr('加权分', 9)}${padr('准确率', 9)}${padr('失分', 8)}${padr('占全部失分', 12)}`);
for (const i of [1, 2, 3]) {
  const s = cell(i);
  console.log(`  ${pad(LABEL[i], 24)}${padr(den(s), 8)}${padr(n1(wsum(s)), 9)}${padr(pc(wsum(s), den(s)), 9)}${padr(n1(lost(s)), 8)}${padr(pc(lost(s), lost(total)), 12)}`);
}
console.log(`  ${pad('合计', 24)}${padr(den(total), 8)}${padr(n1(wsum(total)), 9)}${padr(pc(wsum(total), den(total)), 9)}${padr(n1(lost(total)), 8)}`);

/* ------------------------------ §2 失分构成 ------------------------------ */

/*
 * 把失分按**性质**拆开。这是本工具存在的理由：
 * 「漏抽」和「抽错」在数字上是同一分，但要做的事完全不同。
 *
 * 注意"漏抽/抽错"只能取自**严格比较**（`perSheet`）：走语义判定的条目
 * 不存在"值对不对"，它只有"判成几档"。所以语义那一档要单独列，
 * 不能混进"抽错"里——否则会把"描述写得不一样"误报成"抽错了值"。
 */
const strictStats = mk();
const judgedStats = mk();
for (const i of [1, 2, 3]) { add(strictStats, perSheet[i]); add(judgedStats, judgedSheet[i]); }
const judgedN = den(judgedStats);
const judgedW = wsum(judgedStats);
const judgedWrong = judgedStats.wrong;
const judgedCodeHit = judgedStats['code-hit'];

const parts = [
  ['漏抽（金标准有值、产物没有）', strictStats.missed],
  ['抽错（两边都有、值不对）', strictStats.wrong],
  ['半对（contains_correct，记 0.5）', 0.5 * (strictStats['code-hit'] + judgedCodeHit)],
  ['语义判定不合格（has_error / completely_different）', judgedWrong],
];
const partSum = parts.reduce((a, [, v]) => a + v, 0);

console.log('\n§2 失分构成（同样一分，性质不同 → 该做的事完全不同）\n');
console.log(`  ${pad('性质', 50)}${padr('失分', 9)}${padr('占失分', 9)}${padr('折算准确率', 12)}`);
for (const [name, v] of parts) {
  console.log(`  ${pad(name, 50)}${padr(n1(v), 9)}${padr(pc(v, partSum), 9)}${padr(`−${((v / den(total)) * 100).toFixed(1)}pt`, 12)}`);
}
console.log(`  ${pad('合计', 50)}${padr(n1(partSum), 9)}${padr('100.0%', 9)}`);
console.log(`\n  其中走语义判定的共 ${judgedN} 组，加权得分 ${judgedW.toFixed(1)} = ${pc(judgedW, judgedN)}`);
console.log(`  （严格比较 ${den(strictStats)} 个字段：命中 ${strictStats.hit}、漏 ${strictStats.missed}、错 ${strictStats.wrong}、多 ${strictStats.extra}）`);

/* ------------- §3 结局行配对：Sheet3「漏抽」到底是不是真漏 ------------- */

const exclRows = new Map();
{
  const f = join(ROOT, 'build', 'gold_row_anomalies.json');
  if (existsSync(f)) {
    for (const x of JSON.parse(readFileSync(f, 'utf8')).findings ?? []) {
      if (!exclRows.has(x.articleId)) exclRows.set(x.articleId, new Set());
      exclRows.get(x.articleId).add(x.rowIndex);
    }
  }
}

/** 数一个对象里有多少个「字段值」（形如 { raw, ... }）——与 llm_eval 的 countFieldLeaves 一致 */
function countFieldLeaves(node) {
  let n = 0;
  const walk = (o) => {
    if (o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.raw === 'string') { n++; return; }
    Object.values(o).forEach(walk);
  };
  walk(node);
  return n;
}

let gRows = 0, aRows = 0, gLeaves = 0, unRows = 0, unLeaves = 0, pRows = 0;
const worstRows = [];
/* 未配对行的成因（行数 / 叶子数）：A1 真被抢走、A2 只有数值凑巧的假候选、B 完全没有 */
const why = { A1: { r: 0, l: 0 }, A2: { r: 0, l: 0 }, B: { r: 0, l: 0 } };
let a1Single = 0;
/* 反方向：没被用上的产物行 */
let pDup = 0, pOther = 0;
const samplesA1 = [], samplesNo = [];

/** Kuhn 增广路：二部图最大匹配 —— 用来验证"贪心是否白白漏配" */
function maxMatching(nG, nP, adj) {
  const matchP = new Array(nP).fill(-1);
  const tryK = (gi, seen) => {
    for (const pi of adj[gi]) {
      if (seen[pi]) continue;
      seen[pi] = true;
      if (matchP[pi] === -1 || tryK(matchP[pi], seen)) { matchP[pi] = gi; return true; }
    }
    return false;
  };
  let m = 0;
  for (let gi = 0; gi < nG; gi++) if (tryK(gi, new Array(nP).fill(false))) m++;
  return m;
}
let maxRows = 0;

for (const y of yearsLoaded) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const art of gold.articles ?? []) {
    const pf = join(ROOT, 'build', 'extraction', y, `${art.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    const all = art.outcomes ?? [];
    const ex = exclRows.get(art.article_id);
    const rows = ex?.size ? all.filter((_, i) => !ex.has(i)) : all;
    const preds = pred.outcomes ?? [];
    const { goldToPred } = alignOutcomes(rows, preds);
    pRows += preds.length;

    /* 与对齐器同一相似度建边，用于定性 + 最大匹配对照 */
    const adj = rows.map(() => []);
    const scoreOf = rows.map(() => new Map());
    for (let gi = 0; gi < rows.length; gi++) {
      for (let pi = 0; pi < preds.length; pi++) {
        const s = outcomeSimilarity(rows[gi], preds[pi]);
        scoreOf[gi].set(pi, s);
        if (s.score >= MIN_SCORE) adj[gi].push(pi);
      }
    }
    maxRows += maxMatching(rows.length, preds.length, adj);

    const owner = new Map();
    for (const [og, op] of goldToPred) owner.set(op, og);
    const usedP = new Set(goldToPred.values());
    for (let pi = 0; pi < preds.length; pi++) {
      if (usedP.has(pi)) continue;
      let bestText = 0;
      for (let gi = 0; gi < rows.length; gi++) bestText = Math.max(bestText, scoreOf[gi].get(pi).textScore);
      if (bestText >= MIN_SCORE) pDup++; else pOther++;
    }

    rows.forEach((g, i) => {
      const leaves = countFieldLeaves(g);
      gRows++; gLeaves += leaves;
      if (goldToPred.get(i) !== undefined) { aRows++; return; }
      unRows++; unLeaves += leaves;
      worstRows.push({ id: art.article_id, name: g.outcome?.name?.raw ?? '(无结局名)', leaves });
      const gName = `${g.outcome?.name?.raw ?? ''} / ${g.outcome?.instrument?.raw ?? ''}`;
      const cands = adj[i].map((pi) => ({ pi, ...scoreOf[i].get(pi) })).sort((a, b) => b.score - a.score);
      if (!cands.length) {
        why.B.r++; why.B.l += leaves;
        if (samplesNo.length < 8) samplesNo.push({ id: art.article_id, gName, leaves, pName: '（产物里没有任何接近的结局）' });
        return;
      }
      const c = cands[0];
      const pName = `${preds[c.pi].outcome?.name?.raw ?? ''} / ${preds[c.pi].outcome?.instrument?.raw ?? ''}`;
      if (c.textScore >= MIN_SCORE) {
        why.A1.r++; why.A1.l += leaves;
        if (cands.length === 1) a1Single++;
        if (samplesA1.length < 8) {
          samplesA1.push({
            id: art.article_id, gName, leaves, pName,
            by: owner.has(c.pi) ? `${rows[owner.get(c.pi)].outcome?.name?.raw ?? ''}` : null,
            text: c.textScore, corr: c.corr, n: cands.length,
          });
        }
      } else {
        why.A2.r++; why.A2.l += leaves;
        if (samplesNo.length < 8) samplesNo.push({ id: art.article_id, gName, leaves, pName, text: c.textScore, corr: c.corr });
      }
    });
  }
}
worstRows.sort((a, b) => b.leaves - a.leaves);

console.log('\n§3 结局行配对（Sheet3「漏抽」的主要来源）\n');
const S3 = cell(3);
console.log(`  金标准结局行 ${gRows} 行 ／ 流水线结局行 ${pRows} 行（${(pRows / gRows).toFixed(2)} 倍）`);
console.log(`  配上 ${aRows} 行 → 行覆盖率 ${pc(aRows, gRows)}；最大匹配可配 ${maxRows} 行（${pc(maxRows, gRows)}）`);
console.log(`  未配上的 ${unRows} 行共含 ${unLeaves} 个字段叶子，全部计入「漏抽」`);
console.log(`  → 占 Sheet3 全部漏抽 ${pc(unLeaves, perSheet[3].missed)}，占 Sheet3 全部分母 ${pc(unLeaves, den(S3))}`);
console.log(`  → 只把"行没配上"这一项修好（未配对叶子按命中算），Sheet3 上限 ${pc(wsum(S3) + unLeaves, den(S3))}`);

/*
 * ⚠️ 这一步才是关键：**未配对 ≠ 没抽到**。
 *
 * 配对是 1:1 贪心（`alignOutcomes`），一个产物行只能被一个金标准行用。
 * 于是同一个结局在两边"拆行口径"不同时（金标准按子量表/维度/组别拆、
 * 流水线按自己的粒度拆），必然有一边的行落空——而它在产物里其实是有数据的。
 * 不拆开就会把"配不上"当成"抽不到"，去改提示词，白费力气。
 */
const whyAll = why.A1.l + why.A2.l + why.B.l;
console.log(`\n  未配对的成因（按**叶子**加权，这才是失分口径）：`);
const wline = (label, o) => console.log(`    ${pad(label, 46)}${padr(o.r, 6)}${padr(o.l, 8)}${padr(pc(o.l, whyAll), 8)}`);
wline('A1 产物里有同一结局，被别的金标准行抢走', why.A1);
wline('A2 只有数值凑巧重合的"假候选"', why.A2);
wline('B  产物里没有任何接近的结局', why.B);
console.log(`\n    → **${pc(why.A1.l, whyAll)} 的"漏抽"其实是"抽到了、但在别的行里"**（行数口径 ${pc(why.A1.r, unRows)}）。`);
console.log(`    → A1 里"产物只有唯一一行、金标准却有两行要它"的：${a1Single}/${why.A1.r} 行。`);
console.log(`\n  反方向：${pRows - aRows} 个没被用上的产物行`);
console.log(`    与某金标准行文本高度相似 → 同一结局被流水线拆成多行  ${String(pDup).padStart(5)} 行`);
console.log(`    与任何金标准行都不像 → 金标准没收的多抽结局（无害）    ${String(pOther).padStart(5)} 行`);
console.log(`  → 两边都在拆行：同一个结局在两边落在不同行号上，1:1 配对必然有一边落空。`);

console.log(`\n  ── A1 样例（真抽到了，被抢走）──`);
for (const s of samplesA1) {
  console.log(`    ${pad(s.id, 10)}金「${s.gName.slice(0, 30)}」(${s.leaves}叶)`);
  console.log(`              → 产物「${s.pName.slice(0, 30)}」${s.by ? ` 已被金标准行「${s.by.slice(0, 22)}」占用` : ''}  [文本${s.text.toFixed(2)} 数值${s.corr} 候选${s.n}]`);
}
console.log(`\n  ── A2 / B 样例（产物里没有这个结局）──`);
for (const s of samplesNo) {
  console.log(`    ${pad(s.id, 10)}金「${s.gName.slice(0, 30)}」(${s.leaves}叶)  最接近：「${s.pName.slice(0, 30)}」` +
    `${s.text === undefined ? '' : `  [文本${s.text.toFixed(2)} 数值${s.corr}]`}`);
}

console.log(`\n  未配对行里最"贵"的（叶子多 = 一行拖垮一整篇）：`);
for (const r of worstRows.slice(0, 6)) console.log(`    ${pad(r.id, 10)}${padr(`${r.leaves} 叶子`, 10)}${String(r.name).slice(0, 46)}`);

/* ------------------------------ §4 失分榜 ------------------------------ */

/*
 * 字段级失分榜。`judged.` 前缀的键与严格比较的键共享同一命名空间
 * （`<scope>.<field>`），只是多了一层前缀，所以合并时按去掉前缀的键对齐。
 */
const merged = new Map();
for (const [k, s] of byField) {
  const key = k.replace(/^judged\./, '');
  if (!merged.has(key)) merged.set(key, { s: mk(), semantic: mk() });
  add(k.startsWith('judged.') ? merged.get(key).semantic : merged.get(key).s, s);
}
const rank = [...merged.entries()]
  .map(([key, m]) => {
    const all = mk(); add(all, m.s); add(all, m.semantic);
    return { key, strict: m.s, semantic: m.semantic, all, L: lost(all), d: den(all) };
  })
  .filter((r) => r.d > 0)
  .sort((a, b) => b.L - a.L);

console.log(`\n§4 失分最多的字段 Top ${TOP}\n`);
console.log(`  ${pad('字段', 44)}${padr('失分', 7)}${padr('占全部', 8)}${padr('分母', 7)}${padr('准确率', 8)}${padr('主导错误', 22)}`);
for (const r of rank.slice(0, TOP)) {
  const s = r.all;
  const mode = s.missed + s.wrong === 0 ? '—'
    : s.missed >= s.wrong ? `漏抽 ${s.missed}`
      : `抽错 ${s.wrong}`;
  const extra = s.extra ? `（另多 ${s.extra}）` : '';
  console.log(`  ${pad(r.key, 44)}${padr(n1(r.L), 7)}${padr(pc(r.L, lost(total)), 8)}${padr(r.d, 7)}${padr(pc(wsum(s), r.d), 8)}${pad(mode + extra, 22)}`);
}
/*
 * ⚠️ 这张榜**不等于**全部失分。
 * 金标准整行没配上时，`llm_eval.mjs` 只把叶子数加到工作表合计，不记到字段名上，
 * 因此"未配对行"这一大块在榜上是**看不到**的。差额必须显式说清，
 * 否则会误以为失分全在这些字段里。
 */
const attributed = rank.reduce((a, r) => a + r.L, 0);
console.log(`\n  榜上 ${rank.length} 个字段合计失分 ${n1(attributed)} = 全部失分的 ${pc(attributed, lost(total))}`);
console.log(`  另有 ${n1(lost(total) - attributed)} 分（${pc(lost(total) - attributed, lost(total))}）**无法归到任何字段**——`);
console.log(`  即「金标准整行没配对」那部分（见 §3），这是唯一一块"没有字段名可改"的失分。`);

/* ------------------------------ §5 Sheet3 分层 ------------------------------ */

const s3 = rank.filter((r) => sheetOf(r.key) === 3);
const fam = { leaf: new Map(), timepoint: new Map(), kind: new Map(), meta: new Map() };
const bump = (m, k, s) => { if (!m.has(k)) m.set(k, mk()); add(m.get(k), s); };
for (const r of s3) {
  const bare = r.key.replace(/^judged\./, '');
  if (/^outcome\./.test(bare) || /^followUp\./.test(bare)) { bump(fam.meta, bare.split('.')[0], r.all); continue; }
  const seg = bare.split('.');
  const leaf = seg.at(-1);
  bump(fam.leaf, leaf, r.all);
  if (seg.length >= 2) bump(fam.timepoint, seg[0], r.all);
  if (seg.length >= 2) bump(fam.kind, seg[1], r.all);
}

const dump = (title, m, n) => {
  const rows = [...m.entries()].map(([k, s]) => ({ k, s, L: lost(s) })).sort((a, b) => b.L - a.L).slice(0, n);
  console.log(`\n  ── ${title} ──`);
  for (const r of rows) {
    console.log(`    ${pad(r.k, 30)}${padr(n1(r.L), 8)}${padr(pc(r.L, attributed), 9)}${padr(r.s.missed, 7)}${padr(r.s.wrong, 7)}${padr(pc(wsum(r.s), den(r.s)), 8)}`);
  }
};
console.log('\n§5 Sheet3 分层（按"丢了多少分"排；列：失分 / 占可归属失分 / 漏抽 / 抽错 / 准确率）');
console.log('  ⚠️ 这里的失分只含"能落到字段名上"的部分，不含 §3 的整行未配对，故占比之和小于 100%。');
dump('按叶子名（跨所有时点与变量类型）', fam.leaf, 16);
dump('按时点', fam.timepoint, 10);
dump('按变量类型', fam.kind, 10);
dump('按结局元信息块', fam.meta, 6);

/* ------------------------------ §6 值级对照 ------------------------------ */

if (FIELD) {
  console.log(`\n§6 值级对照：${FIELD}（判断是"模型抽错"还是"口径/词表不一致"）\n`);
  /*
   * 把金标准与产物都拍平成 `<snake 路径>`，再按路径 join。
   * 产物的每段都过 camelToSnake，这样 `timepoints.endOfTreatment.continuous.ciLower`
   * 与金标准的 `timepoints.end_of_treatment.continuous.ci_lower` 能对上。
   */
  const flat = (node, prefix, out, conv) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v) => flat(v, prefix, out, conv)); return; }
    if (typeof node.raw === 'string') { out.push([prefix, node.raw, node.code]); return; }
    for (const [k, v] of Object.entries(node)) {
      flat(v, prefix ? `${prefix}.${conv(k)}` : conv(k), out, conv);
    }
  };
  const want = FIELD.replace(/^judged\./, '');
  /*
   * 路径匹配要放宽，因为评测的字段键省掉了两段信息：
   *   1. 金标准的时点叶子带 `timepoints.` 前缀；
   *   2. 组别段（`experimental` / `control`）被省掉——`byField` 的键是
   *      `end_of_treatment.continuous.ci_lower`，而金标准里是
   *      `timepoints.end_of_treatment.continuous.experimental.ci_lower`；
   *   3. `comparison.` / `article.` 这类作用域前缀在叶子路径里也没有。
   * 做法：把 want 的各段当作**子序列**在路径里按序找，找齐即算命中。
   */
  const wseg = want.split('.');
  const forms = [wseg, wseg.slice(1)];
  const match = (p) => forms.some((f) => {
    if (!f.length) return false;
    let i = 0;
    for (const s of p.split('.')) if (i < f.length && s === f[i]) i++;
    return i === f.length;
  });
  const pairs = [];
  for (const y of yearsLoaded) {
    const gf = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(gf)) continue;
    const gold = JSON.parse(readFileSync(gf, 'utf8'));
    for (const art of gold.articles ?? []) {
      const pf = join(ROOT, 'build', 'extraction', y, `${art.article_id}.json`);
      if (!existsSync(pf)) continue;
      const pred = JSON.parse(readFileSync(pf, 'utf8'));
      const gl = []; const pl = [];
      /*
       * 三层都要拍平：结局层 + 比较组层 + 文章层。
       * 只拍结局层的话，`--field comparison.dropout_total` 会查出 0 个值，
       * 看起来像"这个字段没数据"，其实是根本不在这里找。
       */
      flat(art.article ?? {}, '', gl, (k) => k);
      flat(pred.article ?? {}, '', pl, (k) => camelToSnake(k));
      for (const c of art.comparisons ?? []) flat(c, '', gl, (k) => k);
      for (const c of pred.comparisons ?? []) flat(c, '', pl, (k) => camelToSnake(k));
      for (const row of art.outcomes ?? []) flat(row, '', gl, (k) => k);
      for (const row of pred.outcomes ?? []) flat(row, '', pl, (k) => camelToSnake(k));
      const pv = pl.filter(([p]) => match(p)).map(([, v]) => v);
      const gv = gl.filter(([p]) => match(p)).map(([, v]) => v);
      if (!gv.length) continue;
      pairs.push({ id: art.article_id, gold: gv, pred: pv });
    }
  }
  const mismatch = pairs.filter((p) => JSON.stringify(p.gold) !== JSON.stringify(p.pred));
  console.log(`  有金标准值的篇章 ${pairs.length}，完全一致 ${pairs.length - mismatch.length}，不一致 ${mismatch.length}（${pc(mismatch.length, pairs.length)} 不一致）`);
  console.log(`\n  不一致样例（金标准 → 产物）：`);
  for (const p of mismatch.slice(0, LIMIT)) {
    console.log(`    ${pad(p.id, 10)}金=[${p.gold.join(', ')}]  产物=[${p.pred.join(', ') || '（缺）'}]`);
  }
  /* 混淆对统计：找出"系统性映射错"，这种是口径问题而不是能力问题 */
  const conf = new Map();
  for (const p of mismatch) {
    if (p.gold.length === 1 && p.pred.length === 1) {
      const k = `${p.gold[0]} → ${p.pred[0]}`;
      conf.set(k, (conf.get(k) ?? 0) + 1);
    }
  }
  const top = [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIMIT);
  if (top.length) {
    console.log(`\n  最常见的「金标准值 → 产物值」（1 对 1 的情形；集中 = 系统性映射问题，分散 = 真抽错）：`);
    for (const [k, c] of top) console.log(`    ${padr(`${c} 次`, 8)}${k}`);
  }
}

/* ------------------------------ §7 叶子逐路径分解 ------------------------------ */

if (LEAF) {
  /*
   * 最有用的一个诊断：把某个叶子的**每一个金标准实例**归到四类之一。
   *
   * 为什么不能只看 §4 的"漏抽/抽错"：那个数字把两种完全不同的东西混在一起——
   *   · 金标准整行没配上（粒度/口径问题，改提示词没用，得改配对或改纳入范围）；
   *   · 配上了但这一格没值（真漏抽，改提示词有用）。
   * 拆开之后"该改什么"才明确。
   *
   * ⚠️ 判等必须复刻评测：`normText` 之后还要过 `numericEqual`
   * （否则 `0.7` vs `0.70` 会被误报成"真抽错"，实测能虚增 1/6 的错）。
   */
  const eq = (a, b) => {
    const x = normText(a); const y = normText(b);
    return x === y || numericEqual(x, y);
  };
  const flat2 = (node, prefix, out, conv) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v) => flat2(v, prefix, out, conv)); return; }
    if (typeof node.raw === 'string') { out.push([prefix, node.raw]); return; }
    for (const [k, v] of Object.entries(node)) flat2(v, prefix ? `${prefix}.${conv(k)}` : conv(k), out, conv);
  };
  const leavesOf = (row, conv) => { const o = []; flat2(row, '', o, conv); return new Map(o); };

  let A = 0, B = 0, C = 0, D = 0;
  const diffs = [];
  for (const y of yearsLoaded) {
    const gf = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(gf)) continue;
    for (const art of JSON.parse(readFileSync(gf, 'utf8')).articles ?? []) {
      const pf = join(ROOT, 'build', 'extraction', y, `${art.article_id}.json`);
      if (!existsSync(pf)) continue;
      const pred = JSON.parse(readFileSync(pf, 'utf8'));
      const g = art.outcomes ?? [];
      const p = pred.outcomes ?? [];
      const { goldToPred } = alignOutcomes(g, p);
      g.forEach((row, i) => {
        const gl = [...leavesOf(row, (k) => k)].filter(([k]) => k.split('.').at(-1) === LEAF);
        if (!gl.length) return;
        const pi = goldToPred.get(i);
        if (pi === undefined) { A += gl.length; return; }
        const pl = leavesOf(p[pi], (k) => camelToSnake(k));
        for (const [k, gv] of gl) {
          if (!pl.has(k)) { B++; continue; }
          if (eq(gv, pl.get(k))) D++;
          else { C++; if (diffs.length < 400) diffs.push({ id: art.article_id, k, gv, pv: pl.get(k) }); }
        }
      });
    }
  }
  const tot = A + B + C + D;
  console.log(`\n§7 叶子「${LEAF}」逐路径分解（金标准叶子实例 ${tot} 个）\n`);
  if (!tot) {
    console.log('  没找到这个叶子——确认名字拼写，或用 §5 的叶子榜照着抄。');
  } else {
    const line = (n, label, v) => console.log(`  ${pad(label, 34)}${padr(v, 7)}${padr(`${((v / tot) * 100).toFixed(1)}%`, 8)}`);
    line('A', '金标准整行未配对 → 计漏抽', A);
    line('B', '配对行里同路径没值 → 真漏抽', B);
    line('C', '同路径有值但不等 → 真抽错', C);
    line('D', '同路径有值且相等 → 命中', D);
    console.log(`\n  只看配对上的行：${pc(D, B + C + D)}    含未配对行：${pc(D, tot)}`);
    console.log(`  → "整行未配对"这一项 ${pc(A, tot)} 是**改提示词改不动**的（属配对/纳入范围问题）；`);
    console.log(`    真正靠抽取改进能拿下的是 B+C = ${pc(B + C, tot)}。`);
    const byId = new Map();
    for (const d of diffs) byId.set(d.id, (byId.get(d.id) ?? 0) + 1);
    if (byId.size) {
      console.log(`\n  C 类集中在哪几篇：${[...byId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}(${v})`).join(' ')}`);
      console.log(`  C 类样例（金 → 产）：`);
      for (const d of diffs.slice(0, LIMIT)) console.log(`    ${pad(d.id, 10)}${pad(d.k.replace(/\.(experimental|control)\./, '.'), 44)} ${d.gv} → ${d.pv}`);
    }
  }
}

console.log('');
