/**
 * 一次性核查：Europe PMC 的记录里**有没有通讯作者邮箱**？命中率多少？
 *
 * 为什么要先探针再写代码：Crossref 那次就是先假设"它应该有"，结果实测 0/205。
 * 这次先拿真实 DOI 打一遍 API，把"能不能拿到"钉死，再决定值不值得接入。
 *
 * API：`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:"…"&format=json&resultType=core`
 *
 * 用法：node tools/_europepmc_probe.mjs [样本数]
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Number(process.argv[2] ?? 30);
const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/* DOI 从抽取产物里取（与 crossref 探针同一来源，保证可比） */
const dois = [];
for (const y of ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025']) {
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const p = JSON.parse(readFileSync(join(d, f), 'utf8'));
      const doi = p.article?.doi?.raw;
      if (doi && /^10\./.test(doi)) dois.push({ id: f.replace('.json', ''), doi });
    } catch { /* 跳过坏文件 */ }
  }
}
const sample = dois.slice(0, LIMIT);

const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;
const stat = {
  queried: 0, ok: 0, notFound: 0, failed: 0,
  hasEmail: 0, emailInAffiliation: 0, emailInOther: 0,
  withAffiliation: 0, withAuthorList: 0, authorObjects: 0,
  emailMatchesGold: 0, goldHadEmail: 0,
};
const samples = [];

/** 金标准里的邮箱（用于判断 Europe PMC 给的到底是不是通讯作者那个）。 */
const goldEmailsOf = (id) => {
  const y = id.slice(0, 4);
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) return [];
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  const ga = (gold.articles ?? []).find((a) => a.article_id === id);
  const raw = ga?.article?.author_contact?.raw ?? '';
  return (String(raw).match(EMAIL_RE) ?? []).map((e) => e.replace(/\s+/g, '').toLowerCase());
};

for (const { id, doi } of sample) {
  stat.queried++;
  let core = null;
  try {
    const url = `${BASE}?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core&pageSize=1`;
    const r = await fetch(url, { headers: { 'User-Agent': 'article-agent/1.0 (meta verification)' } });
    if (!r.ok) { stat.failed++; continue; }
    const j = await r.json();
    core = j?.resultList?.result?.[0] ?? null;
    if (!core) { stat.notFound++; continue; }
    stat.ok++;
  } catch { stat.failed++; continue; }

  const authors = core.authorList?.author ?? [];
  if (authors.length) stat.withAuthorList++;
  stat.authorObjects += authors.length;
  const affs = authors.map((a) => String(a.affiliation ?? '')).filter(Boolean);
  if (affs.length) stat.withAffiliation++;

  const affEmails = affs.flatMap((a) => a.match(EMAIL_RE) ?? []).map((e) => e.replace(/\s+/g, '').toLowerCase());
  const whole = JSON.stringify(core);
  const allEmails = (whole.match(EMAIL_RE) ?? []).map((e) => e.replace(/\s+/g, '').toLowerCase());
  const uniq = [...new Set(allEmails)];

  if (uniq.length) {
    stat.hasEmail++;
    if (affEmails.length) stat.emailInAffiliation++; else stat.emailInOther++;
  }

  const goldEmails = goldEmailsOf(id);
  const goldHit = goldEmails.length > 0;
  if (goldHit) stat.goldHadEmail++;
  const matched = uniq.filter((e) => goldEmails.includes(e));
  if (matched.length) stat.emailMatchesGold++;

  if (uniq.length && samples.length < 12) {
    samples.push({ id, doi, gold: goldEmails, epmc: uniq.slice(0, 5), inAff: affEmails.length > 0, matched });
  }
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ Europe PMC 有没有通讯作者邮箱？实测 ${stat.ok}/${stat.queried} 篇取回 ══\n`);
console.log(`  取回成功：${stat.ok}｜未收录：${stat.notFound}｜请求失败：${stat.failed}`);
console.log(`  有 authorList：${stat.withAuthorList}（${pc(stat.withAuthorList, stat.ok)}）｜author 对象 ${stat.authorObjects}`);
console.log(`  有 affiliation：${stat.withAffiliation}（${pc(stat.withAffiliation, stat.ok)}）`);
console.log(`  **响应里出现邮箱的篇数：${stat.hasEmail} / ${stat.ok}（${pc(stat.hasEmail, stat.ok)}）**`);
console.log(`    └ 出现在 affiliation 字段里：${stat.emailInAffiliation}`);
console.log(`    └ 出现在别处：${stat.emailInOther}`);
console.log(`\n  金标准里有邮箱的：${stat.goldHadEmail}｜其中 Europe PMC 也给到**同一个**邮箱：${stat.emailMatchesGold}（${pc(stat.emailMatchesGold, stat.goldHadEmail)}）`);

if (samples.length) {
  console.log('\n  样例（Europe PMC 给出的邮箱 vs 金标准）：');
  for (const s of samples) {
    console.log(`   ${s.id}${s.inAff ? '[aff]' : '[其他]'}`);
    console.log(`     EPMC: ${s.epmc.join(', ')}`);
    console.log(`     金标准: ${s.gold.join(', ') || '（无）'}${s.matched.length ? '   ✅ 命中' : ''}`);
  }
}

const out = join(ROOT, 'build', 'europepmc_probe.json');
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stat, samples }, null, 1), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
