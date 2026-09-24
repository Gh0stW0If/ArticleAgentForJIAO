/**
 * 聚焦：`needle_retention_desc` / `course_desc` / `frequency_desc` 的失分**到底是不是形状问题**。
 *
 * 判据：把每条判定按"形状是否与金标准一致"×"判定结果"交叉。
 *   · 若失分集中在"形状不同"→ 归一化能救；
 *   · 若失分集中在"形状相同也没对"或"根本没抽到"→ 归一化救不了，得改召回。
 *
 * 用法：node tools/_desc_failure_breakdown.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const FIELDS = ['needle_retention_desc', 'course_desc', 'frequency_desc', 'max_followup_desc', 'insertion_depth_text'];
const SENT = /^(NR|NA|NE)\.?$/i;
const shapeOf = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '空';
  if (SENT.test(t)) return '哨兵值';
  if (/^\d+(?:\.\d+)?(?:[~\-–]\d+(?:\.\d+)?)?$/.test(t)) return '纯数字';
  if (/^\d+(?:\.\d+)?(?:[~\-–]\d+(?:\.\d+)?)?\s*[A-Za-z\u4e00-\u9fa5]+$/.test(t)) return '数字+单位';
  return '文字描述';
};
/** 把"数字+单位"/"纯数字"里的数抽出来，用于判断"只有写法不同、数是一样的"。 */
const numOf = (s) => {
  const m = String(s ?? '').match(/\d+(?:\.\d+)?/g);
  return m ? m.join(',') : null;
};
const unitOf = (s) => {
  const m = String(s ?? '').toLowerCase().match(/(min|minutes?|mins?|小时|hour|hrs?|天|days?|周|weeks?|wk|月|months?|年|years?|sec|秒)/);
  return m ? m[1] : null;
};

const per = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const sheet of Object.values(rep.sheets ?? {})) {
    for (const j of sheet.judged ?? []) {
      /* `sheets.*.judged[].field` 是「作用域.字段」形式（不含 `judged.` 前缀——
         那个前缀只出现在 `byField` 的键里，见 tools/sheet1_fields.mjs 的说明）。 */
      const m = /^comparison\.(.+)$/.exec(String(j.field));
      if (!m || !FIELDS.includes(m[1])) continue;
      const arr = per.get(m[1]) ?? [];
      arr.push({ id: String(j.key).split('/')[0], verdict: j.verdict, gold: String(j.gold ?? ''), pred: String(j.pred ?? '') });
      per.set(m[1], arr);
    }
  }
}

console.log('\n══ 失分是"形状"造成的，还是"没抽到/抽错"造成的？ ══\n');
for (const f of FIELDS) {
  const rows = per.get(f) ?? [];
  if (!rows.length) continue;
  const w = (rs) => rs.reduce((a, r) => a + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
  const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

  /* 分桶：A 没抽到（机器哨兵） / B 数字相同只是写法不同 / C 数字不同（可能单位没换算） / D 其它 */
  const buckets = { A没抽到: [], B数字相同写法不同: [], C数字不同: [], D无数字可比: [] };
  for (const r of rows) {
    if (SENT.test(r.pred)) { buckets.A没抽到.push(r); continue; }
    const gn = numOf(r.gold); const pn = numOf(r.pred);
    if (gn && pn && gn === pn) { buckets.B数字相同写法不同.push(r); continue; }
    if (gn && pn) { buckets.C数字不同.push(r); continue; }
    buckets.D无数字可比.push(r);
  }
  console.log(`■ ${f}  共 ${rows.length} 条，加权 ${pc(w(rows), rows.length)}`);
  for (const [k, rs] of Object.entries(buckets)) {
    if (!rs.length) continue;
    const sentGold = rs.filter((r) => SENT.test(r.gold)).length;
    console.log(`   ${k.padEnd(14)} ${String(rs.length).padStart(3)} 条（占 ${((rs.length / rows.length) * 100).toFixed(0)}%）→ 加权 ${pc(w(rs), rs.length)}`
      + `｜其中金标准本身是哨兵值的 ${sentGold}`);
  }
  /* C 桶的样例：这些才是"单位没换算"的嫌疑犯 */
  const c = buckets.C数字不同.filter((r) => !SENT.test(r.gold));
  if (c.length) {
    console.log('   ── C 桶样例（金标准有值、机器也有数、但数不同）──');
    for (const r of c.slice(0, 6)) {
      const gu = unitOf(r.gold); const pu = unitOf(r.pred);
      console.log(`     ${r.id} [${r.verdict}] 金=${JSON.stringify(r.gold.slice(0, 30))}(${gu ?? '-'})  机=${JSON.stringify(r.pred.slice(0, 30))}(${pu ?? '-'})`
        + (gu && pu && gu !== pu ? '   ← **单位不同**' : ''));
    }
  }
  console.log();
}
