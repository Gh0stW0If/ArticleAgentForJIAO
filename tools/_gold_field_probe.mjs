/**
 * 一次性探针：打印金标准 json 中某篇文章的指定字段 + 原始列名。
 * 用法：node tools/_gold_field_probe.mjs <articleId> [字段片段...]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = process.argv[2];
const FRAGS = process.argv.slice(3);
const DIR = join(ROOT, 'build', 'gold_json');

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
console.log('gold_json 文件：', files.join(', '));
let art = null;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  const list = Array.isArray(j) ? j : (j.articles ?? j.rows ?? []);
  const hit = list.find((a) => a.articleId === ID || a.id === ID);
  if (hit) { art = hit; console.log(`\n命中于 ${f}`); break; }
}
if (!art) {
  console.log('未找到文章；可用字段：');
  const j = JSON.parse(readFileSync(join(DIR, files[0]), 'utf8'));
  const list = Array.isArray(j) ? j : (j.articles ?? j.rows ?? []);
  console.log(JSON.stringify(list[0], null, 1).slice(0, 2500));
  process.exit(0);
}
const dump = (o, prefix = '') => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const full = `${prefix}${k}`;
    if (FRAGS.length && !FRAGS.some((f) => full.includes(f))) continue;
    console.log(`  ${full} = ${JSON.stringify(v).slice(0, 200)}`);
  }
};
console.log('\n--- 顶层 ---');
dump(art);
const cmps = art.comparisons ?? art.comparison;
if (Array.isArray(cmps)) cmps.forEach((g, i) => { console.log(`\n--- comparison[${i}] ---`); dump(g); });
else if (cmps) { console.log('\n--- comparison ---'); dump(cmps); }
