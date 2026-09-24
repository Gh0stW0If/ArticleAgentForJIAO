/**
 * 一次性探针：直接读原始 xlsx 的表头行与批注（判定 canonical-field-map 的批注引用是否偏列）。
 * 用法：node tools/_xlsx_col_truth.mjs <文件名> [工作表序号]
 */
import { readWorkbook, indexToCol, norm } from './lib/xlsx.mjs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] ?? '2020-20篇-0813.xlsx';
const SI = Number(process.argv[3] ?? 0);
const wb = readWorkbook(join(ROOT, 'Datas', 'label', FILE));
const sh = wb.sheets[String(SI)] ?? wb.sheets[SI];
console.log(`工作表 ${SI} = ${sh.name}，行数 ${sh.rows.length}`);
const cellText = (c) => norm(typeof c === 'object' && c !== null ? (c.v ?? c.text ?? '') : c);
for (const ri of [0, 1, 2, 4]) {
  const cells = sh.rows[ri] ?? [];
  const parts = [];
  for (let i = 0; i < Math.min(14, cells.length); i++) {
    const t = cellText(cells[i]);
    if (t) parts.push(`${indexToCol(i)}${ri + 1}=${t.slice(0, 38)}`);
  }
  console.log(`\n第 ${ri + 1} 行：${parts.join(' | ')}`);
}
console.log(`\n批注（前 15 / 共 ${(sh.comments ?? []).length} 条）：`);
for (const c of (sh.comments ?? []).slice(0, 15)) {
  console.log(`   ref=${c.ref ?? c.cell}  ${String(c.text ?? c.v ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
}
