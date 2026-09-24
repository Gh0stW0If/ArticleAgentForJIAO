/**
 * 一次性探针：gold 里 `binary.difference_*` 装的是什么值？（位置在连续型区块里，疑似分组名写错）
 * 用法：node tools/_dest_probe.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
let n = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of j.articles ?? []) for (const o of a.outcomes ?? []) {
    for (const [bn, bv] of Object.entries(o.timepoints ?? {})) {
      if (!bv || typeof bv !== 'object') continue;
      const d = bv.binary?.difference_estimate;
      if (!d || !('raw' in d)) continue;
      if (n++ < 10) {
        console.log(`${y} ${a.article_id}  ${bn}  outcome=${JSON.stringify(o.outcome?.name?.raw)}  工具=${JSON.stringify(o.outcome?.instrument?.raw)}`);
        console.log(`   binary.difference_estimate = ${JSON.stringify(d.raw)}${d.code ? ` (code ${d.code})` : ''}   ci=[${bv.binary?.difference_ci_lower?.raw ?? '-'}, ${bv.binary?.difference_ci_upper?.raw ?? '-'}]`);
        console.log(`   同块连续型 = ${JSON.stringify(bv.continuous?.experimental?.estimate?.raw ?? '-')} vs ${JSON.stringify(bv.continuous?.control?.estimate?.raw ?? '-')}`);
        console.log(`   同块二分类 = exp ${JSON.stringify(bv.binary?.experimental?.events?.raw ?? '-')}/${JSON.stringify(bv.binary?.experimental?.n?.raw ?? '-')}  ctl ${JSON.stringify(bv.binary?.control?.events?.raw ?? '-')}/${JSON.stringify(bv.binary?.control?.n?.raw ?? '-')}`);
      }
    }
  }
}
console.log(`\n含 binary.difference_estimate 的时点块共 ${n} 个`);
