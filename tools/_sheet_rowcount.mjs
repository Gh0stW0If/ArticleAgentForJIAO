/**
 * 核实「Sheet1 / Sheet2 / Sheet3 各是什么粒度」——直接数原始 xlsx 的数据行。
 * 用法：node tools/_sheet_rowcount.mjs <文件名>...
 */
import { readWorkbook, norm } from './lib/xlsx.mjs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['2015-6篇-0813.xlsx', '2019-19篇-0813.xlsx', '2020-20篇-0813.xlsx', '2025-33篇.xlsx'];

const isId = (s) => /^(EN|CH)?\d{2,4}[-_ ]?\d{0,3}$/i.test(String(s ?? '').trim()) && /\d/.test(String(s ?? ''));

for (const f of FILES) {
  const wb = readWorkbook(join(ROOT, 'Datas', 'label', f));
  const gold = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'build', 'gold', `${f.match(/^\d{4}/)[0]}.json`), 'utf8'));
  console.log(`\n════ ${f}   gold counts = ${JSON.stringify(gold.counts)}`);
  for (const si of [0, 1, 2]) {
    const sh = wb.sheets[String(si)];
    if (!sh) continue;
    const rows = sh.rows ?? [];
    /* 找到"文献编号/STUDYID"所在的表头行 */
    let headerRow = -1;
    for (const r of rows) {
      const cells = (r.cells ?? []).map(norm);
      if (cells.includes('文献编号') || cells.includes('STUDYID')) { headerRow = r.r; break; }
    }
    const data = rows.filter((r) => r.r > headerRow && norm((r.cells ?? [])[0]));
    const ids = data.map((r) => norm((r.cells ?? [])[0]));
    const uniq = [...new Set(ids)];
    console.log(`  Sheet${si + 1} (${sh.name})  表头行=${headerRow}  非空数据行=${data.length}  不同编号=${uniq.length}`);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) console.log(`     重复出现的编号（${new Set(dup).size} 个）：${[...new Set(dup)].slice(0, 8).join(', ')}${new Set(dup).size > 8 ? ' …' : ''}`);
    console.log(`     前 6 行编号：${ids.slice(0, 6).join(' | ')}`);
  }
}
