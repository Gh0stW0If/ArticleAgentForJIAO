/**
 * 关键对照：在"当前 title 没拿满分"的那些篇上，**Crossref 与 Europe PMC 谁的题名更全**？
 *
 * 为什么必须先做这一步：`article-meta` 里 Crossref **本来就覆盖 title**
 * （`override('title', work.title, 'title')`）。如果 Crossref 已经给出了含副标题的完整题名，
 * 那问题不在数据源、而在"覆盖没生效"，接 Europe PMC 就是白做。
 *
 * 用法：node tools/_epmc_vs_crossref_title.mjs
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(ROOT, 'build', 'europepmc_meta.json'), 'utf8'));

const targets = meta.rows.filter((r) => r.epmc && r.vTitle && (VERDICT_WEIGHT[r.vTitle] ?? 0) < 1 && r.titleMatch);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

let crHasSubtitle = 0; let crSameAsGold = 0; let crMissing = 0; let crShorter = 0;
const rows = [];
for (const r of targets) {
  let cr = null;
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(r.doi)}?mailto=article-agent@example.org`,
      { headers: { 'User-Agent': 'article-agent/1.0' } });
    if (res.ok) cr = (await res.json()).message?.title?.[0] ?? null;
  } catch { /* 忽略 */ }
  if (!cr) crMissing++;
  const gold = norm(r.goldTitle);
  const crN = norm(cr);
  const epmcN = norm(r.epmc.title);
  const goldLen = gold.length;
  if (cr) {
    if (crN === gold || (crN.length >= goldLen && crN.includes(gold.slice(0, 40)))) crSameAsGold++;
    if (crN.length >= epmcN.length - 2) crHasSubtitle++; else crShorter++;
  }
  rows.push({ id: r.id, doi: r.doi, verdict: r.vTitle, gold: r.goldTitle, cr, epmc: r.epmc.title });
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ "title 没拿满分且 EPMC 题名=金标准"的 ${targets.length} 篇：Crossref 给了什么？══\n`);
console.log(`  Crossref 取回失败/无题名：${crMissing}`);
console.log(`  Crossref 题名**同样完整**（与 EPMC 等长）：${crHasSubtitle}（${pc(crHasSubtitle, targets.length)}）`);
console.log(`  Crossref 题名比 EPMC 短：${crShorter}（${pc(crShorter, targets.length)}）`);
console.log(`  Crossref 题名与金标准一致：${crSameAsGold}（${pc(crSameAsGold, targets.length)}）`);

console.log('\n  逐条：');
for (const r of rows.slice(0, 14)) {
  console.log(`   ${r.id}  [${r.verdict}]`);
  console.log(`     金标准: ${String(r.gold).slice(0, 96)}`);
  console.log(`     Crossref: ${String(r.cr ?? '（无）').slice(0, 96)}`);
  console.log(`     EPMC    : ${String(r.epmc).slice(0, 96)}`);
}
