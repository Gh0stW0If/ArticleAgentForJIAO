/**
 * 一次性探针：看某篇/某年 comparison 各组的关键字段实际抽到了什么。
 * 用法：node tools/_cmp_group_probe.mjs <year> [文章id前缀] [字段名片段]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEAR = process.argv[2] ?? '2020';
const PREFIX = process.argv[3] ?? '';
const FRAG = process.argv[4] ?? '';
const dir = join(ROOT, 'build', 'extraction', YEAR);
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(PREFIX)).slice(0, 4);

const KEYS = ['analyzed_n_experimental','analyzed_n_control','total_sessions_class_a','total_sessions_class_b','group_label'];
for (const f of files) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const rows = j.comparisons ?? j.comparison?.comparisons ?? [];
  console.log(`\n=== ${YEAR}/${f}  组数=${rows.length}`);
  rows.forEach((g, i) => {
    const o = { _i: i };
    for (const k of KEYS) {
      const hit = Object.keys(g).find((kk) => kk === k) ?? Object.keys(g).find((kk) => kk.includes(k));
      if (hit) o[k] = g[hit];
    }
    if (FRAG) {
      for (const kk of Object.keys(g)) if (kk.includes(FRAG)) o[kk] = g[kk];
    }
    console.log('  ' + JSON.stringify(o).slice(0, 400));
  });
}
if (!files.length) console.log('（没有匹配的抽取文件）');
void existsSync;
