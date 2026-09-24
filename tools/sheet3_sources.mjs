/**
 * 探针：金标准 Sheet3 的数值到底出现在哪里——表格块？正文块？
 *
 * 做法：把 2015 年每篇的 MiniDoc 分块（table vs 非 table），
 * 对金标准结局层每个数值叶子（estimate / ci_lower / ci_upper / n …）做**逐字数值检索**，
 * 统计它出现在哪一类块里。
 */

import { readFileSync } from 'node:fs';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = process.cwd();
const gold = JSON.parse(readFileSync('build/gold/2015.json', 'utf8'));
const ids = gold.articles.map((a) => a.article_id);

const stat = { both: 0, tableOnly: 0, textOnly: 0, none: 0 };
const byLeaf = new Map();
const notFound = [];

/** 收集该块里出现的所有"数值 token"（含小数与负号），用于精确比对。 */
const numberTokens = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    out.add(m[0]);
    out.add(m[0].replace(/^-/, ''));
  }
  return out;
};

for (const id of ids) {
  const doc = ingest({ rootDir: ROOT, year: '2015', studyId: id }).doc;
  const tableTok = new Set();
  const textTok = new Set();
  for (const b of doc.blocks) {
    const toks = numberTokens(b.text);
    const target = b.type === 'table' ? tableTok : textTok;
    for (const t of toks) target.add(t);
  }

  const goldArt = gold.articles.find((a) => a.article_id === id);
  for (const o of goldArt.outcomes ?? []) {
    for (const [tp, block] of Object.entries(o.timepoints ?? {})) {
      for (const [kind, fields] of Object.entries(block ?? {})) {
        for (const [grp, leaves] of Object.entries(fields ?? {})) {
          if (leaves === null || typeof leaves !== 'object') continue;
          const items = 'raw' in leaves ? { _: leaves } : leaves;   // difference_* 是叶子，experimental/control 是容器
          for (const [leaf, v] of Object.entries(items)) {
            if (!v || typeof v !== 'object' || !('raw' in v)) continue;
            const raw = String(v.raw).trim();
            if (!/^-?\d+(\.\d+)?$/.test(raw)) continue;             // 只看纯数值
            const key = `${kind}.${grp}${leaf === '_' ? '' : '.' + leaf}`;
            const inTable = tableTok.has(raw) || tableTok.has(raw.replace(/^-/, ''));
            const inText = textTok.has(raw) || textTok.has(raw.replace(/^-/, ''));
            const bucket = inTable && inText ? 'both' : inTable ? 'tableOnly' : inText ? 'textOnly' : 'none';
            stat[bucket]++;
            if (!byLeaf.has(key)) byLeaf.set(key, { both: 0, tableOnly: 0, textOnly: 0, none: 0, n: 0 });
            const e = byLeaf.get(key);
            e[bucket]++; e.n++;
            if (bucket === 'none') notFound.push(`${id} ${tp} ${key}=${raw}`);
          }
        }
      }
    }
  }
}

const total = stat.both + stat.tableOnly + stat.textOnly + stat.none;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`\n金标准 Sheet3 的数值共 ${total} 个（2015 六篇），它们出现在：`);
console.log(`  只出现在表格块      ${String(stat.tableOnly).padStart(4)}  ${pct(stat.tableOnly)}`);
console.log(`  只出现在正文块      ${String(stat.textOnly).padStart(4)}  ${pct(stat.textOnly)}`);
console.log(`  表格与正文都有      ${String(stat.both).padStart(4)}  ${pct(stat.both)}`);
console.log(`  两类都找不到        ${String(stat.none).padStart(4)}  ${pct(stat.none)}`);
console.log(`  → 出现在表格里的合计 ${stat.tableOnly + stat.both} / ${total} = ${(((stat.tableOnly + stat.both) / total) * 100).toFixed(1)}%`);

console.log(`\n按字段类型：`);
for (const [k, e] of [...byLeaf.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
  const inTable = ((e.tableOnly + e.both) / e.n) * 100;
  console.log(`  ${k.padEnd(34)} n=${String(e.n).padStart(3)}  表格中 ${inTable.toFixed(0)}%  正文中 ${(((e.textOnly + e.both) / e.n) * 100).toFixed(0)}%  找不到 ${e.none}`);
}

if (notFound.length) {
  console.log(`\n两类都找不到的 ${notFound.length} 个（前 8）：`);
  for (const s of notFound.slice(0, 8)) console.log('  ' + s);
}
