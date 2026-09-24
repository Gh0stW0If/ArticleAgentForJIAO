/**
 * 核实 2025-02 是否「两篇论文共用一个编号」（影响 gold 的文章数 32 vs 文件名的 33 篇）。
 * 用法：node tools/_y2025_02_probe.mjs
 */
import { readWorkbook, norm } from './lib/xlsx.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wb = readWorkbook(join(ROOT, 'Datas', 'label', '2025-33篇.xlsx'));
const s1 = wb.sheets['0']; const s2 = wb.sheets['1'];
console.log('Sheet1 表头行 2 的列 A–F：', (s1.rows[1].cells ?? []).slice(0, 6).map((c) => norm(c)).join(' | '));
for (const r of (s1.rows ?? []).filter((x) => x.r > 2 && norm((x.cells ?? [])[0]) === '2025-02')) {
  const c = (r.cells ?? []).map(norm);
  console.log(`\nSheet1 第${r.r}行：`);
  console.log(`  编号=${c[0]}  题目=${c[5]}  发表年份=${c[6]}  期刊=${c[8]}`);
  console.log(`  干预=${c[22]}  对照=${c[23]}`);
}
for (const r of (s2.rows ?? []).filter((x) => x.r > 1 && norm((x.cells ?? [])[0]) === '2025-02')) {
  const c = (r.cells ?? []).map(norm);
  console.log(`\nSheet2 第${r.r}行：编号=${c[0]}  题目=${c[1]}  主要结局=${c[2]?.slice(0, 50)}`);
}

const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', '2025.json'), 'utf8'));
const art = gold.articles.filter((a) => a.article_id === '2025-02');
console.log(`\ngold 2025.json：articles=${gold.counts.articles} comparisons=${gold.counts.comparisons} outcomes=${gold.counts.outcomes}`);
console.log(`article_id 为 2025-02 的记录数 = ${art.length}`);
for (const a of art) {
  console.log(`  article.title = ${JSON.stringify(a.article?.title?.raw)}`);
  console.log(`  comparisons = ${a.comparisons.length}：${a.comparisons.map((c) => `${c.intervention?.raw ?? '?'} vs ${c.control?.raw ?? '?'}`).join(' || ')}`);
  console.log(`  outcomes = ${a.outcomes.length}`);
}
const ids = [...new Set(gold.articles.map((a) => a.article_id))];
console.log(`gold 里不同 article_id 数 = ${ids.length}；文件名说 33 篇`);
console.log(`抽取产物是否存在 2025-02：${existsSync(join(ROOT, 'build', 'extraction', '2025', '2025-02.json'))}`);
const other = ['2025-09','2025-22'].map((i) => {
  const a2 = gold.articles.find((x) => x.article_id === i);
  return `${i}: gold ${a2?.comparisons?.length ?? 0} 组`;
});
console.log(other.join('   '));
