/** 一次性验证：线上材料里，数值是否真的以"数字被空格拆散"的 LaTeX 形式出现。 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { ingest } from '../packages/ingest/dist/index.js';
import { collectMaterials } from '../packages/skills/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const year = process.argv[2] ?? '2015';
const id = process.argv[3] ?? '2015-02';
const doc = ingest({ rootDir: ROOT, year, studyId: id }).doc;
const mat = collectMaterials(doc, { sections: ['methods', 'results', 'abstract'], tables: true, figures: false, maxCharsPerBlock: 6000 }).text;

writeFileSync(resolve(ROOT, 'build', `_material_${id}.txt`), mat, 'utf8');
for (const needle of ['41.75', '4 1 . 7 5', '20.66', '2 0 . 6 6', '0.737', '0 . 7 3 7']) {
  const i = mat.indexOf(needle);
  console.log(`${JSON.stringify(needle).padEnd(14)} → ${i < 0 ? '未出现' : `出现（位置 ${i}）`}`);
}
const i = mat.indexOf('4 1 . 7 5');
if (i >= 0) {
  console.log('\n材料片段：');
  console.log(mat.slice(Math.max(0, i - 300), i + 300));
}
const spaced = (mat.match(/\d(?:\s+\d)+/g) ?? []).length;
const texCmd = (mat.match(/\\[a-zA-Z]{2,}/g) ?? []).length;
console.log(`\n材料总长 ${mat.length}；"数字被空格拆散"片段 ${spaced} 个；LaTeX 命令 ${texCmd} 个`);
