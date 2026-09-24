/** 比对：重新生成的金标准 vs 原有 build/gold，文章集是否一致（不能用"重新生成"悄悄换掉基线）。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = join(ROOT, 'build', '_gold_original');        // 刚从 Datas 重新生成
const B = join(ROOT, 'build', '_backup_gold_fixed');    // 原有 build/gold（含我第一轮的修正）

const ids = (dir, f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')).articles ?? []).map((a) => a.article_id);
let ta = 0; let tb = 0;
console.log('\n年份   重新生成   原有   差异');
for (const f of readdirSync(A)) {
  if (!f.endsWith('.json')) continue;
  const a = ids(A, f); const b = ids(B, f);
  ta += a.length; tb += b.length;
  const onlyA = a.filter((x) => !b.includes(x));
  const onlyB = b.filter((x) => !a.includes(x));
  console.log(`  ${f.replace('.json', '')}   ${String(a.length).padStart(4)}   ${String(b.length).padStart(4)}   ${onlyA.length || onlyB.length ? `仅新生成：[${onlyA.join(',')}] 仅原有：[${onlyB.join(',')}]` : '一致'}`);
}
console.log(`  合计   ${ta}   ${tb}`);
