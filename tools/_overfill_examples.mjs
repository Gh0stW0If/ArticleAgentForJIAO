/**
 * 举例：某篇文章的"多出行"到底是什么。
 * 用法：node tools/_overfill_examples.mjs <articleId> [更多id...]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignOutcomes } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDS = process.argv.slice(2);
for (const id of IDS) {
  const y = id.split('-')[0];
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  const xf = join(ROOT, 'build', 'extraction', y, `${id}.json`);
  if (!existsSync(gf) || !existsSync(xf)) { console.log(`\n${id}: 缺文件`); continue; }
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const g = (gold.articles ?? []).find((a) => a.article_id === id);
  const pred = JSON.parse(readFileSync(xf, 'utf8'));
  const gOuts = g?.outcomes ?? [];
  const pOuts = pred.outcomes ?? [];
  const { goldToPred, usedPred, alignments } = alignOutcomes(gOuts, pOuts);
  const nm = (o) => `${o?.outcome?.name?.raw ?? '?'} / ${o?.outcome?.instrument?.raw ?? ''}`.slice(0, 78);
  console.log(`\n════ ${id}   金标准 ${gOuts.length} 行 / 机器 ${pOuts.length} 行 / 配上 ${usedPred.size} 对`);
  console.log('  ── 金标准行 ──');
  gOuts.forEach((o, i) => console.log(`   g${i + 1} → 机器#${goldToPred.get(i) === undefined ? '（未配上）' : goldToPred.get(i) + 1}  ${nm(o)}`));
  console.log('  ── 机器行 ──');
  pOuts.forEach((o, i) => console.log(`   p${i + 1} ${usedPred.has(i) ? ' ' : '✗多出'}  ${nm(o)}`));
  console.log(`  ── 对齐（弱对齐 ${alignments.filter((a) => a.kind === 'weak').length} 对）──`);
  for (const a of alignments.filter((x) => x.kind !== 'text').slice(0, 6)) {
    console.log(`   g${a.gi + 1} ↔ p${a.pi + 1}  kind=${a.kind} 文本分=${a.textScore.toFixed(2)} 数值佐证=${a.corr}`);
  }
}
