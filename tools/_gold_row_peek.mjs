/** 一次性：看几条具体行的原始形态（范围、异常编码），确保修正逻辑不会写坏结构。 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const show = (year, id, idx, keys) => {
  const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${year}.json`), 'utf8'));
  const a = (gold.articles ?? []).find((x) => x.article_id === id);
  if (!a) { console.log(`${id} 未找到`); return; }
  const c = (a.comparisons ?? [])[idx];
  console.log(`── ${year} ${id} 比较组${idx + 1} ──`);
  for (const k of keys) console.log(`   ${k} = ${JSON.stringify(c[k])}`);
};

console.log('=== 范围写法 ===');
show('2017', '2017-04', 0, ['needle_retention_desc', 'needle_retention_value', 'needle_retention_unit']);
show('2018', '2018-09', 0, ['frequency_desc', 'frequency_value', 'frequency_unit']);

console.log('\n=== 最长随访：2020 年后的编码异常 ===');
show('2021', '2021-05', 0, ['max_followup_desc', 'max_followup_value', 'max_followup_unit']);
show('2020', '2020-10', 0, ['max_followup_desc', 'max_followup_value', 'max_followup_unit']);
show('2025', '2025-13', 0, ['max_followup_desc', 'max_followup_value', 'max_followup_unit']);

console.log('\n=== 留针时间：纯数字 desc ===');
show('2015', '2015-01', 0, ['needle_retention_desc', 'needle_retention_value', 'needle_retention_unit']);
show('2020', '2020-10', 0, ['needle_retention_desc', 'needle_retention_value', 'needle_retention_unit']);

console.log('\n=== 疗程：月→周 的换算 ===');
show('2015', '2015-06', 0, ['course_desc', 'course_value', 'course_unit']);

console.log('\n=== 治疗频次：短语形态 ===');
show('2015', '2015-02', 0, ['frequency_desc', 'frequency_value', 'frequency_unit']);
show('2015', '2015-06', 0, ['frequency_desc', 'frequency_value', 'frequency_unit']);
