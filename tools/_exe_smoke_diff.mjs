/**
 * 对比"打包版 exe 跑出来的产物"与"备份的旧产物"（真机冒烟用）。
 * 用法：node tools/_exe_smoke_diff.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEW = join(ROOT, 'build', 'extraction', '2015', '2015-01.json');
const OLD = join(ROOT, 'build', '_backup_2015-01_extraction.json');
for (const [label, p] of [['新（exe 跑出）', NEW], ['旧（备份）', OLD]]) {
  if (!existsSync(p)) { console.log(`${label} 不存在：${p}`); process.exit(1); }
}
const a = JSON.parse(readFileSync(NEW, 'utf8'));
const b = JSON.parse(readFileSync(OLD, 'utf8'));
console.log('顶层键  新：', Object.keys(a).join(', '));
console.log('        旧：', Object.keys(b).join(', '));
console.log(`文章级字段数  新 ${Object.keys(a.article ?? {}).length} / 旧 ${Object.keys(b.article ?? {}).length}`);
console.log(`比较组        新 ${(a.comparisons ?? []).length} / 旧 ${(b.comparisons ?? []).length}`);
console.log(`结局行        新 ${(a.outcomes ?? []).length} / 旧 ${(b.outcomes ?? []).length}`);
console.log(`pipeline      新 ${JSON.stringify(a.pipeline)}`);
console.log(`generatedAt   新 ${a.generatedAt} / 旧 ${b.generatedAt}`);
/* europepmc 是新版 article-meta 才有的块 */
console.log(`\narticle.europepmc：新 ${a.article?.europepmc ? JSON.stringify(a.article.europepmc).slice(0, 160) : '（无）'}`);
console.log(`                   旧 ${b.article?.europepmc ? '有' : '（无）'}`);
console.log(`article.doi：新 ${JSON.stringify(a.article?.doi?.raw)} / 旧 ${JSON.stringify(b.article?.doi?.raw)}`);
/* 单位三列的写法（第三轮口径修正的落点） */
for (const k of ['frequencyDesc', 'frequencyValue', 'frequencyUnit']) {
  const g = (o) => o.comparisons?.[0]?.[k]?.raw;
  console.log(`comparison[0].${k}：新 ${JSON.stringify(g(a))} / 旧 ${JSON.stringify(g(b))}`);
}
console.log(`\nissues：新 ${(a.issues ?? []).length} 条 / 旧 ${(b.issues ?? []).length} 条`);
console.log(`unresolved：新 ${(a.unresolved ?? []).length} / 旧 ${(b.unresolved ?? []).length}`);
