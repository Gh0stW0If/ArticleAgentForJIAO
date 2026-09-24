/** 结构性问题的量化：比较组数不一致把多少字段带错位？两个方向的后果不同。 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const more = []; const fewer = [];
let totalFields = 0;
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(gf) || !existsSync(d)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    const pf = join(d, `${a.article_id}.json`);
    if (!existsSync(pf)) continue;
    let pred;
    try { pred = JSON.parse(readFileSync(pf, 'utf8')); } catch { continue; }
    const gn = (a.comparisons ?? []).length; const pn = (pred.comparisons ?? []).length;
    if (gn === pn) continue;
    const rec = { id: a.article_id, gold: gn, pred: pn, fields: gn * 62 };
    if (pn > gn) more.push(rec); else fewer.push(rec);
  }
}

const sum = (arr) => arr.reduce((s, r) => s + r.fields, 0);
console.log('\n══ 比较组数不一致的两种方向 ══\n');
console.log(`  机器**多**出比较组：${more.length} 篇 → 多出的那部分字段全部算"多填"（用户口径下可忽略）`);
console.log(`     例：${more.slice(0, 6).map((r) => `${r.id}(${r.gold}→${r.pred})`).join('、')}`);
console.log(`  机器**少**了比较组：${fewer.length} 篇 → 缺失那组的字段**全部算漏抽**（不可忽略）`);
console.log(`     例：${fewer.slice(0, 6).map((r) => `${r.id}(${r.gold}→${r.pred})`).join('、')}`);
console.log(`\n  受影响的"比较组字段"规模（按每比较组 62 个字段估）：`);
console.log(`     多出方向 ${sum(more)} 个（多填桶）｜缺失方向 **${sum(fewer)} 个**（漏抽桶）`);

/* 少比较组的那些篇，实际漏了多少字段 */
const fewerIds = new Set(fewer.map((r) => r.id));
let missedOnFewer = 0;
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const j of rep.sheets?.sheet3?.judged ?? []) void j;
  for (const j of rep.sheets?.sheet1?.judged ?? []) {
    if (!fewerIds.has(String(j.key).split('/')[0])) continue;
    if (/^(NR|NA|NE)[.。]?$/i.test(String(j.pred ?? '').trim()) && String(j.gold ?? '').trim()) missedOnFewer++;
  }
}
console.log(`     其中语义判定条目里确认为漏的：${missedOnFewer}`);
