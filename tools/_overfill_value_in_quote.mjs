/** 统计"过填"案例里，模型填的**数值是否字面出现在它自己给的证据句里**（客观、不含人工判断）。 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(ROOT, 'build', '_overfill_all.log'), 'utf8').split('\n');
let cases = 0; let inQuote = 0; let notIn = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^\s*\d+\. /.test(lines[i])) continue;
  cases++;
  const model = lines[i + 1] ?? ''; const ev = lines[i + 2] ?? '';
  const v = /value="([\d.]+)"/.exec(model)?.[1];
  if (!v) continue;
  if (ev.includes(v)) inQuote++; else notIn.push(`${lines[i].trim()}  value=${v}  ${ev.slice(0, 100)}`);
}
console.log(`\n"金标准全空、模型却填了值"共 ${cases} 例`);
console.log(`  模型填的数值**字面出现在自己给的证据句里**：${inQuote}（${((inQuote / cases) * 100).toFixed(0)}%）`);
console.log(`  不在自己证据句里的：${notIn.length}（${((notIn.length / cases) * 100).toFixed(0)}%）`);
console.log('\n后者的全部明细（这是唯一还能怀疑"没依据"的部分）：');
for (const x of notIn) console.log('  ' + x);
