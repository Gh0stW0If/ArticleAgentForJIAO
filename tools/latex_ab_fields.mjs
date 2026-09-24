/**
 * **定向 A/B**：只看"修复前材料里数字被切碎"的那些金标准字段，新旧抽取各答了什么？
 *
 * 为什么要做定向而不是全量对比：全量对比的检验力被无关字段稀释。
 * 2015 年只有 40/1399 个计分字段受影响（效果上限 2.9%），
 * 全量 A/B 的读数是 −0.52 点，**落在噪声里，什么都说明不了**。
 * 这里换成"只统计受影响字段"的口径：样本小但**每一个都可能翻转**，检验力最高。
 *
 * 用法：
 *   node tools/latex_ab_fields.mjs --old build/_backup_prelatex/extraction-2015 --new build/extraction/2015 --year 2015
 *   node tools/latex_ab_fields.mjs --pairs build/_ab_pairs.json      # [{"year","id","oldDir","newDir"}]
 * 输出：build/latex_ab_fields.json
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deLatex, parseTableHtml } from '../packages/core/dist/index.js';
import { materialTexts, wasBroken } from './lib/latex_broken.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

/* ---------- 数字工具（与 llm_eval 一致的严格口径） ---------- */
const normNum = (s) => {
  const m = String(s ?? '').replace(/[−–—]/g, '-').replace(/[^\d.\-]/g, '');
  if (!m || !/\d/.test(m)) return null;
  const n = Number(m);
  return Number.isFinite(n) ? String(n) : null;
};
/** 数值等价：按较短小数位四舍五入后比较（`4.0` == `4`，`0.80` == `0.8`）。 */
const decimalsOf = (s) => { const i = String(s).indexOf('.'); return i < 0 ? 0 : String(s).length - i - 1; };
const numericEqual = (a, b) => {
  const x = normNum(a); const y = normNum(b);
  if (x === null || y === null) return false;
  const d = Math.min(decimalsOf(x), decimalsOf(y));
  return Number(x).toFixed(d) === Number(y).toFixed(d);
};
const numsOf = (text) => { const o = []; const re = /[-−–—]?\d+(?:[.,]\d+)?/g; let m;
  while ((m = re.exec(String(text ?? ''))) !== null) { const v = normNum(m[0]); if (v !== null) o.push(v); } return o; };
const multiset = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) ?? 0) + 1); return m; };
const minus = (a, b) => { const o = []; for (const [k, n] of a) { const d = n - (b.get(k) ?? 0); for (let i = 0; i < d; i++) o.push(k); } return o; };

/* ---------- 受影响的金标准叶子 ---------- */
const CODEISH = /(_code|_class|^arm_number$|^row_id$|^literature_code$|^literature_no$|^extractor$)/;
function goldLeaves(gold, id) {
  const out = [];
  const ga = (gold.articles ?? []).find((a) => a.article_id === id);
  if (!ga) return out;
  const push = (scope, kind, field, leaf) => {
    if (!leaf || typeof leaf !== 'object' || !('raw' in leaf)) return;
    const raw = leaf.raw;
    if (raw === null || raw === undefined || raw === '' || !/\d/.test(String(raw))) return;
    if (CODEISH.test(field)) return;
    const v = normNum(raw);
    if (v === null) return;
    out.push({ scope, kind, field, raw: String(raw), value: v });
  };
  const walk = (scope, kind, obj) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      if ('raw' in v) push(scope, kind, k, v);
      else walk(scope, kind, k, v);
    }
  };
  walk('article', '', ga.study);
  const cmp = ga.comparisons ?? [];
  for (let i = 0; i < cmp.length; i++) walk('comparison', String(i), cmp[i]);
  for (const o of ga.outcomes ?? []) {
    walk('outcome', '', o.outcome);
    walk('followUp', '', o.follow_up);
    for (const [tp, kinds] of Object.entries(o.timepoints ?? {})) {
      for (const [kind, fields] of Object.entries(kinds ?? {})) {
        if (fields && typeof fields === 'object') walk(tp, kind, fields);
      }
    }
  }
  return out;
}

/** 修复前材料里"被切碎"的数字判定：见 tools/lib/latex_broken.mjs 的说明。 */
function brokenJudge(year, id) {
  const texts = materialTexts(ROOT, year, id);
  return (v) => wasBroken(texts, v);
}

/* ---------- 在预测 JSON 里按 (scope, kind, field) 取值 ---------- */
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
function lookup(pred, scope, kind, field) {
  const get = (obj, key) => {
    if (!obj) return undefined;
    if (key in obj) return obj[key];
    const c = camel(key);
    return c in obj ? obj[c] : undefined;
  };
  if (scope === 'article') return get(pred.article, field)?.raw;
  if (scope === 'comparison') {
    const cs = pred.comparisons ?? [];
    /* kind 是金标准里的比较组下标；预测侧顺序基本一致，取同下标，越界则跳过 */
    const c = cs[Number(kind)] ?? (cs.length === 1 ? cs[0] : undefined);
    return get(c, field)?.raw;
  }
  if (scope === 'outcome') {
    for (const o of pred.outcomes ?? []) { const v = get(o.outcome, field)?.raw; if (v !== undefined) return v; }
    return undefined;
  }
  if (scope === 'followUp') {
    for (const o of pred.outcomes ?? []) { const v = get(o.followUp, field)?.raw; if (v !== undefined) return v; }
    return undefined;
  }
  /* 时点块：scope 是 baseline / end_of_treatment / follow_up_end */
  const tpKey = camel(scope);
  for (const o of pred.outcomes ?? []) {
    const tp = o.timepoints?.[tpKey] ?? o.timepoints?.[scope];
    if (!tp) continue;
    const blk = tp[kind] ?? tp[camel(kind)];
    const v = get(blk, field)?.raw;
    if (v !== undefined) return v;
  }
  return undefined;
}

/* ---------- 主流程 ---------- */
const pairs = argv.includes('--pairs')
  ? JSON.parse(readFileSync(resolve(ROOT, arg('pairs')), 'utf8'))
  : (() => {
    const year = arg('year', '2015');
    const oldDir = arg('old', null);
    const newDir = arg('new', null);
    if (!oldDir || !newDir) {
      console.error('用法：--year <年> --old <旧抽取目录> --new <新抽取目录>，或 --pairs <json>');
      process.exit(2);
    }
    /* 没给 pairs 就按新目录里的产物枚举（排除 _run.json 这类下划线开头的汇总文件） */
    return readdirSync(resolve(ROOT, newDir))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => ({ year, id: f.replace(/\.json$/, ''), oldDir, newDir }));
  })();

const stat = { affected: 0, oldRight: 0, newRight: 0, fixed: 0, broke: 0, bothWrong: 0, oldNR: 0, newNR: 0 };
const rows = [];

for (const p of pairs) {
  const gf = join(ROOT, 'build', 'gold', `${p.year}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  const oldPredFile = join(ROOT, p.oldDir, `${p.id}.json`);
  const newPredFile = join(ROOT, p.newDir, `${p.id}.json`);
  if (!existsSync(oldPredFile) || !existsSync(newPredFile)) {
    console.error(`  ⚠ 缺预测文件：${p.id}`);
    continue;
  }
  const oldPred = JSON.parse(readFileSync(oldPredFile, 'utf8'));
  const newPred = JSON.parse(readFileSync(newPredFile, 'utf8'));
  const isBroken = brokenJudge(p.year, p.id);

  for (const leaf of goldLeaves(gold, p.id)) {
    if (!isBroken(leaf.value)) continue;
    stat.affected++;
    const o = lookup(oldPred, leaf.scope, leaf.kind, leaf.field);
    const n = lookup(newPred, leaf.scope, leaf.kind, leaf.field);
    const okOld = o !== undefined && numericEqual(o, leaf.raw);
    const okNew = n !== undefined && numericEqual(n, leaf.raw);
    if (okOld) stat.oldRight++;
    if (okNew) stat.newRight++;
    if (!okOld && okNew) stat.fixed++;
    if (okOld && !okNew) stat.broke++;
    if (!okOld && !okNew) stat.bothWrong++;
    if (o === undefined || /^(NR|NE|NA)?$/i.test(String(o).trim())) stat.oldNR++;
    if (n === undefined || /^(NR|NE|NA)?$/i.test(String(n).trim())) stat.newNR++;
    rows.push({ year: p.year, articleId: p.id, scope: leaf.scope, kind: leaf.kind, field: leaf.field,
      gold: leaf.raw, old: o ?? '（缺）', new: n ?? '（缺）', okOld, okNew });
  }
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ 定向 A/B：只看"修复前材料里数字被切碎"的金标准字段 ══\n`);
console.log(`  受影响字段样本：${stat.affected}`);
console.log(`  旧（破碎材料）答对：${stat.oldRight}（${pc(stat.oldRight, stat.affected)}）`);
console.log(`  新（清洗材料）答对：${stat.newRight}（${pc(stat.newRight, stat.affected)}）`);
console.log(`  ⇒ 修好 ${stat.fixed} 个 / 弄坏 ${stat.broke} 个 / 两版都错 ${stat.bothWrong} 个`);
console.log(`  答 NR 或缺字段：旧 ${stat.oldNR} → 新 ${stat.newNR}`);

const fixed = rows.filter((r) => !r.okOld && r.okNew);
if (fixed.length) {
  console.log('\n  修好的样例（前 20）：');
  for (const r of fixed.slice(0, 20)) console.log(`   ${r.articleId} ${r.scope}.${r.field}｜金标准 ${r.gold}｜旧 ${r.old} → 新 ${r.new}`);
}
const broke = rows.filter((r) => r.okOld && !r.okNew);
if (broke.length) {
  console.log('\n  ⚠ 弄坏的（前 20）：');
  for (const r of broke.slice(0, 20)) console.log(`   ${r.articleId} ${r.scope}.${r.field}｜金标准 ${r.gold}｜旧 ${r.old} → 新 ${r.new}`);
}

const out = join(ROOT, 'build', 'latex_ab_fields.json');
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stat, rows }, null, 1), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
