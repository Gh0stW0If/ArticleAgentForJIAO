/**
 * 「机器列表里找不到」的 193 行，到底是真没抽还是叫法不同？
 * 逐篇打印：金标准那一行 + 该篇机器抽到的全部结局名。
 *
 * 用法：node tools/_miss_inspect.mjs [篇数上限]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normText, tokensOf, dice } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Number(process.argv[2] ?? 12);
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const nm = (o) => String(o?.outcome?.name?.raw ?? '');
const ins = (o) => String(o?.outcome?.instrument?.raw ?? '');
const pair = (o) => `${nm(o)}｜${ins(o)}`;

const RANK = { exact: 4, subset: 3, strong: 2, weak: 1, none: 0 };
const strength = (a, b) => {
  const A = normText(a); const B = normText(b);
  if (!A || !B) return 'none';
  if (A === B) return 'exact';
  const ta = tokensOf(a); const tb = tokensOf(b);
  if (!ta.size || !tb.size) return 'none';
  const inter = [...ta].filter((t) => tb.has(t)).length;
  if (inter === Math.min(ta.size, tb.size)) return 'subset';
  const d = dice(a, b);
  return d >= 0.5 ? 'strong' : d >= 0.34 ? 'weak' : 'none';
};
const bestOf = (g, p) => {
  const lv = [strength(nm(g), nm(p)), strength(nm(g), ins(p)), strength(ins(g), nm(p)), strength(ins(g), ins(p))];
  return lv.sort((x, y) => RANK[y] - RANK[x])[0];
};

const excluded = new Map();
{
  const f = join(ROOT, 'build', 'gold_row_anomalies.json');
  if (existsSync(f)) for (const x of JSON.parse(readFileSync(f, 'utf8')).findings ?? []) {
    if (!excluded.has(x.articleId)) excluded.set(x.articleId, new Set());
    excluded.get(x.articleId).add(x.rowIndex);
  }
}

let shown = 0;
for (const y of YEARS) {
  if (shown >= LIMIT) break;
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xd = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(xd)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const byId = new Map((gold.articles ?? []).map((a) => [a.article_id, a]));
  for (const fn of readdirSync(xd)) {
    if (shown >= LIMIT || !fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const g = byId.get(id);
    if (!g) continue;
    const pred = JSON.parse(readFileSync(join(xd, fn), 'utf8'));
    const skip = excluded.get(id);
    const gAll = g.outcomes ?? [];
    const gO = skip?.size ? gAll.filter((_, i) => !skip.has(i)) : gAll;
    const pO = pred.outcomes ?? [];
    const miss = gO.filter((gr) => !pO.some((p) => RANK[bestOf(gr, p)] >= 1));
    if (!miss.length) continue;
    shown++;
    console.log(`\n════ ${id}   金标准 ${gO.length} 行 / 机器 ${pO.length} 行   找不到 ${miss.length} 行`);
    for (const gr of miss) console.log(`   ✗ 金标准：${pair(gr)}`);
    console.log(`   机器抽到的结局名（去重）：`);
    const names = [...new Set(pO.map((p) => `${nm(p)}${ins(p) && ins(p) !== 'NR' ? ` [${ins(p).slice(0, 28)}]` : ''}`))];
    for (const n of names) console.log(`        · ${n}`);
  }
}
console.log(`\n共展示 ${shown} 篇`);
