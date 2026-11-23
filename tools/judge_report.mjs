/**
 * 语义判定报告：把 LLM 判定结果按类别导出，用于**反推措辞规约**。
 *
 * 背景：Sheet2/Sheet3 的金标准是自然语言，严格字符匹配必然低估。
 * 语义判定把差异分成五类后，最有价值的是 **same_meaning（含义一致但写法不同）**——
 * 这一批说明"内容抽对了、只是写法与金标准不同"，因此可以把其中的规律
 * 直接写成提示词里的写法要求（比继续调字段定义更有效）。
 *
 * 用法：
 *   node tools/judge_report.mjs                 # 全部（读 build/judge-cache.json）
 *   node tools/judge_report.mjs --verdict same_meaning
 *   node tools/judge_report.mjs --md > build/judge-report.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeCachePath, VERDICT_LABEL } from './lib/judge.mjs';
import { loadLlmConfig } from './lib/llm-config.mjs';

const ROOT = process.env.AA_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadLlmConfig(ROOT, { optional: true });
const CACHE = judgeCachePath(ROOT, { ...cfg, model: cfg.reviewModel });

const argv = process.argv.slice(2);
const onlyVerdict = argv.includes('--verdict') ? argv[argv.indexOf('--verdict') + 1] : null;
const asMd = argv.includes('--md');

if (!existsSync(CACHE)) {
  console.error('当前评审模型没有判定缓存，请先运行 pnpm llm:eval');
  process.exit(2);
}

const cache = JSON.parse(readFileSync(CACHE, 'utf8'));

/** 缓存键 = field \0 gold \0 pred（见 tools/lib/judge.mjs）。 */
const rows = [];
for (const [k, v] of Object.entries(cache)) {
  const [field, gold, pred] = k.split('\u0000');
  if (!field) continue;
  rows.push({ field, gold: gold ?? '', pred: pred ?? '', verdict: v.verdict, reason: v.reason ?? '' });
}

const byVerdict = new Map();
for (const r of rows) {
  if (!byVerdict.has(r.verdict)) byVerdict.set(r.verdict, []);
  byVerdict.get(r.verdict).push(r);
}

const out = [];
const w = (s = '') => { out.push(s); if (!asMd) console.log(s); };

w(`# 语义判定报告（Sheet2 / Sheet3 自然语言字段）`);
w();
w(`共判定 ${rows.length} 组：`);
for (const [v, list] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) {
  w(`- **${VERDICT_LABEL[v] ?? v}** ${list.length} 组`);
}
w();

const verdicts = onlyVerdict ? [onlyVerdict] : [...byVerdict.keys()].sort((a, b) => (byVerdict.get(b).length - byVerdict.get(a).length));

for (const v of verdicts) {
  const list = byVerdict.get(v);
  if (!list?.length) continue;
  w(`\n## ${VERDICT_LABEL[v] ?? v}（${list.length} 组）\n`);
  for (const r of list) {
    w(`- \`${r.field}\``);
    w(`  - 金标准：${r.gold.replace(/\s+/g, ' ').slice(0, 200)}`);
    w(`  - 抽取值：${r.pred.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (r.reason) w(`  - 判定理由：${r.reason}`);
  }
}

if (asMd) {
  mkdirSync(join(ROOT, 'build'), { recursive: true });
  const file = join(ROOT, 'build', 'judge-report.md');
  writeFileSync(file, out.join('\n'), 'utf8');
  console.log(`→ ${file.replace(ROOT + '\\', '')}`);
} else {
  const file = join(ROOT, 'build', 'judge-report.md');
  writeFileSync(file, out.join('\n'), 'utf8');
  console.log(`\n（同时写入 build/judge-report.md）`);
}
