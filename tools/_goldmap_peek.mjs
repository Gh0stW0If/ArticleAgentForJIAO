/**
 * 一次性探针：看金标准 json 里 field_definitions / column_map 的结构。
 * 用法：node tools/_goldmap_peek.mjs [year]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Y = process.argv[2] ?? '2020';
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${Y}.json`), 'utf8'));
console.log('顶层键：', Object.keys(j).join(' | '));
console.log('\nlevel =', JSON.stringify(j.level));
console.log('counts =', JSON.stringify(j.counts));
console.log('generated_from =', JSON.stringify(j.generated_from).slice(0, 300));
console.log('\n── field_definitions ──');
const fd = j.field_definitions;
console.log('类型:', Array.isArray(fd) ? 'array' : typeof fd, ' 键:', Object.keys(fd).join(', '));
for (const [lvl, arr] of Object.entries(fd)) {
  console.log(`  [${lvl}] ${Array.isArray(arr) ? arr.length : typeof arr} 项`);
  if (Array.isArray(arr)) for (const f of arr.slice(0, 6)) console.log('     ', JSON.stringify(f));
}
console.log('\n── column_map ──');
const cm = j.column_map;
console.log('类型:', Array.isArray(cm) ? `array(${cm.length})` : typeof cm);
if (Array.isArray(cm)) for (const c of cm.slice(0, 8)) console.log('  ', JSON.stringify(c));
else for (const [k, v] of Object.entries(cm).slice(0, 8)) console.log('  ', k, '=>', JSON.stringify(v).slice(0, 200));
console.log('\n── data_quality ──');
console.log(JSON.stringify(j.data_quality).slice(0, 600));
console.log('\n── warnings ──');
console.log(JSON.stringify(j.warnings).slice(0, 600));
