/**
 * 机制验证：邮箱所在的那个块，在 MiniDoc 里是**第几页 / 什么章节**？
 *
 * 为什么要看章节：`collectMaterials` 的判据是"**章节命中 或 页码命中**"
 * （`packages/skills/src/materials.ts`：`if (!sectionOk && !pageOk && !tableKept) 丢掉`）。
 * 所以 `pages:[1,2]` 并不是硬边界——第 5 页上标成 `funding`/`acknowledgements`/`metadata` 的块
 * 照样会进材料。这解释了为什么少数"邮箱在第 5、8 页"的篇仍然答对了。
 *
 * 用法：node tools/_author_contact_block.mjs [id...]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 与 article-meta SKILL 线上参数一致 */
const ARTICLE_MAT = { sections: ['metadata', 'abstract', 'funding', 'acknowledgements'], tables: false, figures: false, pages: [1, 2] };

const pageRows = JSON.parse(readFileSync(join(ROOT, 'build', 'author_contact_page.json'), 'utf8')).rows;
const asked = process.argv.slice(2);
const targets = asked.length
  ? pageRows.filter((r) => asked.includes(r.id))
  : pageRows.filter((r) => r.page !== null && r.page > 2);   // 默认：材料盲区那批

const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

console.log(`\n══ 邮箱所在块：页 / 章节 / 是否进材料 ══（${targets.length} 篇）\n`);
console.log('  文章      邮箱页  块页  章节                 是否在材料  判定');
for (const t of targets) {
  let doc;
  try { doc = ingest({ rootDir: ROOT, year: t.year, studyId: t.id }).doc; } catch (e) {
    console.log(`  ${t.id}  ⚠ ingest 失败：${String(e.message).slice(0, 40)}`);
    continue;
  }
  const needle = flat(t.emails[0]);
  const hits = [];
  for (const b of doc.blocks) {
    if (b.dropped) continue;
    if (flat(b.text).includes(needle)) hits.push(b);
    for (const ev of []) void ev;
  }
  if (!hits.length) {
    console.log(`  ${t.id.padEnd(9)} ${String(t.page).padStart(4)}    —    （MinDoc 里找不到该邮箱）`);
    continue;
  }
  /* 材料命中判据：章节命中 或 页码命中 */
  const inMat = hits.some((b) => ARTICLE_MAT.sections.includes(b.section) || ARTICLE_MAT.pages.includes(b.page));
  const b = hits[0];
  console.log(`  ${t.id.padEnd(9)} ${String(t.page).padStart(4)}  ${String(b.page).padStart(4)}  `
    + `${String(b.section).padEnd(20)} ${(inMat ? '✅ 在' : '❌ 不在').padEnd(11)} ${b.type}`);
}

/* 汇总：材料命中 vs 未命中 × 判定 */
const W = { identical: 1, same_meaning: 1, contains_correct: 0.5, has_error: 0, completely_different: 0 };
let inN = 0; let inW = 0; let outN = 0; let outW = 0; let noneN = 0; let noneW = 0;
for (const t of pageRows) {
  let doc;
  try { doc = ingest({ rootDir: ROOT, year: t.year, studyId: t.id }).doc; } catch { continue; }
  const needle = flat(t.emails[0]);
  const hits = doc.blocks.filter((b) => !b.dropped && flat(b.text).includes(needle));
  const w = W[t.verdict] ?? 0;
  if (!hits.length) { noneN++; noneW += w; continue; }
  const inMat = hits.some((b) => ARTICLE_MAT.sections.includes(b.section) || ARTICLE_MAT.pages.includes(b.page));
  if (inMat) { inN++; inW += w; } else { outN++; outW += w; }
}
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log('\n  ── 汇总（150 条）──');
console.log(`   邮箱所在块**进得了材料**：${inN} 条 → 加权 ${pct(inW, inN)}`);
console.log(`   邮箱所在块**进不了材料**：${outN} 条 → 加权 ${pct(outW, outN)}`);
console.log(`   MinDoc 里根本没有该邮箱：${noneN} 条 → 加权 ${pct(noneW, noneN)}`);
