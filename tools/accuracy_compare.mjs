/**
 * 对比两份 `accuracy_overview.mjs --json` 产物（改管线前 / 后）。
 *
 * 用法：node tools/accuracy_compare.mjs --before build/accuracy_before.json --after build/accuracy_after.json
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const B = JSON.parse(readFileSync(join(ROOT, arg('before', 'build/accuracy_before.json')), 'utf8'));
const A = JSON.parse(readFileSync(join(ROOT, arg('after', 'build/accuracy_after.json')), 'utf8'));

const d = (a, b) => `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(1)}`;
console.log('\n══ 准确率 A/B（统一口径）══\n');
console.log('  工作表                   字段数(旧→新)      准确率 旧 → 新         变化');
const LABEL = { 1: 'Sheet1（文章级+比较组）', 2: 'Sheet2（结局分类）', 3: 'Sheet3（结局×时点）' };
for (const k of ['1', '2', '3']) {
  const b = B.sheets[k]; const a = A.sheets[k];
  console.log(`  ${LABEL[k].padEnd(22)}${String(b.n).padStart(6)} → ${String(a.n).padStart(6)}   `
    + `${b.rate.toFixed(1).padStart(5)}% → ${a.rate.toFixed(1).padStart(5)}%   ${d(a.rate, b.rate).padStart(6)} 点`);
}
console.log(`  ${'合计'.padEnd(22)}${String(B.total.n).padStart(6)} → ${String(A.total.n).padStart(6)}   `
  + `${B.total.rate.toFixed(1).padStart(5)}% → ${A.total.rate.toFixed(1).padStart(5)}%   ${d(A.total.rate, B.total.rate).padStart(6)} 点`);

console.log('\n  分年：');
console.log('   年份   旧      新      变化');
const byYear = new Map(A.perYear.map((p) => [p.year, p]));
for (const bp of B.perYear) {
  const ap = byYear.get(bp.year);
  if (!ap) continue;
  const sum = (p) => { let n = 0; let w = 0; for (const k of ['1', '2', '3']) { const s = p.sheets[k]; if (!s) continue; n += s.n; w += s.rate * s.n / 100; } return n ? (w / n) * 100 : 0; };
  const rb = sum(bp); const ra = sum(ap);
  console.log(`   ${bp.year}  ${rb.toFixed(1).padStart(5)}%  ${ra.toFixed(1).padStart(5)}%  ${d(ra, rb).padStart(6)} 点`);
}
console.log('');
