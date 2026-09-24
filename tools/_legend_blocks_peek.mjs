/**
 * 一次性探针：Sheet3 里 B/E/F 三块的时间点列（如 BIESTI、BRR、BDINFRI）原始中文表头。
 * 用法：node tools/_legend_blocks_peek.mjs [year] [前缀 B|E|F]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Y = process.argv[2] ?? '2020';
const P = process.argv[3] ?? 'B';
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'legend', `${Y}.json`), 'utf8'));
const s3 = j.sheets.Sheet3;
for (const f of s3.fields) {
  const hdrs = (f.headerLabels ?? []).map((h) => h.text);
  const code = hdrs[hdrs.length - 1] ?? '';
  if (!new RegExp(`^${P}[A-Z]{3,}`).test(code)) continue;
  console.log(`${f.col.padEnd(4)} ${code.padEnd(9)} ${String(f.field).padEnd(18)} | ${hdrs.slice(0, -1).join(' / ').slice(0, 90)} | codes=${f.codes ? JSON.stringify(f.codes).slice(0, 60) : '-'}`);
}
