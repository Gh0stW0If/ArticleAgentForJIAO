/**
 * Sheet1 失分构成：按字段拆开看"低分到底低在哪"。
 *
 * Sheet1 = 文章级（article）+ 比较组级（comparison）。本脚本给出：
 *   ① 两层的分项准确率；
 *   ② 逐字段的错/漏与**占 Sheet1 全部失分的比例**（只看错/漏，不含"多填"）；
 *   ③ 把字段归成三类：编码类（有取值表）、描述类（自由文本）、数值类 —— 便于判断"该改哪一头"。
 *
 * ⚠️ **描述性字段在评测报告里带 `judged.` 前缀**。
 * `tools/llm_eval.mjs` 的 `fieldStat('judged', ...)` 会把走语义判定的字段记成
 * `judged.<scope>.<field>`（如 `judged.comparison.frequency_desc`），
 * 因为同一个字段可能"这篇走语义判定、那篇走严格比对"。
 * 早期版本只认 `/^(article|comparison)\./`，**把这些字段整批漏掉了**，
 * 于是"描述类"只剩少数没被判定的字段，读数严重失真（实测漏掉 49 个键/年）。
 * 现在两个前缀都收，并合并同一字段的两路统计。
 *
 * 用法：
 *   node tools/sheet1_fields.mjs [--top 20] [--kind 描述类] [--maxn 200]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFieldLabels } from './lib/field_labels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const TOP = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 20;
const ONLY_KIND = argv.includes('--kind') ? argv[argv.indexOf('--kind') + 1] : null;
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const LABELS = createFieldLabels(ROOT);

/**
 * 判定每个字段是"编码类 / 数值类 / 描述类"。
 *
 * ⚠️ 不能用"有没有被判过语义"当描述类的判据：`shouldJudge()` 在**任一侧不是数值/编码**时就触发，
 * 所以 `analyzed_n_experimental`（金标准 `88`）在机器答 `NR` 时也会走语义判定，
 * 于是数值字段会被错判成描述类（实测把 8 个数值字段混进了"描述类最低 16 名"）。
 *
 * 正确做法是**从金标准数据本身**看：该字段的非空取值里，数值写法占多少比例。
 */
const mapMod = await import('./canonical-field-map.mjs');
const CODE_KEYS = new Set();
for (const f of [...mapMod.ARTICLE_FIELDS, ...mapMod.COMPARISON_FIELDS]) {
  if (f.codes && Object.keys(f.codes).length) CODE_KEYS.add(`${f.key.startsWith('outcome') ? 'article' : ''}${f.key}`);
}
const hasCodes = (scope, field) => {
  const camel = field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return CODE_KEYS.has(camel) || CODE_KEYS.has(field);
};

/** 扫一遍金标准，统计每个字段的"数值写法占比"。 */
const kindStat = new Map();     // `article.x` / `comparison.y` → { total, numeric }
const NUM_RE = /^[-+]?\d+(?:[.,]\d+)?$/;
const bump = (scope, field, raw) => {
  const v = String(raw ?? '').trim();
  if (!v || /^(NR|NA|NE)$/i.test(v)) return;
  const k = `${scope}.${field}`;
  const c = kindStat.get(k) ?? { total: 0, numeric: 0 };
  c.total++;
  if (NUM_RE.test(v)) c.numeric++;
  kindStat.set(k, c);
};
const walkLeaf = (scope, obj) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    if ('raw' in v) bump(scope, k, v.raw);
    else walkLeaf(scope, k, v);
  }
};
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) continue;
  const gold = JSON.parse(readFileSync(f, 'utf8'));
  for (const ga of gold.articles ?? []) {
    /* ⚠️ 文章级字段分在两处：metadata 在 `a.article`、结局分类在 `a.study`——
       只扫 `a.study` 会让 `publication_year` / `impact_factor_2019` 落回名字启发式并被错判成描述类。 */
    walkLeaf('article', ga.article);
    walkLeaf('article', ga.study);
    for (const c of ga.comparisons ?? []) walkLeaf('comparison', c);
  }
}

const kindOf = (scope, field) => {
  if (hasCodes(scope, field)) return '编码类';
  const st = kindStat.get(`${scope}.${field}`);
  if (st && st.total >= 3 && st.numeric / st.total >= 0.9) return '数值类';
  /* 数据不足时退回名字启发式 */
  if (/(_value|_min|_max|_total|_count|_n$|^n$|_ratio|_years|_size|_number|_n_)/.test(field)) return '数值类';
  return '描述类';
};

const per = new Map();
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const rep = JSON.parse(readFileSync(f, 'utf8'));
  for (const [rawKey, s] of Object.entries(rep.byField ?? {})) {
    /* 两种键都要收：`judged.<scope>.<field>` 与 `<scope>.<field>` */
    const key = rawKey.replace(/^judged\./, '');
    if (!/^(article|comparison)\./.test(key)) continue;
    const c = per.get(key) ?? { hit: 0, half: 0, wrong: 0, missed: 0, extra: 0, judged: 0, strict: 0 };
    const n = s.hit + (s['code-hit'] ?? 0) + s.wrong + s.missed;
    c.hit += s.hit;
    /* `code-hit` 桶 = 语义判定的"包含正确信息"，权重 0.5，不能并进 hit */
    c.half += s['code-hit'] ?? 0;
    c.wrong += s.wrong; c.missed += s.missed; c.extra += s.extra ?? 0;
    if (rawKey.startsWith('judged.')) c.judged += n; else c.strict += n;
    per.set(key, c);
  }
}

const rows = [...per.entries()].map(([k, c]) => {
  const [scope, ...rest] = k.split('.');
  const field = rest.join('.');
  const n = c.hit + c.wrong + c.missed;
  const kind = kindOf(scope, field);
  /*
   * ⚠️ 加权口径必须与 `tools/llm_eval.mjs` 的 `sheet()` 一致：
   *   identical / same_meaning = 1，**contains_correct = 0.5**（judge.mjs 的 VERDICT_WEIGHT）。
   *   把半分当满分算会系统性高估——实测 author_contact 会从 41.5% 被抬到 46.4%。
   */
  const score = c.hit + 0.5 * c.half;
  return { k, scope, field, ...c, n, kind, score, rate: n ? (score / n) * 100 : 0, loss: c.wrong + c.missed };
}).sort((a, b) => b.loss - a.loss);

const sum = (list, key) => list.reduce((a, r) => a + r[key], 0);
const all = rows;
const denom = (list) => sum(list, 'hit') + sum(list, 'half') + sum(list, 'wrong') + sum(list, 'missed');
const total = denom(all);
const totalLoss = sum(all, 'wrong') + sum(all, 'missed');
/** 带半分的得分串，便于人工核对（`对+半` 都列出来，不合并成一个小数）。 */
const scoreStr = (list) => `${sum(list, 'hit')}+${sum(list, 'half')}`;

if (!ONLY_KIND) {
  console.log(`Sheet1 合计：${total} 个字段｜满分 ${sum(all, 'hit')}｜半分 ${sum(all, 'half')}｜错 ${sum(all, 'wrong')}｜漏 ${sum(all, 'missed')}`
    + `（多填 ${sum(all, 'extra')}）→ ${((sum(all, 'score') / total) * 100).toFixed(1)}%`);
  console.log(`  （其中走语义判定的描述性字段 ${sum(all, 'judged')} 个，严格逐字比对 ${sum(all, 'strict')} 个；半分 = 语义判定"包含正确信息"，权重 0.5）`);
  for (const scope of ['article', 'comparison']) {
    const list = all.filter((r) => r.scope === scope);
    const n = denom(list);
    console.log(`  ${scope === 'article' ? '文章级' : '比较组级'}：${n} 个字段（占 ${((n / total) * 100).toFixed(0)}%）`
      + `｜对+半 ${scoreStr(list)}｜错 ${sum(list, 'wrong')}｜漏 ${sum(list, 'missed')} → ${((sum(list, 'score') / n) * 100).toFixed(1)}%`
      + `｜占总失分 ${(((sum(list, 'wrong') + sum(list, 'missed')) / totalLoss) * 100).toFixed(0)}%`);
  }
  console.log('\n按类别：');
  for (const kind of ['编码类', '描述类', '数值类']) {
    const list = all.filter((r) => r.kind === kind);
    const n = denom(list);
    if (!n) continue;
    console.log(`  ${kind}：${n} 个字段（占 ${((n / total) * 100).toFixed(0)}%）→ ${((sum(list, 'score') / n) * 100).toFixed(1)}%`
      + `｜错 ${sum(list, 'wrong')} + 漏 ${sum(list, 'missed')} = 占总失分 ${(((sum(list, 'wrong') + sum(list, 'missed')) / totalLoss) * 100).toFixed(0)}%`);
  }
}

const shown = (ONLY_KIND ? all.filter((r) => r.kind === ONLY_KIND) : all)
  .slice()
  .sort(ONLY_KIND ? (a, b) => a.rate - b.rate : (a, b) => b.loss - a.loss)
  .slice(0, TOP);

console.log(`\n${ONLY_KIND ? `${ONLY_KIND}准确率最低的` : '失分最多的'} ${shown.length} 个字段`
  + `${ONLY_KIND ? '' : '（错+漏，附占 Sheet1 全部失分的比例）'}：`);
console.log('原始表格列名'.padEnd(40), '类别   满分/半/错/漏         占失分   正确率');
for (const r of shown) {
  const name = LABELS.describe(r.k).names.join(' / ').slice(0, 38);
  console.log(name.padEnd(40), r.kind.padEnd(5),
    `${r.hit}/${r.half}/${r.wrong}/${r.missed}`.padEnd(20),
    `${((r.loss / totalLoss) * 100).toFixed(1)}%`.padStart(6),
    `${r.rate.toFixed(1)}%`.padStart(8),
    ' ', r.k);
}
if (!ONLY_KIND) {
  const topLoss = rows.slice(0, 10).reduce((a, r) => a + r.loss, 0);
  const top20 = rows.slice(0, 20).reduce((a, r) => a + r.loss, 0);
  console.log(`\n前 10 个字段占总失分 ${((topLoss / totalLoss) * 100).toFixed(0)}%，前 20 个占 ${((top20 / totalLoss) * 100).toFixed(0)}%`);
}
