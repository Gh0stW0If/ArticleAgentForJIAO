/**
 * "判错的东西有多少是真的错？"——把**描述性字段**的失配送去语义判定。
 *
 * 背景：`llm_eval` 只对 study / outcome / 时点块做语义判定（见 JUDGE_SCOPES），
 * **文章级（metadata）与比较组层都是严格字符匹配**。这两层里大量字段是自然语言：
 *   · 比较组层：`intervention` / `control` / `randomization_method`（占 Sheet1 的 81%）；
 *   · 文章级：`title` / `journal` / `first_author` / `author_contact` / `condition`。
 * 金标准写 "usual care group"，机器写 "usual care" 就会被判错。
 *
 * 本工具不看单篇印象，而是**固定种子随机抽样**当前判为"错"的描述性字段对，
 * 交给同一套语义判定（完全一致 / 含义一致 / 包含正确信息 / 存在错误 / 完全不一致），
 * 用比例回答：严格匹配到底低估了多少。
 *
 * 用法：
 *   node tools/desc_field_judge.mjs --scope article      # 文章级（metadata）
 *   node tools/desc_field_judge.mjs --scope comparison   # 比较组层
 *   node tools/desc_field_judge.mjs --scope both --n 400
 * 输出：build/desc-field-judge-<scope>.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normText, normNum } from './lib/align.mjs';
import { judgePairs, VERDICT_LABEL, VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const N = Number(arg('n', 300));
const SEED = Number(arg('seed', 20260916));
const SCOPE = String(arg('scope', 'comparison'));

const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const NO_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check', 'title_sheet2', 'row_id', 'article_id', 'study_id']);
/* 驼峰转换要处理数字：funding_1 → funding1、impact_factor_2019 → impactFactor2019 */
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const isNumeric = (s) => normNum(s) !== null;
const isCode = (s) => /^[0-9]+(\/[0-9]+)?$/.test(String(s).trim());

/* ---------- 收集"当前被判错"的描述性字段对 ---------- */
const wrong = [];
const perField = new Map();
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const ga of gold.articles ?? []) {
    const pf = join(ROOT, 'build', 'extraction', y, `${ga.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));

    const push = (k, g, p) => {
      // 只关心"描述性"字段：数值/编码仍应严格匹配，语义判定没有意义
      if (isNumeric(g) || isCode(g)) return;
      if (normText(g) === normText(p)) return;
      wrong.push({ id: ga.article_id, year: y, field: k, gold: g, pred: p });
      const c = perField.get(k) ?? { n: 0, missing: 0 };
      c.n++; if (!p) c.missing++;
      perField.set(k, c);
    };

    if (SCOPE === 'article' || SCOPE === 'both') {
      for (const [k, gv] of Object.entries(ga.article ?? {})) {
        if (NO_GOLD.has(k)) continue;
        const g = String(gv?.raw ?? '').trim();
        if (!g) continue;
        push(k, g, String(pred.article?.[camel(k)]?.raw ?? '').trim());
      }
    }
    if (SCOPE === 'comparison' || SCOPE === 'both') {
      const gc = ga.comparisons ?? [], pc = pred.comparisons ?? [];
      for (let i = 0; i < Math.min(gc.length, pc.length); i++) {
        for (const [k, gv] of Object.entries(gc[i] ?? {})) {
          if (NO_GOLD.has(k)) continue;
          const g = String(gv?.raw ?? '').trim();
          if (!g) continue;
          push(k, g, String(pc[i]?.[camel(k)]?.raw ?? '').trim());
        }
      }
    }
  }
}

/* ---------- 固定种子随机抽样 ---------- */
const rand = (() => { let s = SEED >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const pool = [...wrong];
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const sample = pool.slice(0, Math.min(N, pool.length));

/* ---------- 语义判定（批量 + 缓存） ---------- */
const cfgPath = join(ROOT, 'runtime', 'llm.local.json');
let cfg = {};
if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* 忽略 */ } }
const apiKey = process.env.DEEPSEEK_API_KEY ?? cfg.apiKey;
if (!apiKey) {
  console.error('\n缺少 API key：把 key 放进 runtime/llm.local.json（或设 DEEPSEEK_API_KEY）。');
  process.exit(2);
}
const pairs = sample.map((s, i) => ({ key: `${s.id}/${s.field}#${i}`, field: `${SCOPE}.${s.field}`, gold: s.gold, pred: s.pred }));
console.log(`【${SCOPE}】当前判错的描述性字段 ${wrong.length} 组，抽样 ${pairs.length} 组送语义判定…`);
const results = await judgePairs(pairs, {
  apiKey,
  ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
  model: process.env.AA_JUDGE_MODEL ?? cfg.model,
  batchSize: 8,
  onProgress: (m) => console.log(m),
});
const stat = {};
const perFieldStat = new Map();
const byKey = new Map(results.map((r) => [r.key, r]));
for (const [key, r] of byKey) {
  const v = r?.verdict ?? 'unknown';
  stat[v] = (stat[v] ?? 0) + 1;
  const idx = Number(key.split('#').pop());
  const field = sample[idx]?.field ?? '?';
  const c = perFieldStat.get(field) ?? { n: 0, score: 0, good: 0 };
  c.n++; c.score += VERDICT_WEIGHT[v] ?? 0; if ((VERDICT_WEIGHT[v] ?? 0) >= 1) c.good++;
  perFieldStat.set(field, c);
}

const total = pairs.length;
console.log(`\n语义判定结果（共 ${total} 组，原先全部按"错"计）：`);
for (const [k, v] of Object.entries(stat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${VERDICT_LABEL[k] ?? k}  ${String(v).padStart(4)}  ${((v / total) * 100).toFixed(0)}%`);
}
const weighted = Object.entries(stat).reduce((a, [k, v]) => a + (VERDICT_WEIGHT[k] ?? 0) * v, 0);
const good = (stat.identical ?? 0) + (stat.same_meaning ?? 0);
console.log(`\n按现有权重折算：${good} 组本应算"对"（${((good / total) * 100).toFixed(0)}%），加权得分 ${(weighted / total * 100).toFixed(0)}%`);
console.log(`外推到全部 ${wrong.length} 组失配：约 ${Math.round((good / total) * wrong.length)} 组其实是同一含义，`
  + `${Math.round((weighted / total) * wrong.length)} 组按权重计分。`);

console.log('\n按字段看（抽样内）：');
for (const [k, c] of [...perFieldStat.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
  console.log(`  ${k.padEnd(28)} 抽样 ${String(c.n).padStart(3)}  含义一致及以上 ${String(c.good).padStart(3)}（${((c.good / c.n) * 100).toFixed(0)}%）`);
}

const out = join(ROOT, 'build', `desc-field-judge-${SCOPE}.json`);
writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(), scope: SCOPE, seed: SEED, wrongTotal: wrong.length, sampled: total,
  stat, weightedScore: weighted / total, fieldStat: Object.fromEntries(perFieldStat),
  perFieldPool: Object.fromEntries(perField),
  sample: sample.map((s, i) => ({ ...s, verdict: byKey.get(`${s.id}/${s.field}#${i}`)?.verdict ?? 'unknown' })),
}, null, 2), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
