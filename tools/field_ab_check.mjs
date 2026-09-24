/**
 * 单字段 A/B：用备份目录里的旧产物，与当前产物逐篇比较**某一个字段**的取值变化。
 *
 * 用途：改了材料/提示词之后，先在一小批篇上验证单字段效果，不必等全量重跑 + 重跑评测。
 * 与 `tools/latex_ab_fields.mjs` 的分工：那个只统计"修复前材料里读不出来"的金标准字段，
 * 这个可以指定任意字段、任意篇，并把**新旧取值并排打出来**便于人工核对。
 *
 * 用法：
 *   node tools/field_ab_check.mjs --field article.author_contact --old build/_backup_achint [--gold]
 * 输出：`✓ 变对` / `✗ 变错` / `= 未变`，并给出加权正确率的前后对比。
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const FIELD = arg('field', 'article.author_contact');
const OLD_DIR = arg('old', 'build/_backup_achint');
const SHOW_GOLD = argv.includes('--gold');

/**
 * 取值是否等价。
 *
 * ⚠️ 邮箱这类字段**不能用"整串去空格比较"**：金标准里带大量写法噪声——
 *   `1:1360 1180524@139.com.`（序号前缀 + 中缝号 + 尾点）、
 *   `lcohen@mdanderson.org/mengzhq@yeah.net`（两个邮箱用斜杠连写）、
 *   `wwang@vip.126.com (corresponding)`（尾随说明）、
 *   `Charlie.xue@rmit. edu.au`（OCR 空格）。
 * 按整串比会把"其实抽对了"的判成错（实测 21 篇里有 5 篇被误判）。
 * 因此对含 `@` 的字段改为**按邮箱 token 取交集**：命中即算对。
 */
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const emailTokens = (s) => (String(s ?? '').match(EMAIL_TOKEN) ?? [])
  .map((e) => e.replace(/\s+/g, '').toLowerCase());

const eq = (a, b) => {
  if (a === undefined || b === undefined) return false;
  const ta = emailTokens(a); const tb = emailTokens(b);
  if (ta.length || tb.length) return ta.some((x) => tb.includes(x));
  const f = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  return f(a) === f(b);
};

/** 从金标准里取该字段的 raw。 */
function goldValue(year, id, field) {
  const f = join(ROOT, 'build', 'gold', `${year}.json`);
  if (!existsSync(f)) return undefined;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  const ga = (gold.articles ?? []).find((a) => a.article_id === id);
  if (!ga) return undefined;
  const [, ...rest] = field.split('.');
  const path = rest.join('.');
  const tryGet = (obj) => {
    const leaf = obj?.[path];
    return leaf && typeof leaf === 'object' && 'raw' in leaf ? leaf.raw : undefined;
  };
  if (field.startsWith('article.')) return tryGet(ga.article) ?? tryGet(ga.study);
  if (field.startsWith('comparison.')) return tryGet((ga.comparisons ?? [])[0]);
  return undefined;
}

/** 从抽取产物里取值（camelCase 键）。 */
function predValue(pred, field) {
  const [scope, ...rest] = field.split('.');
  const camel = rest.join('.').replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const get = (obj) => obj?.[camel]?.raw;
  if (scope === 'article') return get(pred.article);
  if (scope === 'comparison') return get((pred.comparisons ?? [])[0]);
  return undefined;
}

const oldFiles = readdirSync(join(ROOT, OLD_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const rows = [];
for (const f of oldFiles) {
  const id = f.replace(/\.json$/, '');
  const year = id.slice(0, 4);
  const newFile = join(ROOT, 'build', 'extraction', year, `${id}.json`);
  if (!existsSync(newFile)) continue;
  const oldPred = JSON.parse(readFileSync(join(ROOT, OLD_DIR, f), 'utf8'));
  const newPred = JSON.parse(readFileSync(newFile, 'utf8'));
  const gold = goldValue(year, id, FIELD);
  const o = predValue(oldPred, FIELD);
  const n = predValue(newPred, FIELD);
  rows.push({ id, gold, old: o, new: n, okOld: eq(o, gold), okNew: eq(n, gold) });
}

const n = rows.length;
const okOld = rows.filter((r) => r.okOld).length;
const okNew = rows.filter((r) => r.okNew).length;
const fixed = rows.filter((r) => !r.okOld && r.okNew);
const broke = rows.filter((r) => r.okOld && !r.okNew);

console.log(`\n══ 单字段 A/B：${FIELD} ══（${n} 篇，旧目录 ${OLD_DIR}）\n`);
console.log(`  旧：${okOld}/${n} = ${((okOld / n) * 100).toFixed(1)}%`);
console.log(`  新：${okNew}/${n} = ${((okNew / n) * 100).toFixed(1)}%`);
console.log(`  ⇒ 修好 ${fixed.length} 篇 / 弄坏 ${broke.length} 篇\n`);
for (const r of rows) {
  const mark = r.okNew && !r.okOld ? '✓ 变对' : r.okOld && !r.okNew ? '✗ 变错' : r.okNew ? '= 仍对' : '= 仍错';
  console.log(`  ${mark}  ${r.id}`);
  console.log(`     旧: ${JSON.stringify(String(r.old ?? '（缺）').slice(0, 62))}`);
  console.log(`     新: ${JSON.stringify(String(r.new ?? '（缺）').slice(0, 62))}`);
  if (SHOW_GOLD) console.log(`     金: ${JSON.stringify(String(r.gold ?? '（无）').slice(0, 62))}`);
}

writeFileSync(join(ROOT, 'build', `field_ab_${FIELD.replace(/\./g, '_')}.json`),
  JSON.stringify({ at: new Date().toISOString(), field: FIELD, n, okOld, okNew, rows }, null, 1), 'utf8');
console.log(`\n明细 build/field_ab_${FIELD.replace(/\./g, '_')}.json\n`);
