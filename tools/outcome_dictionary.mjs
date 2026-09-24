/**
 * 目标结局字典 + 覆盖率三档测量。
 *
 * 用户问题：机器多抽的那些里，**金标准要的结局到底有没有被抽到**？
 * 能不能"从 Sheet3 的结局列总结一个目标结局字典，只取这些结局来比较"？
 *
 * 做法：
 *   1. 把 Sheet3 的 `OUTCOM`（结局名称）与 `INSTRU`（测量工具）全部取出、归一化、聚成"目标结局概念"
 *      → `build/outcome_dictionary.json`
 *   2. 用三档严格度测"金标准的这一行，机器的列表里有没有"：
 *        strict   = 现在的评测口径（Dice ≥0.34 / 词集包含）
 *        synonym  = 加缩写展开（qol↔quality of life、vas↔visual analogue scale…）
 *        concept  = 加词形近似（depression≈depressive）+ 内容词相交
 *   3. 报告每一档能把多少"漏"变成"配上"
 *
 * 用法：node tools/outcome_dictionary.mjs [--json] [--show]
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes } from './lib/align.mjs';
import { RANK, presentIn, tokenSet as conceptTokenSet } from './lib/outcome_match.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const nm = (o) => String(o?.outcome?.name?.raw ?? '').trim();
const ins = (o) => String(o?.outcome?.instrument?.raw ?? '').trim();
const pair = (o) => `${nm(o)}｜${ins(o)}`;

/* ── 与评测同口径：整行错位的金标准行不参与 ── */
const excluded = new Map();
{
  const f = join(ROOT, 'build', 'gold_row_anomalies.json');
  if (existsSync(f)) for (const x of JSON.parse(readFileSync(f, 'utf8')).findings ?? []) {
    if (!excluded.has(x.articleId)) excluded.set(x.articleId, new Set());
    excluded.get(x.articleId).add(x.rowIndex);
  }
}

/* ── 1. 收集金标准结局词表 ── */
const goldRows = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const g = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of g.articles ?? []) {
    const skip = excluded.get(a.article_id);
    (a.outcomes ?? []).forEach((o, i) => {
      if (skip?.has(i)) return;
      goldRows.push({ year: y, id: a.article_id, idx: i, name: nm(o), instr: ins(o) });
    });
  }
}

/* ── 2. 聚成目标结局概念（用 concept 档的词集） ── */
const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));
const concepts = [];
for (const r of goldRows) {
  const tk = conceptTokenSet(`${r.name} ${r.instr}`, { synonym: true, concept: true });
  let hit = null;
  for (const c of concepts) {
    const a = [...tk].filter((t) => [...c.tokens].some((x) => near(t, x)));
    const b = [...c.tokens].filter((t) => [...tk].some((x) => near(t, x)));
    const d = (2 * a.length) / (tk.size + c.tokens.size);
    if ((tk.size > 0 && a.length === tk.size) || (c.tokens.size > 0 && b.length === c.tokens.size) || d >= 0.5) { hit = c; break; }
  }
  if (hit) { hit.rows.push(r); for (const t of tk) hit.tokens.add(t); }
  else concepts.push({ tokens: new Set(tk), rows: [r] });
}
concepts.sort((a, b) => b.rows.length - a.rows.length);
concepts.forEach((c, i) => { c.id = `O${String(i + 1).padStart(3, '0')}`; });

console.log('\n══ 金标准结局词表（Sheet3 的 OUTCOM + INSTRU）══\n');
console.log(`  结局行 ${goldRows.length} 行 → 不同写法 ${new Set(goldRows.map((r) => `${r.name}｜${r.instr}`)).size} 种`);
console.log(`  ★ 聚成目标结局概念 ${concepts.length} 个`);
console.log('\n  出现最多的目标结局（概念 → 覆盖行数 / 代表写法）：');
for (const c of concepts.slice(0, 18)) {
  console.log(`     ${c.id}  ${String(c.rows.length).padStart(3)} 行   ${String(c.rows[0].name).slice(0, 38)}｜${String(c.rows[0].instr).slice(0, 30)}`);
}

/* ── 3. 三档覆盖率 ── */
const cnt = { aligned: 0, strict: 0, synonym: 0, concept: 0 };
const upgrade = { synonym: [], concept: [] };
const stillMissing = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const g = JSON.parse(readFileSync(gf, 'utf8'));
  const byId = new Map((g.articles ?? []).map((a) => [a.article_id, a]));
  for (const fn of readdirSync(xd)) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const art = byId.get(id);
    if (!art) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const skip = excluded.get(id);
    const gO = (art.outcomes ?? []).filter((_, i) => !skip?.has(i));
    const origIdx = (art.outcomes ?? []).map((_, i) => i).filter((i) => !skip?.has(i));
    const pO = pred.outcomes ?? [];
    const { goldToPred } = alignOutcomes(gO, pO);
    for (const [gi, gr] of gO.entries()) {
      const aligned = goldToPred.has(gi);
      if (aligned) cnt.aligned++;
      const bStrict = presentIn(gr, pO, {});
      const bSyn = presentIn(gr, pO, { synonym: true });
      const bConc = presentIn(gr, pO, { synonym: true, concept: true });
      if (RANK[bStrict.level] >= 1) cnt.strict++;
      if (RANK[bSyn.level] >= 1) cnt.synonym++;
      if (RANK[bConc.level] >= 1) cnt.concept++;
      if (!aligned && RANK[bSyn.level] >= 1 && RANK[bStrict.level] === 0) upgrade.synonym.push({ id, gold: pair(gr), cand: pair(bSyn.row), how: bSyn.how });
      else if (!aligned && RANK[bConc.level] >= 1 && RANK[bSyn.level] === 0) upgrade.concept.push({ id, gold: pair(gr), cand: pair(bConc.row), how: bConc.how });
      if (RANK[bConc.level] === 0) stillMissing.push({ id, year: y, row: origIdx[gi] + 1, gold: pair(gr), goldRows: gO.length, predRows: pO.length });
    }
  }
}

const N = goldRows.length;
const pc = (a) => `${((a / N) * 100).toFixed(1)}%`;
console.log(`\n══ 覆盖率（分母 = 金标准有效结局行 ${N}）══\n`);
console.log(`  当前评测对齐配上                        ${String(cnt.aligned).padStart(4)}  ${pc(cnt.aligned)}`);
console.log(`  ① strict  档：机器列表里存在            ${String(cnt.strict).padStart(4)}  ${pc(cnt.strict)}`);
console.log(`  ② synonym 档（+缩写展开）               ${String(cnt.synonym).padStart(4)}  ${pc(cnt.synonym)}`);
console.log(`  ③ concept 档（+词形近似/内容词相交）      ${String(cnt.concept).padStart(4)}  ${pc(cnt.concept)}`);
console.log(`  ④ 三档都找不到（疑似真没抽）             ${String(stillMissing.length).padStart(4)}  ${pc(stillMissing.length)}`);
console.log(`\n  同义档相对严格档新找回 ${upgrade.synonym.length} 行；概念档再找回 ${upgrade.concept.length} 行`);
console.log(`  → 只要配对逻辑跟上，至少 ${cnt.concept - cnt.aligned} 行可以从未命中里收回`);

/* ── 4. 剩下那批"真没抽"长什么样 ── */
{
  const byArticle = new Map();
  for (const u of stillMissing) {
    const r = byArticle.get(u.id) ?? { id: u.id, n: 0, goldRows: u.goldRows, predRows: u.predRows };
    r.n++; byArticle.set(u.id, r);
  }
  const arts = [...byArticle.values()].sort((a, b) => b.n - a.n);
  const shortfall = arts.filter((a) => a.predRows < a.goldRows).length;
  console.log(`\n  "三档都找不到"的 ${stillMissing.length} 行分布在 ${arts.length} 篇；`);
  console.log(`  其中机器结局行数**少于**金标准的有 ${shortfall} 篇（机器只抽了主结局、没抽这些次要结局）`);
  console.log('  最集中的几篇（缺失行数 / 金标准行数 → 机器行数）：');
  for (const a of arts.slice(0, 12)) console.log(`     ${a.id}  ${String(a.n).padStart(2)} 行缺失   ${a.goldRows} → ${a.predRows}`);
  const missNames = new Map();
  for (const u of stillMissing) {
    const key = String(u.gold).split('｜')[1] || u.gold;
    missNames.set(key.slice(0, 34), (missNames.get(key.slice(0, 34)) ?? 0) + 1);
  }
  console.log('  最常缺失的（按"测量工具"看）：');
  for (const [k, v] of [...missNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(v).padStart(3)}×  ${k}`);
}

if (argv.includes('--json')) {
  writeFileSync(join(ROOT, 'build', 'outcome_dictionary.json'), JSON.stringify({
    source: 'Sheet3 OUTCOM + INSTRU',
    goldRows: N,
    distinctWritings: new Set(goldRows.map((r) => `${r.name}｜${r.instr}`)).size,
    conceptCount: concepts.length,
    coverage: { aligned: cnt.aligned, strict: cnt.strict, synonym: cnt.synonym, concept: cnt.concept, missing: stillMissing.length },
    concepts: concepts.map((c) => ({ id: c.id, rows: c.rows.length, tokens: [...c.tokens], examples: c.rows.slice(0, 8).map((r) => `${r.name}｜${r.instr}`) })),
    stillMissing,
  }, null, 1), 'utf8');
  console.log('\n已写入 build/outcome_dictionary.json');
}

/* ── 5. 人读文档 ── */
{
  const L = [];
  L.push('# 目标结局字典（从金标准 Sheet3 的 OUTCOM + INSTRU 总结）');
  L.push('');
  L.push('> 由 `tools/outcome_dictionary.mjs` 生成。数据源：`build/gold/<year>.json` 的结局行');
  L.push('> （原始表 Sheet3 的「结局名称」`OUTCOM` 与「测量工具名称」`INSTRU` 两列）。');
  L.push('');
  L.push('## 0. 为什么需要字典');
  L.push('');
  L.push('机器按提示词"列出论文报告的**全部**结局指标"，金标准只记它要的那几个 → 大量"多填"（见 `docs/21` §4.5）。');
  L.push('字典的用途有两个，**不要混为一谈**：');
  L.push('');
  L.push('| 用途 | 做法 | 预估收益 |');
  L.push('|---|---|---|');
  L.push('| **① 配对** | 评测时用字典把机器列表里的对应行找回来（现在只配上 ' + cnt.aligned + ' 行） | ' + (cnt.strict - cnt.aligned) + ' 行（字面口径）～ ' + (cnt.concept - cnt.aligned) + ' 行（概念口径） |');
  L.push('| **② 召回** | 把字典当"必查清单"塞进 `outcome-plan` 提示词，让模型逐项核对 | 针对 ' + stillMissing.length + ' 行缺失（' + new Set(stillMissing.map((x) => x.id)).size + ' 篇） |');
  L.push('');
  L.push('## 1. 规模');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('|---|---|');
  L.push(`| 金标准有效结局行 | ${N} |`);
  L.push(`| 不同写法（名称｜工具） | ${new Set(goldRows.map((r) => `${r.name}｜${r.instr}`)).size} |`);
  L.push(`| **聚成目标结局概念** | **${concepts.length}** |`);
  L.push(`| 当前评测对齐配上 | ${cnt.aligned}（${pc(cnt.aligned)}） |`);
  L.push(`| ① strict 档（现有字面口径）机器列表里存在 | ${cnt.strict}（${pc(cnt.strict)}） |`);
  L.push(`| ② synonym 档（+缩写展开） | ${cnt.synonym}（${pc(cnt.synonym)}） |`);
  L.push(`| ③ concept 档（+词形近似/内容词相交） | ${cnt.concept}（${pc(cnt.concept)}） |`);
  L.push(`| ④ 三档都找不到 | ${stillMissing.length}（${pc(stillMissing.length)}） |`);
  L.push('');
  L.push('> ⚠️ concept 档会引入假配对（实测：`qulity of life-physcial functioning｜SF-36` 被配到 `spinal functions｜ODI`）。');
  L.push('> **建议：评分用 strict/synonym 档，concept 档只用于召回提示。**');
  L.push('');
  L.push('## 2. 目标结局概念（按覆盖行数排序，前 60）');
  L.push('');
  L.push('| 概念 | 行数 | 关键词 | 金标准代表写法 |');
  L.push('|---|---|---|---|');
  for (const c of concepts.slice(0, 60)) {
    L.push(`| ${c.id} | ${c.rows.length} | ${[...c.tokens].slice(0, 8).join(' ')} | ${String(c.rows[0].name).slice(0, 40)}｜${String(c.rows[0].instr).slice(0, 34)} |`);
  }
  L.push('');
  L.push(`（完整 ${concepts.length} 个见 \`build/outcome_dictionary.json\`）`);
  L.push('');
  L.push(`## 3. 机器确实没抽到的 ${stillMissing.length} 行`);
  L.push('');
  L.push('| 文章 | 金标准行号 | 金标准写法 |');
  L.push('|---|---|---|');
  for (const u of stillMissing) L.push(`| ${u.id} | ${u.row} | ${String(u.gold).replace(/\|/g, '\\|')} |`);
  L.push('');
  writeFileSync(join(ROOT, 'docs', '23-outcome-dictionary.md'), L.join('\n'), 'utf8');
  console.log('已写入 docs/23-outcome-dictionary.md');
}

if (argv.includes('--show')) {
  console.log('\n── synonym 档新找回（前 30）──');
  for (const u of upgrade.synonym.slice(0, 30)) console.log(`  ${u.id}  gold: ${u.gold}\n        机器: ${u.cand}  [${u.how}]`);
  console.log('\n── concept 档新找回（前 30）──');
  for (const u of upgrade.concept.slice(0, 30)) console.log(`  ${u.id}  gold: ${u.gold}\n        机器: ${u.cand}  [${u.how}]`);
  console.log('\n── 三档都找不到（前 50）──');
  for (const u of stillMissing.slice(0, 50)) console.log(`  ${u.id} 第${u.row}行  ${u.gold}`);
}
