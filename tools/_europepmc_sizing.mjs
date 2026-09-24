/**
 * Europe PMC 作为 `author_contact` **补充信源**的定标：它到底能帮上多少？
 *
 * 上一版探针只回答了"有没有邮箱"（44.8%）。要决定怎么用，必须再回答三件事：
 *   ① Europe PMC 给出**唯一一个**邮箱的篇有多少？（唯一 → 可直接采用）
 *   ② 金标准邮箱**出现在** Europe PMC 列表里的篇有多少？（→ 可做独立确认/提置信度）
 *   ③ 当前答错、且金标准邮箱在 Europe PMC 列表里的篇有多少？（→ 能被补信源救回的上限）
 *
 * ⚠️ Europe PMC 把**每位作者**的邮箱都附在各自单位后面，且**不标注谁是通讯作者**
 * （PubMed 的 `Electronic address:` 标记在这个数据集里没有保留）。
 * 所以"多个邮箱"时不能猜——那正是要交回模型/人工的判断。
 *
 * 用法：node tools/_europepmc_sizing.mjs [并发数]
 * 输出：build/europepmc_sizing.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONC = Number(process.argv[2] ?? 4);
const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;
const norm = (e) => e.replace(/\s+/g, '').toLowerCase();

/* ---------- 1) 收集 DOI（抽取产物）与金标准判定（评测报告） ---------- */
const items = [];
for (const y of ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025']) {
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const id = f.replace(/\.json$/, '');
    let doi; let predContact;
    try {
      const p = JSON.parse(readFileSync(join(d, f), 'utf8'));
      doi = p.article?.doi?.raw;
      predContact = p.article?.authorContact?.raw;
    } catch { continue; }
    /* 金标准 + 当前判定 */
    let gold; let verdict;
    const gf = join(ROOT, 'build', 'gold', `${y}.json`);
    if (existsSync(gf)) {
      const gold0 = JSON.parse(readFileSync(gf, 'utf8'));
      const ga = (gold0.articles ?? []).find((a) => a.article_id === id);
      gold = ga?.article?.author_contact?.raw;
    }
    const ef = join(ROOT, 'build', 'eval', `${y}.json`);
    if (existsSync(ef)) {
      const rep = JSON.parse(readFileSync(ef, 'utf8'));
      for (const sheet of Object.values(rep.sheets ?? {})) {
        for (const j of sheet.judged ?? []) {
          if (j.field === 'article.author_contact' && String(j.key).startsWith(`${id}/`)) verdict = j.verdict;
        }
      }
    }
    items.push({ id, year: y, doi: doi && /^10\./.test(doi) ? doi : null, gold, verdict, predContact });
  }
}

/* ---------- 2) 并发查 Europe PMC ---------- */
const results = new Map();
let cursor = 0;
async function worker() {
  while (cursor < items.length) {
    const it = items[cursor++];
    if (!it.doi) continue;
    try {
      const url = `${BASE}?query=${encodeURIComponent(`DOI:"${it.doi}"`)}&format=json&resultType=core&pageSize=1`;
      const r = await fetch(url, { headers: { 'User-Agent': 'article-agent/1.0 (meta verification)' } });
      if (!r.ok) { results.set(it.id, { status: `http ${r.status}`, emails: [] }); continue; }
      const j = await r.json();
      const core = j?.resultList?.result?.[0];
      if (!core) { results.set(it.id, { status: 'notfound', emails: [] }); continue; }
      const emails = [];
      for (const a of core.authorList?.author ?? []) {
        for (const aff of a.authorAffiliationDetailsList?.authorAffiliation ?? []) {
          for (const m of String(aff.affiliation ?? '').match(EMAIL_RE) ?? []) emails.push(norm(m));
        }
      }
      /* 兼容：有些记录把 affiliation 挂在 author 上（老结构） */
      for (const a of core.authorList?.author ?? []) {
        for (const m of String(a.affiliation ?? '').match(EMAIL_RE) ?? []) emails.push(norm(m));
      }
      results.set(it.id, { status: 'ok', emails: [...new Set(emails)], pmid: core.pmid, pubYear: core.pubYear });
    } catch (e) {
      results.set(it.id, { status: `err ${String(e.message).slice(0, 40)}`, emails: [] });
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

/* ---------- 3) 交叉制表 ---------- */
const rows = items.map((it) => {
  const r = results.get(it.id) ?? { status: 'nodoi', emails: [] };
  const goldEmails = (String(it.gold ?? '').match(EMAIL_RE) ?? []).map(norm);
  const epmc = r.emails ?? [];
  return {
    ...it, status: r.status, epmc, goldEmails,
    epmcCount: epmc.length,
    goldInEpmc: goldEmails.length > 0 && goldEmails.some((g) => epmc.includes(g)),
    weight: VERDICT_WEIGHT[it.verdict] ?? 0,
  };
});

const ok = rows.filter((r) => r.status === 'ok');
const n = ok.length;
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const withEmail = ok.filter((r) => r.epmcCount > 0);
const exactly1 = ok.filter((r) => r.epmcCount === 1);
const goldHas = ok.filter((r) => r.goldEmails.length > 0);
const goldIn = goldHas.filter((r) => r.goldInEpmc);

console.log(`\n══ Europe PMC 定标（${n} 篇取回 / ${items.length} 篇有 DOI）══\n`);
console.log(`  ① 有邮箱：${withEmail.length}（${pc(withEmail.length, n)}）`);
console.log(`     其中**恰好一个**邮箱：${exactly1.length}（${pc(exactly1.length, n)}）`);
const oneAndRight = exactly1.filter((r) => r.goldInEpmc).length;
console.log(`     └ 这一个就是金标准邮箱的：${oneAndRight}（${pc(oneAndRight, exactly1.length)}）`);
console.log(`  ② 金标准有邮箱的：${goldHas.length}｜其中**出现在** Europe PMC 列表里：${goldIn.length}（${pc(goldIn.length, goldHas.length)}）`);
const wrongNow = rows.filter((r) => r.status === 'ok' && r.verdict && (VERDICT_WEIGHT[r.verdict] ?? 0) < 1);
console.log(`  ③ 当前没拿满分的：${wrongNow.length}｜其中金标准邮箱在 EPMC 里：${wrongNow.filter((r) => r.goldInEpmc).length}`
  + `｜EPMC 恰好一个：${wrongNow.filter((r) => r.epmcCount === 1).length}`);

console.log('\n  ── 按"EPMC 邮箱个数"分档看当前正确率 ──');
const buckets = [['0 个', (r) => r.epmcCount === 0], ['恰好 1 个', (r) => r.epmcCount === 1], ['2~5 个', (r) => r.epmcCount >= 2 && r.epmcCount <= 5], ['6 个以上', (r) => r.epmcCount > 5]];
for (const [label, f] of buckets) {
  const rs = ok.filter(f);
  if (!rs.length) continue;
  const w = rs.reduce((a, r) => a + r.weight, 0);
  console.log(`   ${label.padEnd(9)} ${String(rs.length).padStart(3)} 篇 → 当前加权正确率 ${pc(w, rs.length)}`
    + `｜其中金标准邮箱在列表里 ${rs.filter((r) => r.goldInEpmc).length}`);
}

console.log('\n  ── 可被"独立确认"的样例（金标准邮箱在 EPMC 列表里，前 10）──');
for (const r of goldIn.slice(0, 10)) {
  console.log(`   ${r.id}  EPMC ${r.epmcCount} 个：${r.epmc.slice(0, 3).join(', ')}${r.epmc.length > 3 ? ' …' : ''}`);
  console.log(`        金标准：${r.goldEmails.join(', ')}｜当前 ${r.verdict ?? '（未判定）'}`);
}

writeFileSync(join(ROOT, 'build', 'europepmc_sizing.json'),
  JSON.stringify({ at: new Date().toISOString(), total: items.length, ok: n, rows }, null, 1), 'utf8');
console.log('\n明细 build/europepmc_sizing.json\n');
