/**
 * `article_contact` 的失败到底是不是"检索问题"？
 *
 * 做法：对每篇，把金标准的邮箱（去掉金标准的 `1:` / `2:` 前缀与尾点、去掉 OCR 空格）
 * 拿去在 **article-meta SKILL 实际用的那份材料**里找。三种结论互斥：
 *   ① 材料里有 → 是"喂了没找到"（改提示词/校验能救）
 *   ② 材料里没有、但同一篇里模型答了**另一个**邮箱 → 是"选错作者"（改优先规则能救）
 *   ③ 材料里也没有别的邮箱 → 真漏喂或解析缺口（改材料/解析）
 *
 * 用法：node tools/_author_contact_probe.mjs
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';
import { collectMaterials } from '../packages/skills/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
/** 与 article-meta.ts 里线上参数保持一致 */
const ARTICLE_MAT = { sections: ['metadata', 'abstract', 'funding', 'acknowledgements'], tables: false, figures: false, pages: [1, 2] };

const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 去掉金标准写法噪声：`1:` / `2:` 前缀、尾点、邮箱内部的空格。 */
const normEmail = (s) => String(s)
  .replace(/^\s*\d+\s*[:：]\s*/, '')
  .replace(/[.,;]+$/, '')
  .replace(/\s+/g, '')
  .toLowerCase();
const emailsIn = (s) => (String(s ?? '').match(EMAIL_RE) ?? []).map(normEmail);

const stat = { articles: 0, goldHasEmail: 0, hit: 0, otherEmailOnly: 0, nowhere: 0, goldNonEmail: 0, inFullText: 0, notInDoc: 0 };
const rows = [];

for (const y of YEARS) {
  const evalFile = join(ROOT, 'build', 'eval', `${y}.json`);
  const goldFile = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(evalFile) || !existsSync(goldFile)) continue;
  const rep = JSON.parse(readFileSync(evalFile, 'utf8'));

  /* 从评测报告里取该字段的判定（含 gold/pred），避免再自己走一遍对齐 */
  const judged = [];
  for (const sheet of Object.values(rep.sheets ?? {})) {
    for (const j of sheet.judged ?? []) if (j.field === 'article.author_contact') judged.push(j);
  }

  for (const j of judged) {
    const id = String(j.key).split('/')[0];
    stat.articles++;
    const goldEmails = emailsIn(j.gold);
    if (!goldEmails.length) { stat.goldNonEmail++; continue; }
    stat.goldHasEmail++;

    let mat = '';
    let full = '';
    try {
      const doc = ingest({ rootDir: ROOT, year: y, studyId: id }).doc;
      mat = collectMaterials(doc, ARTICLE_MAT).text.replace(/\s+/g, ' ').toLowerCase();
      /* 全文 = 所有未丢弃的块（不限章节、不限页） */
      full = doc.blocks.filter((b) => !b.dropped).map((b) => String(b.text ?? '')).join(' ').replace(/\s+/g, ' ').toLowerCase();
    } catch { /* 材料取不到就只记 gold/pred */ }
    const flat = (s) => s.replace(/\s+/g, '');
    const inMat = goldEmails.some((e) => flat(mat).includes(e) || mat.includes(e));
    const inFull = goldEmails.some((e) => flat(full).includes(e) || full.includes(e));

    const predEmails = emailsIn(j.pred);
    const predIsOther = predEmails.length > 0 && !predEmails.some((e) => goldEmails.includes(e));

    if (inMat) stat.hit++;
    else if (predIsOther) stat.otherEmailOnly++;
    else stat.nowhere++;
    if (inFull) stat.inFullText++; else stat.notInDoc++;
    rows.push({ year: y, id, verdict: j.verdict, gold: j.gold, pred: j.pred, inMat, inFull, predIsOther, emails: goldEmails });
  }
}
writeFileSync(join(ROOT, 'build', '_ac_rows.json'), JSON.stringify(rows, null, 1), 'utf8');

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ author_contact 失败归因 ══\n`);
console.log(`  参与判定的篇：${stat.articles}`);
console.log(`  金标准含邮箱的：${stat.goldHasEmail}（其余 ${stat.goldNonEmail} 条金标准本身不是邮箱，如"通讯作者姓名"或 NR）`);
console.log(`\n  在 ${stat.goldHasEmail} 条"金标准有邮箱"里：`);
console.log(`   ① 邮箱**就在 article-meta 的材料里**：${stat.hit}（${pc(stat.hit, stat.goldHasEmail)}）→ 喂了没找到`);
console.log(`   ② 材料里找不到该邮箱、但机器答了**别的**邮箱：${stat.otherEmailOnly}（${pc(stat.otherEmailOnly, stat.goldHasEmail)}）→ 选错作者`);
console.log(`   ③ 两者都不是（答 NR / 材料里也没有）：${stat.nowhere}（${pc(stat.nowhere, stat.goldHasEmail)}）→ 漏喂或解析缺口`);

console.log(`\n  ★ 关键分岔：这 ${stat.goldHasEmail} 条金标准邮箱里，`);
console.log(`     在**全文任意块**里能找到的：${stat.inFullText}（${pc(stat.inFullText, stat.goldHasEmail)}）`);
console.log(`     连全文都没有的：${stat.notInDoc}（${pc(stat.notInDoc, stat.goldHasEmail)}）→ 解析缺口（PDF 里是图/扫描件，或 MinDoc 丢弃了该块）`);

const notInMatButInDoc = rows.filter((r) => r.gold && !r.inMat && r.inFull);
console.log(`\n  「材料里没有、全文里有」的：${notInMatButInDoc.length} 条 → **材料筛选问题**（改 collectMaterials 的参数即可）`);
for (const r of notInMatButInDoc.slice(0, 12)) {
  console.log(`   ${r.id}  ${String(r.gold).slice(0, 44)}  （机器答 ${String(r.pred).slice(0, 30)}）`);
}
const notInDocAtAll = rows.filter((r) => r.gold && !r.inMat && !r.inFull);
console.log(`\n  「连全文都没有」的样例（前 8）——多为图片/扫描版首页：`);
for (const r of notInDocAtAll.slice(0, 8)) console.log(`   ${r.id}  ${String(r.gold).slice(0, 44)}`);

const wrongOnly = rows.filter((r) => r.verdict === 'completely_different' || r.verdict === 'has_error');
const w = { a: 0, b: 0, c: 0 };
for (const r of wrongOnly) { if (r.inMat) w.a++; else if (r.predIsOther) w.b++; else w.c++; }
console.log(`\n  只看**判错**的 ${wrongOnly.length} 条：① ${w.a}｜② ${w.b}｜③ ${w.c}`);

console.log('\n  ① 类样例（材料里有，改提示词就能救，前 10）：');
for (const r of wrongOnly.filter((x) => x.inMat).slice(0, 10)) {
  console.log(`   ${r.id}  金标准 ${String(r.gold).slice(0, 40)}  vs  机器 ${String(r.pred).slice(0, 40)}`);
}
