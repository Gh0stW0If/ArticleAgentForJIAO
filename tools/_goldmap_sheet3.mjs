/**
 * 一次性探针：看 Sheet3（结局×时点）的列映射结构。
 * 用法：node tools/_goldmap_sheet3.mjs [year]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Y = process.argv[2] ?? '2020';
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${Y}.json`), 'utf8'));
const fd = j.field_definitions;
console.log('outcome_columns（前 60）：');
console.log('  ' + fd.outcome_columns.slice(0, 60).join(', '));
console.log('\noutcome_top_map：');
console.log(JSON.stringify(fd.outcome_top_map, null, 1).slice(0, 1500));
console.log('\ntimepoint_blocks：');
console.log(JSON.stringify(fd.timepoint_blocks, null, 1).slice(0, 1500));
console.log('\ntimepoint_block_labels：');
console.log(JSON.stringify(fd.timepoint_block_labels, null, 1).slice(0, 900));
console.log('\nblock_field_map：');
console.log(JSON.stringify(fd.block_field_map, null, 1).slice(0, 2500));

/* 实际一行的键 */
const a = (j.articles ?? [])[0];
const o = (a.outcomes ?? [])[0];
console.log('\n── 金标准第一篇文章第一条结局行的键（前 40）──');
console.log('  ' + Object.keys(o ?? {}).slice(0, 40).join(', '));
console.log('  条目样例：', JSON.stringify(Object.entries(o ?? {}).slice(0, 6), null, 1).slice(0, 900));
console.log('  结局对象样例：', JSON.stringify(o?.outcome, null, 1).slice(0, 700));
