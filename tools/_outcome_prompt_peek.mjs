/**
 * 一次性探针：打印 outcome-plan / outcome 提示词里关于"抽几个结局"的要求。
 * 用法：node tools/_outcome_prompt_peek.mjs [关键词]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'packages', 'skills', 'src', 'prompts.generated.ts'), 'utf8');
const out = [];
out.push(`文件长度 ${src.length}`);
const names = [...src.matchAll(/export const ([A-Z0-9_]+)/g)].map((m) => m[1]);
out.push(`导出的提示词常量：${names.join(', ')}`);

const KEYS = process.argv[2] ? [process.argv[2]] : ['OUTCOME_PLAN', 'OUTCOME_TASK', 'OUTCOME_SYSTEM'];
for (const n of names) {
  if (!KEYS.some((k) => n.includes(k))) continue;
  const idx = src.indexOf(`export const ${n}`);
  const seg = src.slice(idx, idx + 6000);
  out.push(`\n════ ${n} ════`);
  /* 只挑"整句/整段"里跟数量、范围有关的行 */
  for (const line of seg.split('\\n')) {
    if (/结局|outcome|所有|全部|每|一个|主结局|次要/.test(line)) out.push('  ' + line.slice(0, 200));
  }
}
writeFileSync(join(ROOT, 'build', '_outcome_prompt_peek.txt'), out.join('\n'), 'utf8');
console.log(out.join('\n').slice(0, 6000));
console.log('\n（完整内容写入 build/_outcome_prompt_peek.txt）');
