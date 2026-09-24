/**
 * "机器填 NR/空的描述性字段，是**没喂材料**还是**喂了没找到**？"
 *
 * 与 `materials_gap.mjs` 的区别：那个工具靠"章节归属"猜，容易被误判；
 * 这个工具**直接把两个 SKILL 的材料按同样参数拼出来**（`collectMaterials`，与线上完全同一实现），
 * 再看金标准答案的特征词在不在材料里。结论只有三种，互斥：
 *
 *   ① 在 comparison 的材料里      → 材料没问题，是检索/提示词问题（该改抽取）
 *   ② 只在 article-meta 的材料里  → comparison 漏喂了（改材料覆盖）
 *   ③ 两份材料里都没有，但全文里有 → 真的漏喂（改材料覆盖）
 *   ④ 全文里也没有               → 抽不出来（金标准是改写，或解析没拿到）
 *
 * 用法：node tools/materials_coverage.mjs [--field frequency_desc]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';
import { collectMaterials } from '../packages/skills/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ONLY_FIELD = argv.includes('--field') ? argv[argv.indexOf('--field') + 1] : null;

const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/**
 * 金标准里不作为抽取目标的列（文献编号、提取人）——**必须排除**，
 * 否则它们会被算成"机器填 NR 的字段"，把统计带偏（实测 444 组，占了一半）。
 */
const NON_LLM_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check']);
const STOP = new Set(['with', 'from', 'that', 'this', 'were', 'was', 'and', 'the', 'for', 'than', 'then',
  'after', 'before', 'during', 'group', 'groups', 'patients', 'treatment', 'using', 'used', 'each', 'which']);

/** 与线上 SKILL 完全一致的材料参数（改这里要同步 comparison.ts / article-meta.ts）。 */
const COMPARISON_MAT = { sections: ['methods', 'results', 'abstract'], tables: true, figures: false };
const ARTICLE_MAT = { sections: ['metadata', 'abstract', 'funding', 'acknowledgements'], tables: false, figures: false, pages: [1, 2] };

const stat = { total: 0, inOwn: 0, inOther: 0, inDocOnly: 0, nowhere: 0, tooShort: 0 };
const byField = new Map();
const samples = [];

for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const ga of gold.articles ?? []) {
    const pf = join(ROOT, 'build', 'extraction', y, `${ga.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    let doc;
    try { doc = ingest({ rootDir: ROOT, year: y, studyId: ga.article_id }).doc; } catch { continue; }
    const cmpText = collectMaterials(doc, { ...COMPARISON_MAT, maxCharsPerBlock: 6000 }).text.toLowerCase();
    const artText = collectMaterials(doc, { ...ARTICLE_MAT, maxTotalChars: 30_000 }).text.toLowerCase();
    const docText = doc.blocks.map((b) => String(b.text ?? '')).join(' ').toLowerCase();

    const check = (scope, field, gv, pv) => {
      if (ONLY_FIELD && field !== ONLY_FIELD) return;
      if (NON_LLM_GOLD.has(field)) return;
      const g = String(gv?.raw ?? '').trim();
      const p = String(pv?.raw ?? '').trim();
      if (!g || /^(NR|NA|NE)$/i.test(g)) return;
      if (p && !/^(NR|NA|NE)$/i.test(p)) return;                 // 只看机器没填出来的
      if (/^\d+([/;,]\d+)*$/.test(g)) return;                    // 跳过编码
      stat.total++;
      /*
       * 特征词要够"独特"才可信：`once`、`3.5`、`NR.` 这类短值几乎在任何文本里都能撞上，
       * 用"任一词命中"会把覆盖率虚高（实测 `frequency_desc` 的 `once` 全部假命中）。
       * 口径：≥2 个长度 ≥5 的词同时命中，或单个长度 ≥8 的词命中。
       */
      const words = [...new Set((g.toLowerCase().match(/[a-z\u4e00-\u9fff]{5,}/g) ?? []).filter((w) => !STOP.has(w)))];
      const match = (text) => {
        const hit = words.filter((w) => text.includes(w));
        if (hit.length >= 2) return true;
        return hit.some((w) => w.length >= 8);
      };
      let verdict;
      /* 按作用域选"对应的那份材料"：比较组级看 comparison 的材料，文章级看 article-meta 的材料 */
      const own = scope === 'comparison' ? cmpText : artText;
      const other = scope === 'comparison' ? artText : cmpText;
      if (!words.length || (words.length < 2 && words.every((w) => w.length < 8))) { verdict = 'tooShort'; }
      else if (match(own)) verdict = 'inOwn';
      else if (match(other)) verdict = 'inOther';
      else if (match(docText)) verdict = 'inDocOnly';
      else verdict = 'nowhere';
      stat[verdict]++;
      const c = byField.get(field) ?? { total: 0, inOwn: 0, inOther: 0, inDocOnly: 0, nowhere: 0, tooShort: 0 };
      c.total++; c[verdict]++;
      byField.set(field, c);
      if (verdict !== 'inOwn' && samples.length < 14) {
        samples.push({ id: ga.article_id, field, gold: g.slice(0, 46), verdict, scope });
      }
    };

    for (const [k, gv] of Object.entries(ga.article ?? {})) check('article', k, gv, pred.article?.[camel(k)]);
    (ga.comparisons ?? []).forEach((gc, i) => {
      for (const [k, gv] of Object.entries(gc)) check('comparison', k, gv, pred.comparisons?.[i]?.[camel(k)]);
    });
  }
}

const pc = (n) => `${((n / stat.total) * 100).toFixed(0)}%`;
console.log(`机器填 NR/空、金标准有值的描述性字段：${stat.total} 组${ONLY_FIELD ? `（只看 ${ONLY_FIELD}）` : ''}\n`);
console.log(`  ① 在**该 SKILL 自己的材料**里（材料没问题，是没找到）：${stat.inOwn}（${pc(stat.inOwn)}）`);
console.log(`  ② 只在**另一份**材料里（比较组级字段跑到 article-meta 的材料去了）：${stat.inOther}（${pc(stat.inOther)}）`);
console.log(`  ③ 两份材料都没有、全文里有（真漏喂）：${stat.inDocOnly}（${pc(stat.inDocOnly)}）`);
console.log(`  ④ 全文里也没有（抽不出来：改写或解析缺口）：${stat.nowhere}（${pc(stat.nowhere)}）`);
console.log(`  （另有 ${stat.tooShort} 组值太短，无法用特征词定位）`);

console.log('\n按字段：');
console.log('字段'.padEnd(30), '总数  自己材料  另一份  全文才有  都没有');
for (const [k, c] of [...byField.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12)) {
  console.log(k.padEnd(30), String(c.total).padStart(4), String(c.inOwn).padStart(8),
    String(c.inOther).padStart(8), String(c.inDocOnly).padStart(9), String(c.nowhere).padStart(7));
}
console.log('\n非"自己材料里有"的样例：');
for (const s of samples) console.log(`  [${s.verdict}] ${s.scope} ${s.id} ${s.field}: 金「${s.gold}」`);
