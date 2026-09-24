/**
 * Europe PMC 作为 **meta 校验第二独立源**的定标。
 *
 * 背景：上面已证实它对 `author_contact` 帮助有限（EPMC 列的是"每位作者"的邮箱、不含通讯作者标记）。
 * 但 meta 校验是另一回事：`title` / `journal` / `pubYear` 是**有唯一正确答案**的字段，
 * 多一个独立来源就能覆盖 Crossref 查不到或判 mismatch 的情形。
 *
 * 要回答：
 *   ① EPMC 取回率（对比 Crossref 的记录）
 *   ② EPMC 的 title / journal / pubYear 与**金标准**的一致率
 *   ③ 当前答错的篇里，EPMC 能不能给出金标准那个值（= 能被它救回的上限）
 *   ④ 与"我们现有答案"的一致性 → 可做冲突预警
 *
 * 用法：node tools/_europepmc_meta.mjs [并发数]
 * 输出：build/europepmc_meta.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONC = Number(process.argv[2] ?? 4);
const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/* ---------- 收集：DOI / 金标准 / 当前取值 / 当前判定 ---------- */
const items = [];
for (const y of ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025']) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const ef = join(ROOT, 'build', 'eval', `${y}.json`);
  const rep = existsSync(ef) ? JSON.parse(readFileSync(ef, 'utf8')) : null;
  for (const ga of gold.articles ?? []) {
    const id = ga.article_id;
    const pf = join(ROOT, 'build', 'extraction', y, `${id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    const verdictOf = (field) => {
      if (!rep) return undefined;
      for (const sheet of Object.values(rep.sheets ?? {})) {
        for (const j of sheet.judged ?? []) {
          if (j.field === field && String(j.key).startsWith(`${id}/`)) return j.verdict;
        }
      }
      return undefined;
    };
    items.push({
      id, year: y,
      doi: pred.article?.doi?.raw && /^10\./.test(pred.article.doi.raw) ? pred.article.doi.raw : null,
      goldTitle: ga.article?.title?.raw,
      goldJournal: ga.article?.journal?.raw,
      goldYear: ga.article?.publication_year?.raw,
      predTitle: pred.article?.title?.raw,
      predJournal: pred.article?.journal?.raw,
      predYear: pred.article?.publicationYear?.raw,
      vTitle: verdictOf('article.title'), vJournal: verdictOf('article.journal'), vYear: verdictOf('article.publication_year'),
      crossref: pred.crossref?.verdict,
    });
  }
}

/* ---------- 查 Europe PMC ---------- */
const res = new Map();
let cursor = 0;
async function worker() {
  while (cursor < items.length) {
    const it = items[cursor++];
    if (!it.doi) continue;
    try {
      const url = `${BASE}?query=${encodeURIComponent(`DOI:"${it.doi}"`)}&format=json&resultType=core&pageSize=1`;
      const r = await fetch(url, { headers: { 'User-Agent': 'article-agent/1.0 (meta verification)' } });
      if (!r.ok) { res.set(it.id, null); continue; }
      const j = await r.json();
      const c = j?.resultList?.result?.[0];
      res.set(it.id, c ? {
        title: c.title,
        journal: c.journalInfo?.journal?.title ?? c.journalInfo?.journal?.medlineAbbreviation,
        pubYear: c.pubYear,
        pmid: c.pmid,
      } : null);
    } catch { res.set(it.id, null); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

/* ---------- 比对 ---------- */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
const same = (a, b) => {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  /* 宽松：一方包含另一方（题名常被截断/带副标题差异） */
  return x.length >= 10 && y.length >= 10 && (x.includes(y) || y.includes(x));
};
const sameYear = (a, b) => {
  const x = String(a ?? '').match(/\d{4}/)?.[0];
  const y = String(b ?? '').match(/\d{4}/)?.[0];
  return !!x && !!y && x === y;
};

const rows = items.map((it) => {
  const e = res.get(it.id) ?? null;
  return {
    ...it, epmc: e, status: !it.doi ? 'nodoi' : (e ? 'ok' : 'notfound'),
    titleMatch: e ? same(e.title, it.goldTitle) : false,
    journalMatch: e ? same(e.journal, it.goldJournal) : false,
    yearMatch: e ? sameYear(e.pubYear, it.goldYear) : false,
    titleAgree: e ? same(e.title, it.predTitle) : false,
    journalAgree: e ? same(e.journal, it.predJournal) : false,
    yearAgree: e ? sameYear(e.pubYear, it.predYear) : false,
  };
});

const ok = rows.filter((r) => r.status === 'ok');
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const w = (rs, key) => rs.reduce((a, r) => a + (VERDICT_WEIGHT[r[key]] ?? 0), 0);

console.log(`\n══ Europe PMC 作为 meta 校验源的定标 ══\n`);
console.log(`  有 DOI：${rows.filter((r) => r.doi).length} / ${rows.length}`);
console.log(`  Europe PMC 取回：**${ok.length}（${pc(ok.length, rows.length)}）**｜未收录：${rows.filter((r) => r.status === 'notfound').length}｜无 DOI：${rows.filter((r) => r.status === 'nodoi').length}`);
const crStats = {};
for (const r of rows) if (r.crossref) crStats[r.crossref] = (crStats[r.crossref] ?? 0) + 1;
console.log(`  （对照）我们已有的 Crossref 校验结论分布：${JSON.stringify(crStats)}`);

console.log('\n  ① EPMC 的值 vs **金标准**（这是"能不能当校验源"的核心）');
console.log(`     title   一致 ${ok.filter((r) => r.titleMatch).length}/${ok.length}（${pc(ok.filter((r) => r.titleMatch).length, ok.length)}）`);
console.log(`     journal 一致 ${ok.filter((r) => r.journalMatch).length}/${ok.length}（${pc(ok.filter((r) => r.journalMatch).length, ok.length)}）`);
console.log(`     pubYear 一致 ${ok.filter((r) => r.yearMatch).length}/${ok.length}（${pc(ok.filter((r) => r.yearMatch).length, ok.length)}）`);

console.log('\n  ② EPMC 的值 vs **我们当前的取值**（可做冲突预警）');
console.log(`     title   一致 ${ok.filter((r) => r.titleAgree).length}/${ok.length}（${pc(ok.filter((r) => r.titleAgree).length, ok.length)}）`);
console.log(`     journal 一致 ${ok.filter((r) => r.journalAgree).length}/${ok.length}（${pc(ok.filter((r) => r.journalAgree).length, ok.length)}）`);
console.log(`     pubYear 一致 ${ok.filter((r) => r.yearAgree).length}/${ok.length}（${pc(ok.filter((r) => r.yearAgree).length, ok.length)}）`);

for (const [label, vKey, matchKey] of [['title', 'vTitle', 'titleMatch'], ['journal', 'vJournal', 'journalMatch'], ['publication_year', 'vYear', 'yearMatch']]) {
  const cur = ok.filter((r) => r[vKey]);
  const wrong = cur.filter((r) => (VERDICT_WEIGHT[r[vKey]] ?? 0) < 1);
  const rescuable = wrong.filter((r) => r[matchKey]);
  console.log(`\n  ③ ${label}：当前答错的 ${wrong.length} 篇里，EPMC 恰好给出金标准值的有 **${rescuable.length}** 篇 → 可救回上限`);
  for (const r of rescuable.slice(0, 6)) console.log(`     ${r.id}  金标准《${String(r[`gold${label === 'title' ? 'Title' : label === 'journal' ? 'Journal' : 'Year'}`]).slice(0, 46)}》`);
}

writeFileSync(join(ROOT, 'build', 'europepmc_meta.json'),
  JSON.stringify({ at: new Date().toISOString(), total: rows.length, ok: ok.length, crStats, rows }, null, 1), 'utf8');
console.log('\n明细 build/europepmc_meta.json\n');
