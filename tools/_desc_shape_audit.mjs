/**
 * 定标：带单位的 comparison 字段，**金标准要什么形状** × **模型现在写什么**。
 *
 * 三个问题：
 *   ① 金标准的 `_desc` 到底是"原文"还是"归一化后的数"？
 *      （实测 `needle_retention_desc` 存的是 `20`/`30` 这种纯数字，而 `course_desc` 存的是 `9 weeks`）
 *   ② 模型的写法与金标准差在哪：单位没换算？还是干脆没抽到？
 *   ③ 若把"值归一化 + 单位规范"写进提示词，**上限**能提升多少分？
 *
 * 用法：node tools/_desc_shape_audit.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const FIELDS = [
  { key: 'needle_retention_desc', zh: '留针时间', canonical: '分钟（code 1）' },
  { key: 'course_desc', zh: '疗程', canonical: '周（code 2）/ 天（code 1）' },
  { key: 'frequency_desc', zh: '治疗频次', canonical: '次/周（code 2）/ 次/天（code 1）' },
  { key: 'max_followup_desc', zh: '最长随访时间', canonical: '天/月/年/周/小时（code 1~5）' },
  { key: 'insertion_depth_text', zh: '进针深度', canonical: '毫米' },
  { key: 'intervention', zh: '干预方法名称', canonical: '（非单位字段，作对照）' },
];

/** desc 的形状分类。 */
const shapeOf = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '空';
  if (/^(NR|NA|NE)\.?$/i.test(t)) return '哨兵值';
  const bare = /^\d+(?:\.\d+)?(?:[~\-–]\d+(?:\.\d+)?)?$/;
  if (bare.test(t)) return '纯数字';
  if (/^\d+(?:\.\d+)?(?:[~\-–]\d+(?:\.\d+)?)?\s*[A-Za-z\u4e00-\u9fa5]+$/.test(t)) return '数字+单位';
  return '文字描述';
};

/** 从评测报告里取该字段的判定与取值（含语义判定条目）。 */
function collectVerdicts() {
  const per = new Map();      // field → [{id, verdict, gold, pred}]
  for (const y of YEARS) {
    const f = join(ROOT, 'build', 'eval', `${y}.json`);
    if (!existsSync(f)) continue;
    const rep = JSON.parse(readFileSync(f, 'utf8'));
    for (const sheet of Object.values(rep.sheets ?? {})) {
      for (const j of sheet.judged ?? []) {
        const field = String(j.field).replace(/^judged\./, '');
        const m = /^(?:comparison|judged\.comparison)\.(.+)$/.exec(String(j.field));
        const key = m ? m[1] : field;
        if (!FIELDS.some((x) => x.key === key)) continue;
        const arr = per.get(key) ?? [];
        arr.push({ id: String(j.key).split('/')[0], verdict: j.verdict, gold: j.gold, pred: j.pred });
        per.set(key, arr);
      }
    }
  }
  return per;
}

/* ---------- ① 金标准形状 ---------- */
console.log('\n══ ① 金标准 `_desc` 的形状分布 ══\n');
const goldShapes = new Map();
for (const fdef of FIELDS) {
  const dist = new Map();
  const samples = new Map();
  for (const y of YEARS) {
    const f = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(f)) continue;
    const gold = JSON.parse(readFileSync(f, 'utf8'));
    for (const a of gold.articles ?? []) {
      for (const c of a.comparisons ?? []) {
        const v = c[fdef.key]?.raw;
        if (v === undefined || v === null || v === '') continue;
        const sh = shapeOf(v);
        dist.set(sh, (dist.get(sh) ?? 0) + 1);
        if (!samples.has(sh)) samples.set(sh, []);
        if (samples.get(sh).length < 3 && !samples.get(sh).includes(String(v).slice(0, 46))) samples.get(sh).push(String(v).slice(0, 46));
      }
    }
  }
  goldShapes.set(fdef.key, dist);
  const total = [...dist.values()].reduce((a, b) => a + b, 0);
  console.log(`■ ${fdef.key}（${fdef.zh}，规范单位：${fdef.canonical}）共 ${total} 条`);
  for (const [sh, n] of [...dist].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${sh.padEnd(6)} ${String(n).padStart(3)}（${((n / total) * 100).toFixed(0)}%）  例：${(samples.get(sh) ?? []).join(' | ')}`);
  }
}

/* ---------- ② 模型的写法 vs 金标准 ---------- */
console.log('\n══ ② 模型当前的写法与判定 ══\n');
const verdicts = collectVerdicts();
for (const fdef of FIELDS) {
  const rows = verdicts.get(fdef.key) ?? [];
  if (!rows.length) continue;
  const w = rows.reduce((a, r) => a + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
  console.log(`■ ${fdef.key}  判定条目 ${rows.length}，加权 ${((w / rows.length) * 100).toFixed(1)}%`);
  /* 模型写法与金标准形状不同的条目 */
  const mismatchShape = rows.filter((r) => shapeOf(r.pred) !== shapeOf(r.gold));
  console.log(`   形状与金标准不同的：${mismatchShape.length}（${((mismatchShape.length / rows.length) * 100).toFixed(0)}%）`);
  for (const r of mismatchShape.slice(0, 5)) {
    console.log(`     ${r.id} [${r.verdict}] 金标准(${shapeOf(r.gold)})=${JSON.stringify(String(r.gold).slice(0, 26))}  机器(${shapeOf(r.pred)})=${JSON.stringify(String(r.pred).slice(0, 26))}`);
  }
}
