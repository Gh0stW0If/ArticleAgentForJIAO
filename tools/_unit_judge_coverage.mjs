/**
 * 评测侧改动定标：**单位归一化判定**能把多少条目从 LLM 语义判定转成确定性判定？
 *
 * 这是"统一单位格式便于后期转换对比"的直接收益——不体现在分数上，体现在
 * ① 少调 LLM（省钱）；② 判定可复现（去掉 LLM 判定噪声）。
 *
 * 判据与 `tools/llm_eval.mjs` 的 `unitDecided()` 一致：
 *   · 两边换算后同量（`3 months` vs `12 weeks`）→ identical
 *   · 两边数字相同、只是单位写法不同（`30` vs `30 min`）→ same_meaning
 *
 * 用法：node tools/_unit_judge_coverage.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantityEqual } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const FIELDS = ['needle_retention_desc', 'course_desc', 'frequency_desc', 'max_followup_desc', 'insertion_depth_text'];
const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;

const stat = { candidate: 0, decided: 0, identical: 0, sameMeaning: 0, stillJudge: 0 };
const rows = [];

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
    const gcs = a.comparisons ?? []; const pcs = pred.comparisons ?? [];
    for (let i = 0; i < gcs.length; i++) {
      if (!pcs[i]) continue;
      for (const f of FIELDS) {
        const g = raw(gcs[i][f]); const p = raw(pcs[i][CAMEL(f)]);
        if (!g || !p) continue;
        if (SENT.test(g) || SENT.test(p)) continue;          // 哨兵值走严格比对
        stat.candidate++;
        let verdict = null;
        if (quantityEqual(g, p)) verdict = 'identical';
        else {
          const na = /^\s*(\d+(?:\.\d+)?)/.exec(g)?.[1];
          const nb = /^\s*(\d+(?:\.\d+)?)/.exec(p)?.[1];
          if (na && nb && na === nb) verdict = 'same_meaning';
        }
        if (verdict) {
          stat.decided++;
          if (verdict === 'identical') stat.identical++; else stat.sameMeaning++;
          if (rows.length < 25) rows.push({ id: a.article_id, f, gold: g, pred: p, verdict });
        } else stat.stillJudge++;
      }
    }
  }
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log('\n══ 单位归一化判定：能接管多少条目 ══\n');
console.log(`  可比较的条目（两边都非哨兵）：${stat.candidate}`);
console.log(`  **确定性判定的：${stat.decided}（${pc(stat.decided, stat.candidate)}）**`);
console.log(`    ├ 换算后同量（identical）    ：${stat.identical}`);
console.log(`    └ 数字相同、单位写法不同     ：${stat.sameMeaning}`);
console.log(`  仍需要 LLM 语义判定的：${stat.stillJudge}（${pc(stat.stillJudge, stat.candidate)}）`);

console.log('\n  ── 样例（这些原本都要送 LLM）──');
for (const r of rows) {
  console.log(`   ${r.id} ${r.f}  [${r.verdict}]  金=${JSON.stringify(r.gold.slice(0, 26))}  机=${JSON.stringify(r.pred.slice(0, 26))}`);
}
