/**
 * 「多抽的是什么」——把某篇的**金标准结局行**与**机器结局行**并排打印，标出哪些是多余的。
 *
 * 用法：
 *   node tools/overfill_show.mjs 2017-14            # 并排看一篇
 *   node tools/overfill_show.mjs --stat             # 全库统计：704 个多出行里有多少真的带数值
 *   node tools/overfill_show.mjs --worst 8          # 多出行最多的 8 篇列表
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const SENT = /^\s*(NR|NA|NE|\.|-|)$/i;
const isSent = (s) => SENT.test(String(s ?? '').trim());

/** 收集一行里所有叶子 raw，返回 [路径, 值] */
function leaves(node, prefix = '', out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') { out.push([prefix, String(node)]); return out; }
  if ('raw' in node) { out.push([prefix, String(node.raw)]); return out; }
  if (Array.isArray(node)) return out;
  for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
/** 只保留"有实义"的叶子（排除 evidence/confidence/provenance 等） */
const SKIP = /(evidence|confidence|provenance|legend|code|missing|quote|bbox|blockId|page|kind)$/i;
const realLeaves = (row) => leaves(row).filter(([p, v]) => !SKIP.test(p) && !p.endsWith('raw') && !isSent(v));
/** 数值型实义叶子 */
const numLeaves = (row) => realLeaves(row).filter(([, v]) => /\d/.test(v) && !/^[A-Za-z]+$/.test(v));
/**
 * "真的有数据"的判据（排除编码/编号计数带来的虚高）：
 *   只认 timepoints.* 下的数值叶子、outcome.pValue、outcome.measurementRange。
 */
const NUMVAL = /^[<>≤≥~]?\s*-?\d+(\.\d+)?(\s*[-–~]\s*[-+]?\d+(\.\d+)?)?\s*%?$/;
const dataLeaves = (row) => leaves(row).filter(([p, v]) => {
  if (SKIP.test(p) || p.endsWith('raw')) return false;
  if (isSent(v)) return false;
  if (!/^timepoints\./.test(p) && !/(outcome\.pValue|outcome\.measurementRange)$/.test(p)) return false;
  return NUMVAL.test(String(v).trim());
});

const load = (y, id) => {
  const g = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
  const art = (g.articles ?? []).find((a) => a.article_id === id);
  const p = JSON.parse(readFileSync(join(ROOT, 'build', 'extraction', y, `${id}.json`), 'utf8'));
  return { art, pred: p };
};
const nm = (o, f = 'outcome') => `${o?.[f]?.name?.raw ?? '?'}｜${o?.[f]?.instrument?.raw ?? ''}`;
const brief = (rowsArr, max = 5) => rowsArr.slice(0, max).map(([p, v]) => `${p.replace(/^timepoints\./, 'tp.').replace(/\.experimental/, '·exp').replace(/\.control/, '·ctl')}=${v}`).join('  ');

/* ─────────── 单篇并排 ─────────── */
const target = process.argv[2];
if (target && !target.startsWith('--')) {
  const y = target.split('-')[0];
  const { art, pred } = load(y, target);
  const gOuts = art?.outcomes ?? []; const pOuts = pred.outcomes ?? [];
  const { goldToPred, usedPred } = alignOutcomes(gOuts, pOuts);
  console.log(`\n════ ${target}   金标准 ${gOuts.length} 行 / 机器 ${pOuts.length} 行 / 配上 ${usedPred.size} 对`);
  console.log(`\n── 金标准结局行 ──`);
  gOuts.forEach((o, i) => {
    const pi = goldToPred.get(i);
    console.log(` g${String(i + 1).padStart(2)} ${pi === undefined ? '（未配上）' : `→ p${pi + 1}`}  arm=${o.arm_number?.raw ?? '?'}  ${nm(o)}`);
    const dl = leaves(o).filter(([p, v]) => /(p_value|measurement_range)$/.test(p) && !isSent(v));
    const tp = leaves(o).filter(([p, v]) => /^timepoints\./.test(p) && !p.endsWith('raw') && !SKIP.test(p) && !isSent(v));
    console.log(`      实测值：p/量程 ${dl.map(([p, v]) => `${p.split('.').pop()}=${v}`).join(' ') || '—'}；时点 ${tp.length} 个叶子`);
  });
  console.log(`\n── 机器结局行（✗ = 多出来的）──`);
  pOuts.forEach((o, i) => {
    const extra = !usedPred.has(i);
    const dl = dataLeaves(o);
    console.log(` ${extra ? '✗' : ' '} p${String(i + 1).padStart(2)}  ${nm(o)}`);
    console.log(`      实测值 ${dl.length} 个：${brief(dl, 6) || '—'}`);
  });
  const extraRows = pOuts.filter((_, i) => !usedPred.has(i));
  const withNum = extraRows.filter((o) => numLeaves(o).length > 0);
  console.log(`\n小结：多出 ${extraRows.length} 行，其中 ${withNum.length} 行至少带 1 个数值，${extraRows.length - withNum.length} 行全空/NR。`);
  process.exit(0);
}

/* ─────────── 全库统计 ─────────── */
const rows = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const byId = new Map((gold.articles ?? []).map((a) => [a.article_id, a]));
  for (const fn of readdirSync(xd)) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const g = byId.get(id);
    if (!g) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const gO = g.outcomes ?? []; const pO = pred.outcomes ?? [];
    const { usedPred } = alignOutcomes(gO, pO);
    const extras = pO.filter((_, i) => !usedPred.has(i));
    rows.push({ y, id, gRows: gO.length, pRows: pO.length, matched: usedPred.size, extras, goldNames: gO.map((o) => String(o.outcome?.name?.raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean) });
  }
}
const allExtras = rows.flatMap((r) => r.extras);
const withNum = allExtras.filter((o) => numLeaves(o).length > 0);
const withData = allExtras.filter((o) => dataLeaves(o).length > 0);
console.log(`\n全部多出行 = ${allExtras.length} 行`);
console.log(`  ★ 带"论文实测数值"（timepoints 数值 / p 值 / 量程）：${withData.length} 行（${((withData.length / allExtras.length) * 100).toFixed(0)}%）`);
console.log(`    一个实测数值都没有（只有编码/名称的空壳）：${allExtras.length - withData.length} 行`);
const dHist = new Map();
for (const o of allExtras) { const k = Math.min(dataLeaves(o).length, 12); dHist.set(k, (dHist.get(k) ?? 0) + 1); }
console.log('    每行实测数值个数分布：' + [...dHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k === 12 ? '12+' : k}个=${v}`).join('  '));
console.log(`  （宽松口径，把编码/编号也算上：${withNum.length} 行带数字）`);
/* 多出行都填了哪些字段 */
const fieldHist = new Map();
for (const o of allExtras) for (const [p] of realLeaves(o)) {
  const key = p.split('.').slice(0, 2).join('.');
  fieldHist.set(key, (fieldHist.get(key) ?? 0) + 1);
}
console.log('\n  多出行里出现的字段（前 14）：' + [...fieldHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join('  '));
/* 多出行的结局名，金标准里有没有？ */
let sameName = 0; let newName = 0; const newNameHist = new Map(); const sameNameHist = new Map();
for (const r of rows) {
  const goldNames = new Set(r.goldNames ?? []);
  for (const o of r.extras) {
    const n = String(o.outcome?.name?.raw ?? '?').toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = [...goldNames].some((g) => g === n || g.includes(n) || n.includes(g));
    if (hit) { sameName++; sameNameHist.set(n.slice(0, 30), (sameNameHist.get(n.slice(0, 30)) ?? 0) + 1); }
    else { newName++; newNameHist.set(n.slice(0, 30), (newNameHist.get(n.slice(0, 30)) ?? 0) + 1); }
  }
}
console.log(`\n  ★ 按"结局名金标准里有没有"再拆：`);
console.log(`     金标准里也有这个名字（同一结局多出的行）：${sameName} 行（${((sameName / allExtras.length) * 100).toFixed(0)}%）`);
console.log(`     金标准里根本没有这个结局（范围差异）：    ${newName} 行（${((newName / allExtras.length) * 100).toFixed(0)}%）`);

/* 多出行的名字 */
const nameHist = new Map();
for (const o of allExtras) { const k = String(o.outcome?.name?.raw ?? '?').slice(0, 34); nameHist.set(k, (nameHist.get(k) ?? 0) + 1); }
console.log('\n  出现最多的多出结局名（前 14）：');
for (const [k, v] of [...nameHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`     ${String(v).padStart(3)}×  ${k}`);

if (process.argv.includes('--worst')) {
  const n = Number(process.argv[process.argv.indexOf('--worst') + 1] ?? 8);
  console.log(`\n  多出行最多的 ${n} 篇：`);
  for (const r of [...rows].sort((a, b) => b.extras.length - a.extras.length).slice(0, n)) {
    console.log(`     ${r.id}  金标准 ${r.gRows} / 机器 ${r.pRows} / 配上 ${r.matched} / 多出 ${r.extras.length} 行`);
  }
}
