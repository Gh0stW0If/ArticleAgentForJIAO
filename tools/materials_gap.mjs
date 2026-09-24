/**
 * "机器填 NR/空的描述性字段，答案到底藏在哪儿？"——材料覆盖率诊断。
 *
 * 背景：Sheet1 描述性字段的失配里约 1/3 是"机器填了 NR 或空"（1,164 组）。
 * 这些不是"读错"，而是"没找到"。要判断该改哪一头，必须先知道答案原本在文档的哪个位置：
 *   · 落在**已经喂给模型**的章节/表格里 → 是检索/提示词问题；
 *   · 落在**没喂**的地方（图、参考文献外的其他章节、被截断的尾巴） → 是材料覆盖问题。
 *
 * 判据：取金标准值里的**特征词**（长度≥4、非停用词），回文档里找含该词的块；
 * 记录该块所属章节与类型，再对照 comparison / article-meta 两个 SKILL 的材料过滤条件。
 *
 * 用法：node tools/materials_gap.mjs [--field frequency_desc] [--top 12]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ONLY_FIELD = argv.includes('--field') ? argv[argv.indexOf('--field') + 1] : null;
const TOP = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 12;

const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const STOP = new Set(['with', 'from', 'that', 'this', 'were', 'was', 'and', 'the', 'for', 'than', 'then',
  'after', 'before', 'during', 'group', 'groups', 'patients', 'treatment', 'were', 'using', 'used', 'each']);

/** 两个 SKILL 的材料过滤条件（改这里要同步 packages/skills/src/{comparison,article-meta}.ts）。 */
const INCLUDED = {
  comparison: { sections: new Set(['methods', 'results', 'abstract']), tables: true, figures: false, pages: null },
  article: { sections: new Set(['metadata', 'abstract', 'funding', 'acknowledgements']), tables: false, figures: false, pages: new Set([1, 2]) },
};

const tally = { total: 0, found: 0, notFound: 0, tooShort: 0, bySection: new Map(), byType: new Map(), byCoverage: new Map(), samples: [] };

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

    const check = (scope, field, gv, pv) => {
      if (ONLY_FIELD && field !== ONLY_FIELD) return;
      const g = String(gv?.raw ?? '').trim();
      const p = String(pv?.raw ?? '').trim();
      if (!g || /^(NR|NA|NE)$/i.test(g)) return;
      if (p && !/^(NR|NA|NE)$/i.test(p)) return;          // 只看机器没填出来的
      if (/^\d+([/;,]\d+)*$/.test(g)) return;             // 跳过编码
      tally.total++;
      /*
       * 特征词必须**够长够多**才可信：长度 ≥5、非停用词、非纯数字。
       * 只用"任一词命中"会把 `once`、`Table1` 这类短值匹配到无关段落（实测踩过：
       * 假命中把"出处分布"整个带偏），因此这里要求**命中比例 ≥ 0.6 且至少 2 个词**；
       * 单词值（如 `once`）单独记为"值太短、无法定位"，不猜。
       */
      const words = [...new Set((g.toLowerCase().match(/[a-z\u4e00-\u9fff]{5,}/g) ?? []).filter((w) => !STOP.has(w)))];
      if (words.length < 2) { tally.tooShort++; return; }
      let best = null;
      for (const b of doc.blocks) {
        const t = String(b.text ?? '').toLowerCase();
        if (!t) continue;
        const hitN = words.filter((w) => t.includes(w)).length;
        const ratio = hitN / words.length;
        if (ratio >= 0.6 && (!best || ratio > best.ratio || (ratio === best.ratio && hitN > best.hitN))) {
          best = { block: b, ratio, hitN };
        }
      }
      if (!best) {
        tally.notFound++;
        if (tally.samples.length < 12) tally.samples.push({ id: ga.article_id, field, gold: g.slice(0, 50), where: '（文档里找不到）' });
        return;
      }
      const hit = best.block;
      tally.found++;
      const sec = String(hit.section ?? '（无章节）');
      const type = String(hit.type ?? 'text');
      tally.bySection.set(sec, (tally.bySection.get(sec) ?? 0) + 1);
      tally.byType.set(type, (tally.byType.get(type) ?? 0) + 1);
      const inc = INCLUDED[scope];
      const covered = inc.sections.has(sec)
        && !(type === 'table' && !inc.tables)
        && !(type === 'figure' && !inc.figures)
        && !(inc.pages && !inc.pages.has(hit.page));
      const key = covered ? `已喂给模型（${scope}）` : `没喂（${scope}：章节=${sec} 类型=${type}）`;
      tally.byCoverage.set(key, (tally.byCoverage.get(key) ?? 0) + 1);
      if (tally.samples.length < 12) tally.samples.push({ id: ga.article_id, field, gold: g.slice(0, 46), where: `${sec}/${type}/第${hit.page}页` });
    };

    for (const [k, gv] of Object.entries(ga.article ?? {})) check('article', k, gv, pred.article?.[camel(k)]);
    (ga.comparisons ?? []).forEach((gc, i) => {
      for (const [k, gv] of Object.entries(gc)) check('comparison', k, gv, pred.comparisons?.[i]?.[camel(k)]);
    });
  }
}

console.log(`机器填 NR/空、金标准有值的描述性字段：${tally.total} 组${ONLY_FIELD ? `（只看 ${ONLY_FIELD}）` : ''}`);
console.log(`  在文档里找到出处：${tally.found}（${((tally.found / tally.total) * 100).toFixed(0)}%）`
  + `｜完全找不到：${tally.notFound}｜值太短无法定位：${tally.tooShort}`);
console.log('\n出处所在章节（前 10）：');
for (const [k, v] of [...tally.bySection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log('\n出处所在块类型：');
for (const [k, v] of [...tally.byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
console.log('\n对照两个 SKILL 的材料过滤：');
for (const [k, v] of [...tally.byCoverage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k}  ${v}`);
console.log('\n样例：');
for (const s of tally.samples) console.log(`  ${s.id} ${s.field}: 金「${s.gold}」→ ${s.where}`);
