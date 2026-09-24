/**
 * 一次性核查：Crossref 的记录里**到底有没有通讯作者邮箱**？
 *
 * 背景：`author_contact` 目前是纯 LLM 从 PDF 抽的（`article-meta` SKILL），
 * Crossref 的覆盖清单只有 title / journal / firstAuthor / publicationYear。
 * 要判断"能不能靠 Crossref 补这个字段"，必须先确认 Crossref 有没有这个信息——
 * 而不是假设它有。
 *
 * 做法：抽 N 篇有 DOI 的文章，直接向 Crossref 取原始 JSON（不经过我们的 client 裁剪），
 * 在整个响应体里搜 `@`，并统计 `author[].affiliation` 的形态。
 *
 * 用法：node tools/_crossref_contact_probe.mjs [样本数]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Number(process.argv[2] ?? 40);
const MAILTO = 'article-agent@example.org';

const dois = JSON.parse(readFileSync(resolve(ROOT, 'build', '_dois.json'), 'utf8')).slice(0, LIMIT);

const stat = {
  queried: 0, ok: 0, failed: 0,
  hasAnyAt: 0, atInAuthorName: 0, atInAffiliation: 0, atElsewhere: 0,
  withAffiliation: 0, withOrcid: 0, authorObjects: 0,
};
const samples = [];

for (const { id, doi } of dois) {
  stat.queried++;
  let m = null;
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`, {
      headers: { 'User-Agent': `article-agent/1.0 (mailto:${MAILTO})` },
    });
    if (!r.ok) { stat.failed++; continue; }
    m = (await r.json()).message;
    stat.ok++;
  } catch { stat.failed++; continue; }

  const authors = m.author ?? [];
  stat.authorObjects += authors.length;
  if (authors.some((a) => (a.affiliation ?? []).length)) stat.withAffiliation++;
  if (authors.some((a) => a.ORCID)) stat.withOrcid++;

  /* 邮箱可能藏在哪里：author 对象自身、affiliation.name、或响应其他角落 */
  const inName = authors.some((a) => [a.given, a.family, a.name].filter(Boolean).join(' ').includes('@'));
  const inAff = authors.some((a) => (a.affiliation ?? []).some((f) => String(f.name ?? '').includes('@')));
  const whole = JSON.stringify(m);
  const anyAt = whole.includes('@');
  if (anyAt) stat.hasAnyAt++;
  if (inName) stat.atInAuthorName++;
  if (inAff) stat.atInAffiliation++;
  if (anyAt && !inName && !inAff) stat.atElsewhere++;

  if (inAff && samples.length < 8) {
    samples.push({ id, doi, where: 'affiliation', text: authors.flatMap((a) => (a.affiliation ?? []).map((f) => f.name)).find((n) => String(n).includes('@')) });
  } else if (inName && samples.length < 8) {
    samples.push({ id, doi, where: 'author', text: authors.map((a) => [a.given, a.family, a.name].filter(Boolean).join(' ')).find((n) => n.includes('@')) });
  }
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ Crossref 有没有通讯作者邮箱？实测 ${stat.ok}/${stat.queried} 篇取回成功 ══\n`);
console.log(`  响应体里出现过 "@" 的篇数：${stat.hasAnyAt} / ${stat.ok}（${pc(stat.hasAnyAt, stat.ok)}）`);
console.log(`  └ 出现在 author 的 given/family/name 里：${stat.atInAuthorName}`);
console.log(`  └ 出现在 author[].affiliation[].name 里：${stat.atInAffiliation}`);
console.log(`  └ 出现在别处（如 funder/assertion）：${stat.atElsewhere}`);
console.log(`  有 affiliation 字段的篇数：${stat.withAffiliation} / ${stat.ok}（${pc(stat.withAffiliation, stat.ok)}）`);
console.log(`  有 ORCID 的篇数：${stat.withOrcid} / ${stat.ok}`);
console.log(`  author 对象总数：${stat.authorObjects}`);

if (samples.length) {
  console.log('\n  含 @ 的样例：');
  for (const s of samples) console.log(`   ${s.id}（${s.doi}）[${s.where}] ${String(s.text).slice(0, 160)}`);
} else {
  console.log('\n  ⚠ 样本里没有任何一篇的 Crossref 记录含 "@"。');
}

writeFileSync(resolve(ROOT, 'build', 'crossref_contact_probe.json'),
  JSON.stringify({ at: new Date().toISOString(), stat, samples }, null, 1), 'utf8');
console.log(`\n明细 build/crossref_contact_probe.json\n`);
