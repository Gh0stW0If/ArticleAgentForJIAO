/**
 * **覆盖率口径**评测：只问"金标准要的结局，机器给了没有"。
 *
 * 与现行严格口径（`llm_eval.mjs`）的区别：
 *
 *   严格口径   结局行 1:1 配对。金标准两行、产物一行 → 必有一行整行计漏抽；
 *              产物多出来的行全算 `extra`（不进分母，但也永不被承认）。
 *   覆盖率口径 **多对一 / 一对多都允许**：金标准一行只要在产物里找得到对应结局
 *              就算覆盖到。产物里金标准没要的行**不判错**，转为"人工裁定"队列
 *              —— 多抽的可以裁掉，漏抽的才是硬伤。
 *
 * 为什么需要它：实测 1108 个金标准结局行里只有 775 行能 1:1 配上，
 * 而未配上的 333 行里约 42%（按叶子）其实**在产物里是有数据的**，
 * 只是那一行被另一个金标准行占走了（金标准按子量表/维度拆、产物按自己的粒度拆）。
 * 那把"配不上"当"抽不到"，会去改提示词，白费力气。
 *
 * ⚠️ 两个必须明确的设计选择（本工具把两种都算出来，差 6pt，不能含糊）：
 *
 *   1. **候选边认不认"数值佐证"**。对齐器的边是 `score >= MIN_SCORE`，
 *      而 score 含 `corrBonus`（数值重合 ≥2 就 +0.5），光靠这个就能越过阈值 ——
 *      于是"文本分 0.00 + 数值 2"也成了边。它有时是对的（2015-01 的
 *      fibromyalgia ↔ pain intensity 数值全对），有时是纯噪声。所以四个阶梯里
 *      (a) 认、(b)(c)(d) 不认，用来隔离这部分影响。
 *
 *   2. **一个产物叶子能不能重复供给多个金标准行**。
 *      · 允许复用 (c)：同一个值可以同时满足两个金标准行 → 数字偏高，是上界；
 *      · 叶子级消耗 (d)：一个产物叶子只算一次 → 保守，不会把同一个值算两遍。
 *      **推荐 (d)**：金标准真按两个组拆行、产物只抽了一组时，不该给两次分。
 *
 * 用法：
 *   node tools/coverage_eval.mjs            # 全部年份
 *   node tools/coverage_eval.mjs --year 2025
 *   node tools/coverage_eval.mjs --json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outcomeSimilarity, MIN_SCORE, normText } from './lib/align.mjs';
import { camelToSnake } from './lib/keys.mjs';
import { numericEqual } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const AS_JSON = argv.includes('--json');
const ALL_YEARS = ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
const YEARS = ONLY_YEAR ? [ONLY_YEAR] : ALL_YEARS;

/** 与评测一致的判等：先文本归一，再交给 numericEqual（`0.7` 与 `0.70` 算同一个数） */
const eq = (a, b) => {
  const x = normText(a); const y = normText(b);
  return x === y || numericEqual(x, y);
};

const flat = (node, prefix, out, conv) => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((v) => flat(v, prefix, out, conv)); return; }
  if (typeof node.raw === 'string') { out.push([prefix, node.raw]); return; }
  for (const [k, v] of Object.entries(node)) flat(v, prefix ? `${prefix}.${conv(k)}` : conv(k), out, conv);
};
const leavesOf = (row, conv) => { const o = []; flat(row, '', o, conv); return o; };

/** 行级 1:1 贪心（与 align.mjs 的 alignOutcomes 同一策略，这里可换不同边集） */function oneToOne(rows, preds, adj) {
  const cand = [];
  for (let gi = 0; gi < rows.length; gi++) {
    for (const pi of adj[gi]) cand.push({ gi, pi, s: outcomeSimilarity(rows[gi], preds[pi]).score });
  }
  cand.sort((a, b) => b.s - a.s);
  const g2p = new Map(); const usedP = new Set();
  for (const { gi, pi } of cand) {
    if (g2p.has(gi) || usedP.has(pi)) continue;
    g2p.set(gi, pi); usedP.add(pi);
  }
  return g2p;
}

const acc = {
  a: { h: 0, w: 0, m: 0 }, b: { h: 0, w: 0, m: 0 },
  c: { h: 0, w: 0, m: 0 }, d: { h: 0, w: 0, m: 0 },
  e: { h: 0, w: 0, m: 0 },
  f: { h: 0, w: 0, m: 0 },
  g: { h: 0, w: 0, m: 0 },
  h: { h: 0, w: 0, m: 0 },
};
/** (h) 修正边下的产物行去向 */
let covNeededRows = 0, covDeferRows = 0, covDeferLeaves = 0;
/** 金标准叶子实例里，有多少是"同一篇内重复的要求"（同路径 + 同值） */
let gLeafAll = 0, gLeafDup = 0;
let gRows = 0, pRows = 0, nArts = 0;
let rowsA = 0, rowsB = 0, rowsC = 0;
let pUsedC = 0, pDeferC = 0, pDeferLeaves = 0;
const perYear = [];

for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const py = { year: y, gRows: 0, pRows: 0, covRows: 0, defer: 0, deferLeaves: 0, acc: { h: 0, w: 0, m: 0 } };
  const before = { ...acc.d };
  for (const art of JSON.parse(readFileSync(gf, 'utf8')).articles ?? []) {
    const pf = join(ROOT, 'build', 'extraction', y, `${art.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    const rows = art.outcomes ?? [];
    const preds = pred.outcomes ?? [];
    if (!rows.length) continue;
    nArts++;
    gRows += rows.length; pRows += preds.length;
    py.gRows += rows.length; py.pRows += preds.length;

    /* 三套候选边 */
    const adjS = rows.map(() => []);   // score ≥ MIN（含 construct/subconstruct 加成）
    const adjT = rows.map(() => []);   // textScore ≥ MIN
    const adjC = rows.map(() => []);   // ★ 修正边：textScore ≥ MIN **或** 数值佐证 ≥2
    for (let gi = 0; gi < rows.length; gi++) {
      for (let pi = 0; pi < preds.length; pi++) {
        const s = outcomeSimilarity(rows[gi], preds[pi]);
        if (s.score >= MIN_SCORE) adjS[gi].push(pi);
        if (s.textScore >= MIN_SCORE) adjT[gi].push(pi);
        if (s.textScore >= MIN_SCORE || s.corr >= 2) adjC[gi].push(pi);
      }
    }
    const g2pS = oneToOne(rows, preds, adjS);
    const g2pT = oneToOne(rows, preds, adjT);
    rowsA += g2pS.size; rowsB += g2pT.size;

    /* 多对一：金标准行只要有任一文本候选就算覆盖 */
    const usedC = new Set();
    for (let gi = 0; gi < rows.length; gi++) {
      if (!adjT[gi].length) continue;
      rowsC++; py.covRows++;
      for (const pi of adjT[gi]) usedC.add(pi);
    }
    pUsedC += usedC.size;
    for (let pi = 0; pi < preds.length; pi++) {
      if (usedC.has(pi)) continue;
      pDeferC++; py.defer++;
      const n = leavesOf(preds[pi], (k) => camelToSnake(k)).length;
      pDeferLeaves += n; py.deferLeaves += n;
    }

    /* 产物叶子池（带行号）：供 (d) 做"只在本行候选内"的消耗式匹配 */
    const pool = new Map();
    for (let pi = 0; pi < preds.length; pi++) {
      for (const [path, val] of leavesOf(preds[pi], (k) => camelToSnake(k))) {
        if (!pool.has(path)) pool.set(path, []);
        pool.get(path).push({ pi, val, used: false });
      }
    }

    /*
     * (e) 的原料：把金标准叶子收敛成**去重后的要求**（同一篇内 同路径+同值 只算一条）。
     * 金标准自己会重复（2015-04 里 depression 出现两次），重复的要求不该要求机器交两份。
     */
    const req = new Map();
    /* (f)：与 (e) 同样去重，但候选边用 score（含数值佐证）—— 用来和现行 (a) 苹果对苹果 */
    const reqS = new Map();
    /* (h)：★ 去重 + 多对一 + **修正边**（textScore ≥ MIN 或 数值佐证 ≥2） */
    const reqC = new Map();

    for (let gi = 0; gi < rows.length; gi++) {
      const byPath = (pi) => {        const m = new Map();
        if (pi === undefined) return m;
        for (const [p, v] of leavesOf(preds[pi], (k) => camelToSnake(k))) {
          if (!m.has(p)) m.set(p, []);
          m.get(p).push(v);
        }
        return m;
      };
      const aLeaf = byPath(g2pS.get(gi));
      const bLeaf = byPath(g2pT.get(gi));
      const cLeaf = new Map();
      for (const pi of adjT[gi]) {
        for (const [p, v] of leavesOf(preds[pi], (k) => camelToSnake(k))) {
          if (!cLeaf.has(p)) cLeaf.set(p, []);
          cLeaf.get(p).push(v);
        }
      }
      /* (g) 用同一套"多对一"，但候选边换成 score（含数值佐证） */
      const sLeaf = new Map();
      for (const pi of adjS[gi]) {
        for (const [p, v] of leavesOf(preds[pi], (k) => camelToSnake(k))) {
          if (!sLeaf.has(p)) sLeaf.set(p, []);
          sLeaf.get(p).push(v);
        }
      }
      for (const [path, gval] of leavesOf(rows[gi], (k) => k)) {
        gLeafAll++;
        const rk = `${path}\u0000${normText(gval)}`;
        if (req.has(rk)) { req.get(rk).dup = true; gLeafDup++; }
        else req.set(rk, { path, gval, cands: new Set(), dup: false });
        for (const pi of adjT[gi]) req.get(rk).cands.add(pi);
        if (!reqS.has(rk)) reqS.set(rk, { path, gval, cands: new Set() });
        for (const pi of adjS[gi]) reqS.get(rk).cands.add(pi);
        if (!reqC.has(rk)) reqC.set(rk, { path, gval, cands: new Set() });
        for (const pi of adjC[gi]) reqC.get(rk).cands.add(pi);
        const bump = (o, list) => {
          if (!list || !list.length) o.m++;
          else if (list.some((v) => eq(gval, v))) o.h++;
          else o.w++;
        };
        bump(acc.a, aLeaf.get(path));
        bump(acc.b, bLeaf.get(path));
        bump(acc.c, cLeaf.get(path));
        /* (g) score 边 + 多对一 + 不去重 —— 用来把 (a)→(f) 的效果拆成两半 */
        bump(acc.g, sLeaf.get(path));
        const dv = (pool.get(path) ?? []).filter((x) => !x.used && adjT[gi].includes(x.pi));
        const exact = dv.find((x) => eq(gval, x.val));
        if (exact) { exact.used = true; acc.d.h++; }
        else if (dv.length) { dv[0].used = true; acc.d.w++; }
        else acc.d.m++;
      }
    }

    /* (e)/(f) 收尾：把去重后的要求逐条判定 */
    const scoreReq = (r, o) => {
      if (!r.cands.size) { o.m++; return; }
      let hasPath = false, hasEq = false;
      for (const pi of r.cands) {
        for (const [p, v] of leavesOf(preds[pi], (k) => camelToSnake(k))) {
          if (p !== r.path) continue;
          hasPath = true;
          if (eq(r.gval, v)) { hasEq = true; break; }
        }
        if (hasEq) break;
      }
      if (hasEq) o.h++;
      else if (hasPath) o.w++;
      else o.m++;
    };
    for (const r of req.values()) scoreReq(r, acc.e);
    for (const r of reqS.values()) scoreReq(r, acc.f);
    for (const r of reqC.values()) scoreReq(r, acc.h);

    /* 修正边下的"无人要"产物行 = 人工裁定队列 */
    {
      const used = new Set();
      for (const list of adjC) for (const pi of list) used.add(pi);
      for (let pi = 0; pi < preds.length; pi++) {
        if (used.has(pi)) continue;
        covDeferRows++; covDeferLeaves += leavesOf(preds[pi], (k) => camelToSnake(k)).length;
      }
      covNeededRows += used.size;
    }
  }
  py.acc.h = acc.d.h - before.h;
  py.acc.w = acc.d.w - before.w;
  py.acc.m = acc.d.m - before.m;
  perYear.push(py);
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const rateOf = (o) => { const d = o.h + o.w + o.m; return d ? (o.h / d) * 100 : 0; };
const line = (name, o) => {
  const d = o.h + o.w + o.m;
  console.log(`  ${name.padEnd(36)}${String(d).padStart(7)}${String(o.h).padStart(8)}${String(o.w).padStart(7)}${String(o.m).padStart(7)}${pct(o.h, d).padStart(8)}`);
};

if (AS_JSON) {
  const OUT = arg('out', null);
  const payload = {
    years: perYear.map((p) => ({ year: p.year, gRows: p.gRows, pRows: p.pRows, coveredRows: p.covRows, deferredRows: p.defer, deferredLeaves: p.deferLeaves, coverageRate: p.gRows ? (p.covRows / p.gRows) * 100 : 0, accD: rateOf(p.acc) })),
    total: {
      gRows, pRows, coveredRows: rowsC,
      coverageRate: gRows ? (rowsC / gRows) * 100 : 0,
      oneToOneScore: pct(rowsA, gRows), oneToOneText: pct(rowsB, gRows),
      deferredRows: pDeferC, deferredLeaves: pDeferLeaves,
      a: { ...acc.a, rate: rateOf(acc.a) }, b: { ...acc.b, rate: rateOf(acc.b) },
      c: { ...acc.c, rate: rateOf(acc.c) }, d: { ...acc.d, rate: rateOf(acc.d) },
      e: { ...acc.e, rate: rateOf(acc.e) }, f: { ...acc.f, rate: rateOf(acc.f) }, g: { ...acc.g, rate: rateOf(acc.g) },
      h: { ...acc.h, rate: rateOf(acc.h) },
      correctedNeededRows: covNeededRows, correctedDeferredRows: covDeferRows, correctedDeferredLeaves: covDeferLeaves,
      goldLeafInstances: gLeafAll, goldLeafDuplicates: gLeafDup,
    },
  };
  if (OUT) { writeFileSync(resolve(ROOT, OUT), JSON.stringify(payload, null, 1), 'utf8'); console.log(`已写入 ${OUT}`); }
  else console.log(JSON.stringify(payload, null, 1));
  process.exit(0);
}

console.log(`\n══ 覆盖率口径 vs 严格口径（Sheet3 结局层，${YEARS.length} 年 / ${nArts} 篇）══\n`);
console.log(`  结局行：金标准 ${gRows} 行 ／ 产物 ${pRows} 行（${(pRows / gRows).toFixed(2)} 倍）`);
console.log(`    现行 1:1（score 边，含数值佐证）   ${String(rowsA).padStart(4)} 行  ${pct(rowsA, gRows)}`);
console.log(`    1:1 但只认文本                    ${String(rowsB).padStart(4)} 行  ${pct(rowsB, gRows)}`);
console.log(`    **覆盖率口径（多对一）**          ${String(rowsC).padStart(4)} 行  ${pct(rowsC, gRows)}`);

console.log(`\n  产物行的去向（${pRows} 行）：`);
console.log(`    被金标准需要        ${String(pUsedC).padStart(4)} 行`);
console.log(`    金标准没要 → 人工裁定 ${String(pDeferC).padStart(4)} 行（含 ${pDeferLeaves} 个叶子，≈ 每篇 ${(pDeferC / nArts).toFixed(1)} 行）`);

console.log(`\n  叶子级（分母 = 同一批金标准叶子实例，四个口径可直接比）：`);
console.log(`  ${'口径'.padEnd(34)}${'分母'.padStart(8)}${'命中'.padStart(8)}${'错'.padStart(7)}${'漏'.padStart(7)}${'准确率'.padStart(8)}`);
line('(a) 现行：score 边 + 1:1', acc.a);
line('(b) 只认文本 + 1:1', acc.b);
line('(c) 只认文本 + 多对一 + 允许复用', acc.c);
line('(d) 只认文本 + 多对一 + 叶子级消耗 ★', acc.d);
line('(e) 要求去重 + 多对一（只认文本）', acc.e);
line('(f) 要求去重 + 多对一（score 边）★', acc.f);
line('(g) 不去重 + 多对一（score 边）', acc.g);
line('(h) ★ 去重 + 多对一 + 修正边（文本 或 数值佐证≥2）', acc.h);

console.log(`\n  ⚠️ (f)/(g) 用的 score 边**过宽**：sameConstruct(+0.25) + sameSub(+0.15) 就够到 0.40，`);
console.log(`     越过 MIN_SCORE=0.34 —— 于是每个产物行都是每个金标准行的候选，而所有结局行的`);
console.log(`     叶子路径结构相同 → "候选行里有这个路径"恒成立 → 漏抽退化到 0。`);
console.log(`     (h) 把边收紧成"名字像 **或** 数值重合 ≥2"，才是"保留数值佐证"的正确落法。`);

console.log(`\n  (h) 口径下的产物行去向：${pRows} 行里`);
console.log(`    被金标准需要        ${String(covNeededRows).padStart(4)} 行`);
console.log(`    金标准没要 → 人工裁定 ${String(covDeferRows).padStart(4)} 行（含 ${covDeferLeaves} 个叶子，≈ 每篇 ${(covDeferRows / nArts).toFixed(1)} 行）`);

console.log(`\n  ⭐ 与现行口径**同边定义**的净效果：(a) ${rateOf(acc.a).toFixed(1)}% → (f) ${rateOf(acc.f).toFixed(1)}%`
  + `（+${(rateOf(acc.f) - rateOf(acc.a)).toFixed(1)}pt）`);
console.log(`     拆开看：(a)→(g) ${(rateOf(acc.g) - rateOf(acc.a) >= 0 ? '+' : '')}${(rateOf(acc.g) - rateOf(acc.a)).toFixed(1)}pt = "多对一"本身`);
console.log(`             (g)→(f) ${(rateOf(acc.f) - rateOf(acc.g) >= 0 ? '+' : '')}${(rateOf(acc.f) - rateOf(acc.g)).toFixed(1)}pt = "金标准重复要求去重"`);

console.log(`\n  金标准叶子实例 ${gLeafAll} 个，其中**同一篇内重复的要求**（同路径+同值）${gLeafDup} 个（${pct(gLeafDup, gLeafAll)}）`);
console.log(`  → 这就是 (c)/(d) 差 6.4pt 的来源：金标准自己把同一份数据列了两行（如按组/按臂重复），`);
console.log(`     (c) 让一个产物叶子同时满足两行、(d) 只允许满足一行。`);
console.log(`     (e) 把重复要求收敛成一条，再要求机器**至少给出一个**匹配值 —— 最贴合"金标准要的，机器给了没有"。`);

console.log(`\n  怎么读这张表：`);
console.log(`    (a)→(b) 差 ${(rateOf(acc.a) - rateOf(acc.b)).toFixed(1)}pt —— "候选边认不认数值佐证"`);
console.log(`    (b)→(c) 差 ${(rateOf(acc.c) - rateOf(acc.b)).toFixed(1)}pt —— "允许多对一"本身`);
console.log(`    (c)→(d) 差 ${(rateOf(acc.c) - rateOf(acc.d)).toFixed(1)}pt —— "一个产物叶子能不能重复供给多个金标准行"`);

console.log(`\n  分年（覆盖率 / 叶子准确率(d)）：`);
for (const p of perYear) {
  console.log(`   ${p.year}  行覆盖 ${pct(p.covRows, p.gRows).padStart(6)}   叶子 ${(rateOf(p.acc).toFixed(1) + '%').padStart(6)}   人工裁定 ${String(p.defer).padStart(3)} 行`);
}
console.log('');
