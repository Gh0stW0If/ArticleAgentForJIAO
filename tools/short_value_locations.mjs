/**
 * "值太短、无法用特征词定位"的那批字段（如 `once`、`53.8`、`24 hours`）到底在**长文本**里还是**表格**里？
 *
 * 为什么单独查：`tools/materials_coverage.mjs` 用"特征词"定位答案，对这类短值无能为力——
 * 它们占了"机器填 NR"的 41%。要判断该改哪一头（表格还原 / 正文检索 / 材料选择），
 * 先得知道这类答案原本出现在哪种块里。
 *
 * 口径：
 *   · 复现同一批字段：机器填 NR/空、金标准有值、且值的特征词不足（<2 个长度≥5 的词）；
 *   · 用**字面值**在文档里逐块检索（去尾标点、压空白），分别统计 text / table / title 块；
 *   · 数字型值另外要求"出现在表格里"才算表格命中（正文里的孤立数字太容易撞车），
 *     并在输出里标明该口径。
 *
 * 用法：node tools/short_value_locations.mjs [--field frequency_desc]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ONLY_FIELD = argv.includes('--field') ? argv[argv.indexOf('--field') + 1] : null;

const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const NON_LLM_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check']);
const STOP = new Set(['with', 'from', 'that', 'this', 'were', 'was', 'and', 'the', 'for', 'than', 'then',
  'after', 'before', 'during', 'group', 'groups', 'patients', 'treatment', 'using', 'used', 'each', 'which']);

const stat = {
  total: 0, tableOnly: 0, textOnly: 0, both: 0, normalizedOnly: 0, nowhere: 0, numeric: 0,
  /* 数字型 / 文字型分开计数（初始化为 0，避免输出 undefined） */
  numTable: 0, numText: 0, numBoth: 0, numNorm: 0, numNowhere: 0,
  txtTable: 0, txtText: 0, txtBoth: 0, txtNorm: 0, txtNowhere: 0,
};
const byField = new Map();
const samples = [];

/** 短值的字面形态：去尾标点、压空白、小写。 */
const literalOf = (s) => String(s ?? '').trim().replace(/[.。;；,，]+$/, '').replace(/\s+/g, ' ').toLowerCase();

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
    const blocks = doc.blocks.map((b) => ({
      type: String(b.type ?? 'text'),
      section: String(b.section ?? ''),
      page: b.page,
      text: String(b.text ?? '').toLowerCase(),
    }));

    const check = (scope, field, gv, pv) => {
      if (ONLY_FIELD && field !== ONLY_FIELD) return;
      if (NON_LLM_GOLD.has(field)) return;
      const g = String(gv?.raw ?? '').trim();
      const p = String(pv?.raw ?? '').trim();
      if (!g || /^(NR|NA|NE)$/i.test(g)) return;
      if (p && !/^(NR|NA|NE)$/i.test(p)) return;
      if (/^\d+([/;,]\d+)*$/.test(g)) return;                    // 纯编码
      /* 只取"特征词不足"的那批：与 materials_coverage 同口径 */
      const words = [...new Set((g.toLowerCase().match(/[a-z\u4e00-\u9fff]{5,}/g) ?? []).filter((w) => !STOP.has(w)))];
      const distinctive = words.filter((w) => w.length >= 8).length > 0 || words.length >= 2;
      if (distinctive) return;

      const lit = literalOf(g);
      if (!lit) return;
      const isNumeric = /^[-+]?\d+(\.\d+)?$/.test(lit);
      stat.total++; if (isNumeric) stat.numeric++;

      const inTable = blocks.some((b) => b.type === 'table' && b.text.includes(lit));
      const inText = blocks.some((b) => b.type !== 'table' && b.text.includes(lit));
      let verdict = inTable && inText ? 'both' : inTable ? 'tableOnly' : inText ? 'textOnly' : 'nowhere';
      /*
       * 字面查不到时再试**写法归一**：短值最容易因为"单位缩写/单复数/百分比符号"对不上——
       * `30 min` vs `30 minutes`、`once` vs `one session`、`53.8` vs `53.8%`。
       * 这一步把"真的没有"与"只是写法不同"分开，两者要改的东西完全不同。
       */
      let normalized = false;
      if (verdict === 'nowhere') {
        const norm = (s) => s
          .replace(/\bminutes?\b|\bmins?\b/g, 'min')
          .replace(/\bhours?\b|\bhrs?\b|\bh\b/g, 'hour')
          .replace(/\bweeks?\b|\bwks?\b/g, 'week')
          .replace(/\bmonths?\b|\bmos?\b/g, 'month')
          .replace(/\bdays?\b/g, 'day')
          .replace(/\s+/g, ' ')
          .trim();
        const target = norm(lit);
        normalized = blocks.some((b) => norm(b.text).includes(target));
        if (normalized) verdict = 'normalizedOnly';
      }
      stat[verdict]++;
      {
        const suffix = verdict === 'tableOnly' ? 'Table' : verdict === 'textOnly' ? 'Text'
          : verdict === 'normalizedOnly' ? 'Norm' : verdict === 'nowhere' ? 'Nowhere' : 'Both';
        const key = `${isNumeric ? 'num' : 'txt'}${suffix}`;
        stat[key] = (stat[key] ?? 0) + 1;
      }
      const c = byField.get(field) ?? { total: 0, tableOnly: 0, textOnly: 0, both: 0, normalizedOnly: 0, nowhere: 0 };
      c.total++; c[verdict]++;
      byField.set(field, c);
      if (samples.length < 20) {
        const where = blocks.find((b) => b.text.includes(lit));
        samples.push({
          id: ga.article_id, field, gold: g.slice(0, 30), verdict,
          where: where ? `${where.type}/${where.section || '（无章节）'}/第${where.page}页` : '（文档里找不到该字面值）',
        });
      }
    };

    for (const [k, gv] of Object.entries(ga.article ?? {})) check('article', k, gv, pred.article?.[camel(k)]);
    (ga.comparisons ?? []).forEach((gc, i) => {
      for (const [k, gv] of Object.entries(gc)) check('comparison', k, gv, pred.comparisons?.[i]?.[camel(k)]);
    });
  }
}

const pc = (n) => `${((n / stat.total) * 100).toFixed(0)}%`;
console.log(`"值太短"的字段：${stat.total} 组${ONLY_FIELD ? `（只看 ${ONLY_FIELD}）` : ''}（其中纯数字 ${stat.numeric} 组）\n`);
/* 数字型与文字型分开报：两者的处置完全不同（数字多半在表格里，文字多半是写法差异） */
console.log(`  数字型（如 53.8）：只在表格 ${stat.numTable}｜只在正文 ${stat.numText}｜归一后才对 ${stat.numNorm}｜查不到 ${stat.numNowhere}`);
console.log(`  文字型（如 30 min、once）：只在表格 ${stat.txtTable}｜只在正文 ${stat.txtText}｜归一后才对 ${stat.txtNorm}｜查不到 ${stat.txtNowhere}`);
console.log('');
console.log(`  只在**表格**里：${stat.tableOnly}（${pc(stat.tableOnly)}）`);
console.log(`  只在**正文/标题**里：${stat.textOnly}（${pc(stat.textOnly)}）`);
console.log(`  两边都有：${stat.both}（${pc(stat.both)}）`);
console.log(`  只有**写法归一**后（30 min = 30 minutes 这类）才对得上：${stat.normalizedOnly}（${pc(stat.normalizedOnly)}）`);
console.log(`  归一化后仍然查不到：${stat.nowhere}（${pc(stat.nowhere)}）`);
console.log('\n按字段（总数 / 只在表格 / 只在正文 / 归一后才对 / 查不到）：');
console.log('字段'.padEnd(30), '总数  只在表格  只在正文  两边  归一后才对  查不到');
for (const [k, c] of [...byField.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 14)) {
  console.log(k.padEnd(30), String(c.total).padStart(4), String(c.tableOnly).padStart(8),
    String(c.textOnly).padStart(8), String(c.both).padStart(5),
    String(c.normalizedOnly).padStart(10), String(c.nowhere).padStart(7));
}
console.log('\n样例：');
for (const s of samples) console.log(`  [${s.verdict}] ${s.id} ${s.field}: 金「${s.gold}」→ ${s.where}`);
