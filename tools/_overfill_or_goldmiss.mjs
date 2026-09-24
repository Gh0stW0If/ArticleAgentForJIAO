/**
 * 质疑检验：**"过度填充"到底是不是编造？**
 *
 * 我此前说过"漏抽可补、编造值不可信"，把"金标准说没报告、模型却填了值"一律当成编造——
 * 这是**未经检验的推断**。真实情况至少有四种，必须逐例看：
 *
 *   ① **模型对、金标准漏填**：论文确实报告了，只是金标准那一格留了 NR
 *      → 判"过填"其实是**冤枉了模型**，而且账要记在金标准头上
 *   ② **模型抽错位置**：值来自别的时点/别的结局（材料里有，但不是这一格要的）
 *   ③ **模型把定性描述折算成了数字**（`until discharge` → 某个数）→ 这才是真编造
 *   ④ **模型凭常识补的**：quote 定位不到，或 quote 与值无关
 *
 * 判据（都能从产物直接算，不需要重跑）：
 *   · 模型给的 `evidence[].quote` 能否在 MiniDoc 里定位（grounding 已保证，但复核一遍）
 *   · 该 quote 里**是否真的出现模型填的那个数**
 *   · 金标准的 `desc` 是"纯定性"还是"其实含数字"
 *
 * 用法：node tools/_overfill_or_goldmiss.mjs [--cols max_followup,frequency]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const codeOf = (o) => (o && typeof o === 'object' && 'code' in o && o.code ? String(o.code) : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';
const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 三组 × 三列 + 各自的 desc 键 */
const GROUPS = [
  { zh: '最长随访', cols: ['max_followup_desc', 'max_followup_value', 'max_followup_unit'] },
  { zh: '治疗频次', cols: ['frequency_desc', 'frequency_value', 'frequency_unit'] },
  { zh: '留针时间', cols: ['needle_retention_desc', 'needle_retention_value', 'needle_retention_unit'] },
  { zh: '疗程', cols: ['course_desc', 'course_value', 'course_unit'] },
];

const cases = [];
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
      const p = pcs[i];
      if (!p) continue;
      for (const g of GROUPS) {
        /* 以 desc 列为锚：金标准 desc 是哨兵、模型却填了东西 → 候选"过填" */
        const gd = raw(gcs[i][g.cols[0]]); const pd = raw(p[CAMEL(g.cols[0])]);
        const gv = raw(gcs[i][g.cols[1]]); const pv = raw(p[CAMEL(g.cols[1])]);
        const gu = codeOf(gcs[i][g.cols[2]]); const pu = codeOf(p[CAMEL(g.cols[2])]);
        const goldSent = isSent(gd) && isSent(gv) && !gu;
        const predHas = !isSent(pv) || !!pu;
        if (!goldSent || !predHas) continue;
        const leaf = p[CAMEL(g.cols[1])] ?? p[CAMEL(g.cols[2])] ?? p[CAMEL(g.cols[0])];
        cases.push({
          year: y, articleId: a.article_id, cmp: i + 1, group: g.zh,
          goldDesc: gd, goldValue: gv, goldUnit: gu,
          predDesc: pd, predValue: pv, predUnit: pu,
          quote: String((leaf?.evidence ?? [])[0]?.quote ?? ''),
          provenance: String(leaf?.provenance ?? ''),
        });
      }
    }
  }
}

/* 逐例判定：quote 里有没有那个数、quote 能否定位、doc 里有没有 */
const byGroup = new Map();
for (const c of cases) byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1);

console.log(`\n══ "金标准全空、模型却填了值"的候选：${cases.length} 例 ══\n`);
for (const [g, n] of [...byGroup].sort((a, b) => b[1] - a[1])) console.log(`  ${g}：${n}`);

/* 逐例细查（需要 MiniDoc 才能判 quote 定位，按文章缓存） */
const docCache = new Map();
const getDoc = (year, id) => {
  const k = `${year}/${id}`;
  if (docCache.has(k)) return docCache.get(k);
  let doc = null;
  try { doc = ingest({ rootDir: ROOT, year, studyId: id }).doc; } catch { doc = null; }
  docCache.set(k, doc);
  return doc;
};

const verdictOf = (c) => {
  const doc = getDoc(c.year, c.articleId);
  const q = flat(c.quote);
  if (!doc) return { kind: 'doc失败', why: '' };
  const all = doc.blocks.filter((b) => !b.dropped).map((b) => String(b.text ?? '')).join('\n');
  const qLocatable = q.length >= 6 && flat(all).includes(q);
  /* 模型填的那个数：优先 value，其次 desc 里的数字 */
  const num = /^\d+(?:\.\d+)?$/.test(c.predValue) ? c.predValue : (/^(\d+(?:\.\d+)?)/.exec(c.predDesc)?.[1] ?? null);
  const numInQuote = num ? flat(c.quote).includes(num) : false;
  const numInDoc = num ? flat(all).includes(num) : false;
  if (!qLocatable) return { kind: '④ quote 定位不到', why: '疑似凭常识补的' };
  if (num && !numInQuote) return { kind: '② 值不在证据里', why: `quote 里没有 ${num}` };
  if (!num) return { kind: '③ 值非数字', why: '' };
  return { kind: numInDoc ? '① 值确实在论文里' : '④ 值不在全文', why: '' };
};

const tally = new Map();
for (const c of cases) {
  const v = verdictOf(c);
  c.kind = v.kind; c.why = v.why;
  tally.set(v.kind, (tally.get(v.kind) ?? 0) + 1);
}

console.log('\n  ── 逐例判定 ──');
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  const note = k.startsWith('①') ? '→ **很可能是金标准漏填，模型是对的**'
    : k.startsWith('②') ? '→ 抽错位置（值在材料里但不是这一格）'
      : k.startsWith('③') ? '→ 把定性描述折成了数字（偏编造）'
        : '→ **最可疑：值不在论文里**';
  console.log(`  ${String(n).padStart(4)}（${pc(n, cases.length)}）  ${k}  ${note}`);
}

console.log('\n  ── ① 类样例（模型对、金标准漏）──');
for (const c of cases.filter((x) => x.kind.startsWith('①')).slice(0, 12)) {
  console.log(`   ${c.year} ${c.articleId} 比较组${c.cmp} [${c.group}]  金标准 desc/value/unit = ${JSON.stringify(c.goldDesc)}/${JSON.stringify(c.goldValue)}/${JSON.stringify(c.goldUnit)}`);
  console.log(`      模型 desc=${JSON.stringify(c.predDesc)} value=${JSON.stringify(c.predValue)} unit=${JSON.stringify(c.predUnit)}`);
  console.log(`      证据: ${JSON.stringify(c.quote.slice(0, 110))}`);
}
console.log('\n  ── ④ 类样例（最可疑）──');
for (const c of cases.filter((x) => x.kind.startsWith('④')).slice(0, 12)) {
  console.log(`   ${c.year} ${c.articleId} 比较组${c.cmp} [${c.group}]  模型 desc=${JSON.stringify(c.predDesc)} value=${JSON.stringify(c.predValue)} unit=${JSON.stringify(c.predUnit)}  ${c.why}`);
  console.log(`      证据: ${JSON.stringify(c.quote.slice(0, 110))}`);
}
