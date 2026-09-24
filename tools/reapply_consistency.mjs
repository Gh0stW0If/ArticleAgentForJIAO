/**
 * 对**已抽取产物**重放"数值 ↔ 编码"自洽规则（不调用 LLM，可重复运行）。
 *
 * 用途：改了 `inferMeasurementType` 的判据后，不必重新花钱跑一遍流水线，
 * 直接按现有 `timepoints` 把 `measurementType` 纠正到位。
 * 与 `tools/llm_run.mjs` 在回填时调用的是**同一个函数**（`applyMeasurementType`），
 * 因此不会出现"重跑一遍结果又变了"的口径漂移。
 *
 * 用法：node tools/reapply_consistency.mjs [--year 2015]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMeasurementType } from '../packages/skills/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let year = '2015';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--year') year = argv[++i];

const dir = join(ROOT, 'build', 'extraction', year);
let rows = 0;
let adjusted = 0;
for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{1,2}\.json$/.test(x))) {
  const p = join(dir, f);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  let fileAdjusted = 0;
  for (const row of j.outcomes ?? []) {
    if (!row.timepoints) continue;
    rows++;
    const code = applyMeasurementType(row, row.timepoints);
    if (code) {
      adjusted++;
      fileAdjusted++;
      console.log(`  ${j.articleId} 「${(row.outcome?.name?.raw ?? '?').slice(0, 26)}」 → measurementType=${code}`);
    }
  }
  if (fileAdjusted) writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
}
console.log(`\n扫描 ${rows} 行，修正 measurementType ${adjusted} 行\n`);
