/**
 * 定点核实：`comparison.max_followup_unit` 这一列，金标准与模型的**填/不填**关系。
 *
 * 现象：56 条语义判定条目里，金标准全是 `NR`/`NA`，模型却填了具体编码（1/2/4/5），
 * 于是 56 条全判错。要判断这是"模型多填"还是"金标准漏填"，只需看同一行的
 * `max_followup_desc` 与 `max_followup_value`：
 *   · desc/value 也都是 NR → 金标准说"这篇没报告"，模型多填 = **模型问题**（应收敛）；
 *   · desc/value 有值、只有 unit 是 NR → **金标准漏填**（内部不一致，应记录不计分）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';

let all = { both: 0, descOnly: 0, unitOnly: 0, sent: 0 };
const inconsistent = [];
const sentRows = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  for (const a of gold.articles ?? []) {
    for (const [i, c] of (a.comparisons ?? []).entries()) {
      const d = raw(c.max_followup_desc); const v = raw(c.max_followup_value); const u = raw(c.max_followup_unit);
      const dOk = d && !isSent(d); const uOk = u && !isSent(u);
      if (dOk && uOk) all.both++;
      else if (dOk && !uOk) { all.descOnly++; inconsistent.push({ y, id: a.article_id, cmp: i + 1, d, v, u }); }
      else if (!dOk && uOk) { all.unitOnly++; inconsistent.push({ y, id: a.article_id, cmp: i + 1, d, v, u, kind: 'unitOnly' }); }
      else { all.sent++; sentRows.push({ y, id: a.article_id, cmp: i + 1, d, v, u }); }
    }
  }
}

const total = all.both + all.descOnly + all.unitOnly + all.sent;
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
console.log(`\n══ 最长随访：desc / value / unit 三列的填与不填（${total} 个比较组）══\n`);
console.log(`  三列都有值：${all.both}（${pc(all.both, total)}）`);
console.log(`  desc 有值、**unit 是 NR/NA**：${all.descOnly}（${pc(all.descOnly, total)}）← 金标准内部不一致`);
console.log(`  unit 有值、desc 是 NR/NA：${all.unitOnly}（${pc(all.unitOnly, total)}）`);
console.log(`  三列全是 NR/NA：${all.sent}（${pc(all.sent, total)}）← 金标准说"没报告"`);

if (inconsistent.length) {
  console.log('\n  ── desc 有值但 unit 缺失（金标准内部不一致）──');
  for (const r of inconsistent.slice(0, 12)) {
    console.log(`   ${r.y} ${r.id} 比较组${r.cmp}  desc=${JSON.stringify(r.d.slice(0, 34))}  value=${JSON.stringify(r.v)}  unit=${JSON.stringify(r.u)}`);
  }
}

/* 那 56 条"金标准 NR / 模型填编码"的，落在哪一类？ */
console.log('\n  ── 与"模型填了编码却判错"的对照 ──');
const judged = [];
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const sheet of Object.values(rep.sheets ?? {})) {
    for (const j of sheet.judged ?? []) {
      if (String(j.field) !== 'comparison.max_followup_unit') continue;
      judged.push({ y, id: String(j.key).split('/')[0], verdict: j.verdict, gold: j.gold, pred: j.pred });
    }
  }
}
const goldSent = judged.filter((j) => isSent(j.gold));
console.log(`  语义判定条目 ${judged.length} 条，其中金标准是 NR/NA 的 ${goldSent.length} 条`);
const d = {};
for (const j of goldSent) d[j.verdict] = (d[j.verdict] ?? 0) + 1;
console.log(`  这些"金标准说没报告"的条目判定分布：${JSON.stringify(d)}`);
console.log('\n  样例：');
for (const j of goldSent.slice(0, 8)) console.log(`   ${j.y} ${j.id}  金标准 unit=${JSON.stringify(j.gold)}  机器 unit=${JSON.stringify(j.pred)}  [${j.verdict}]`);
