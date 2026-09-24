/**
 * metadata（文章级字段）到底能到多少分？——用实测数据算四种口径，而不是拍脑袋。
 *
 * 口径定义：
 *   ① 现状（严格逐字 + 编码严格）：评测当前口径。
 *   ② +语义判定：描述性字段（标题/期刊/作者/联系方式/病种/国家…）交给 LLM 判"含义是否一致"，
 *      与 study / outcome 两层已经采用的口径一致。得分来自**全部 525 组失配的实测判定**
 *      （tools/desc_field_judge.mjs --scope article，权重 完全一致/含义一致=1、包含正确信息=0.5、其余=0）。
 *   ③ +外部数据与口径修正：影响因子查外部期刊表、发表年份按语料年推导、
 *      单中心试验填 1 而不是 NR——这三项与"读懂论文"无关，是数据/约定问题。
 *   ④ +编码表对齐：离群值分析、资金、国家类别等字段的取值表与工作簿不一致（报告 §5.17），
 *      对齐后能回收多少无法先验知道，因此按 40% / 60% / 80% 三档敏感性给出区间。
 *
 * 用法：node tools/metadata_ceiling.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const NO_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check', 'title_sheet2', 'row_id', 'article_id', 'study_id']);
/** 驼峰转换要处理数字：funding_1 → funding1、impact_factor_2019 → impactFactor2019 */
const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/* ---------- ① 基线：逐字段统计 ---------- */
const per = new Map();
/**
 * ① 基线：**按当前评分口径**汇总。
 *
 * 注意评测从 2026-09 起对文章级**描述性字段**改用语义判定（与结局层一致），
 * 这类字段不再进 `byField['article.*']`，而是记在 `byField['judged.article.*']`。
 * 因此基线必须把两边合并，否则会漏掉一大块字段（也会把"描述性判定"重复算两次）。
 */
const JUDGE_W = { identical: 1, same_meaning: 1, contains_correct: 0.5, has_error: 0, completely_different: 0, unknown: 0 };
let judgedScoreSum = 0; let judgedN = 0;
for (const y of YEARS) {
  const rep = readJson(join(ROOT, 'build', 'eval', `${y}.json`));
  if (!rep) continue;
  for (const [k, s] of Object.entries(rep.byField ?? {})) {
    if (k.startsWith('judged.article.')) {
      const f = k.slice('judged.article.'.length);
      const c = per.get(f) ?? { hit: 0, wrong: 0, missed: 0 };
      /* 判定结果记成与严格统计同形状：含义一致及以上算对、包含正确信息算半分 */
      const n = s.hit + s['code-hit'] + s.wrong + s.missed;
      c.hit += s.hit + (s['code-hit'] ?? 0) * 0.5; c.wrong += s.wrong; c.missed += s.missed;
      per.set(f, c);
      judgedScoreSum += s.hit + (s['code-hit'] ?? 0) * 0.5;
      judgedN += n;
      continue;
    }
    if (!k.startsWith('article.')) continue;
    const c = per.get(k.slice('article.'.length)) ?? { hit: 0, wrong: 0, missed: 0 };
    c.hit += s.hit + (s['code-hit'] ?? 0); c.wrong += s.wrong; c.missed += s.missed;
    per.set(k.slice('article.'.length), c);
  }
}
const total = [...per.values()].reduce((a, c) => ({ hit: a.hit + c.hit, wrong: a.wrong + c.wrong, missed: a.missed + c.missed }), { hit: 0, wrong: 0, missed: 0 });
const N = total.hit + total.wrong + total.missed;
const rate = (h) => (h / N) * 100;
void judgedScoreSum; void judgedN;

/* ---------- ② 语义判定 + 零风险归一化（对全部 525 组描述性失配取"两者较大者"，避免重复计数） ---------- */
const judge = readJson(join(ROOT, 'build', 'desc-field-judge-article.json'));
const W = { identical: 1, same_meaning: 1, contains_correct: 0.5, has_error: 0, completely_different: 0, unknown: 0 };

/** 零风险归一化：去脚注序号前缀、忽略大小写/标点/空格、邮箱内部空格、国家别名。 */
const stripP = (s) => String(s ?? '').trim().replace(/^\d+\s*[:：]\s*/, '').replace(/[\u2010-\u2015]/g, '-').replace(/\.\s*$/, '');
const tight = (s) => stripP(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const mail = (s) => { const m = /[\w.+-]+\s*@[\w\s.-]+\.[A-Za-z]{2,}/.exec(String(s ?? '')); return m ? m[0].replace(/\s+/g, '').toLowerCase() : null; };
const COUNTRY = new Map(Object.entries({
  usa: 'united states', us: 'united states', 'u.s.a': 'united states', 'united states of america': 'united states',
  uk: 'united kingdom', 'u.k': 'united kingdom', england: 'united kingdom', scotland: 'united kingdom',
  prc: 'china', 'p.r. china': 'china', holland: 'netherlands', 'the netherlands': 'netherlands',
}));
const countryKey = (s) => { const t = stripP(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim(); return COUNTRY.get(t) ?? t; };
const normFixable = (field, g, p) => {
  if (!p) return false;
  if (tight(g) === tight(p)) return true;
  const mg = mail(g), mp = mail(p);
  if (mg && mp && mg === mp) return true;
  if (field === 'country' && countryKey(g) && countryKey(g) === countryKey(p)) return true;
  return false;
};

let normGain = 0;             // 全量实测（不依赖抽样）
let semResidual = 0;          // 语义判定只对"归一化仍救不回"的失配生效（避免重复计数）
const semByField = new Map();
for (const y of YEARS) {
  const gold = readJson(join(ROOT, 'build', 'gold', `${y}.json`));
  if (!gold) continue;
  for (const ga of gold.articles ?? []) {
    const pred = readJson(join(ROOT, 'build', 'extraction', y, `${ga.article_id}.json`));
    if (!pred) continue;
    for (const [k, gv] of Object.entries(ga.article ?? {})) {
      if (NO_GOLD.has(k)) continue;
      const g = String(gv?.raw ?? '').trim();
      const p = String(pred.article?.[camelKey(k)]?.raw ?? '').trim();
      if (!g || g === p) continue;
      if (normFixable(k, g, p)) normGain += 1;
    }
  }
}
for (const s of judge?.sample ?? []) {
  if (normFixable(s.field, s.gold, s.pred)) continue;      // 已被归一化救回，不再计入语义增益
  const gain = W[s.verdict] ?? 0;
  semResidual += gain;
  const c = semByField.get(s.field) ?? { n: 0, score: 0 };
  c.n++; c.score += gain; semByField.set(s.field, c);
}
const semByFieldScore = normGain + semResidual;

/* ---------- ③ 外部数据与口径修正（逐项按实测计数，不整段吞掉"该字段的全部错"） ---------- */
const w = (f) => per.get(f)?.wrong ?? 0;

/**
 * 统计"金标准是数字、机器填 NR"的条数——这类是**约定问题**（该填 1 却填了"未报告"），
 * 不能把该字段的所有错都算成可修：实测 trial_center_count 的 55 个错里只有 38 个是这种。
 */
function countNrConvention(field) {
  const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  let n = 0;
  for (const y of YEARS) {
    const gold = readJson(join(ROOT, 'build', 'gold', `${y}.json`));
    if (!gold) continue;
    for (const ga of gold.articles ?? []) {
      const pred = readJson(join(ROOT, 'build', 'extraction', y, `${ga.article_id}.json`));
      if (!pred) continue;
      const g = String(ga.article?.[field]?.raw ?? '').trim();
      const p = String(pred.article?.[camel(field)]?.raw ?? '').trim();
      if (/^\d+$/.test(g) && /^NR$/i.test(p)) n++;
    }
  }
  return n;
}

const FIX_ITEMS = [
  {
    name: '发表年份按语料年推导', gain: w('publication_year'),
    note: '差值集中在 −1 年（33 处），即机器读的是在线/收稿年；按文献编号推导即 100% 一致（报告 §5.14）',
  },
  {
    name: '单中心试验填 1（不填 NR）', gain: countNrConvention('trial_center_count'),
    note: '实测"金标准是数字、机器填 NR"38 处；其余 17 处是读错，不算在这一项里',
  },
];
const fixGain = FIX_ITEMS.reduce((a, it) => a + it.gain, 0);

/* ---------- ④ 编码表对齐（敏感性 40/60/80%） ---------- */
const CODE_FIELDS = ['outliers_influential', 'funding_1', 'funding_2', 'country_class', 'condition_system',
  'registration_reported', 'acute_or_surgery', 'journal_class'];
const codeWrong = CODE_FIELDS.reduce((a, f) => a + w(f), 0);

/* ---------- 输出 ---------- */
const rows = [
  ['① 现状（编码/数值逐字 + 描述性字段按含义判定）', total.hit],
  ['② + 发表年份口径、单中心约定', total.hit + fixGain],
  ['③ + 取值表对齐（按 40% 回收）', total.hit + fixGain + codeWrong * 0.4],
  ['③ + 取值表对齐（按 60% 回收）', total.hit + fixGain + codeWrong * 0.6],
  ['③ + 取值表对齐（按 80% 回收）', total.hit + fixGain + codeWrong * 0.8],
];
console.log(`\nmetadata（文章级 ${per.size} 个字段 × 11 年 = ${N} 个值）\n`);
console.log('口径'.padEnd(46), '得分字段   准确率');
for (const [label, h] of rows) console.log(label.padEnd(46), String(Math.round(h)).padStart(7), (rate(h).toFixed(1) + '%').padStart(9));

console.log(`\n各步增量：外部表与口径 +${fixGain}｜取值表对齐 最多 +${codeWrong}`);
for (const it of FIX_ITEMS) console.log(`  · ${it.name}：+${it.gain} —— ${it.note}`);
console.log('  · 影响因子已改为查表（docs/12-impact-factor.md），不再计入增量');
console.log('  · 描述性字段已改用语义判定，因此本表基线比旧口径高（旧口径把"同一句话不同截取窗口"判成错）');

console.log('\n逐字段现状（按失分数排序）：');
console.log('字段'.padEnd(24), '总数   对   错   漏   正确率   语义可回收');
for (const [f, c] of [...per.entries()].sort((a, b) => b[1].wrong - a[1].wrong)) {
  const n = c.hit + c.wrong + c.missed;
  const sm = semByField.get(f);
  console.log(f.padEnd(24), String(n).padStart(5), String(c.hit).padStart(5), String(c.wrong).padStart(5),
    String(c.missed).padStart(5), ((c.hit / n) * 100).toFixed(1).padStart(8) + '%',
    sm ? `${(sm.score).toFixed(0)}/${sm.n}`.padStart(11) : ''.padStart(11));
}

/* ②/③ 之外的"真读错"还剩多少（基线里已含描述性字段的语义判定） */
const rest = total.wrong - fixGain - codeWrong;

/* 供报告引用：把结论落盘，避免报告里手写数字后过期 */
const ceiling = {
  at: new Date().toISOString(),
  total: { fields: per.size, values: N, hit: total.hit, wrong: total.wrong, missed: total.missed },
  scenarios: rows.map(([label, h]) => ({ label, hits: Math.round(h), rate: Number(rate(h).toFixed(1)) })),
  gains: { normalize: normGain, semantic: Math.round(semResidual), externalAndPolicy: fixGain, codeTableMax: codeWrong },
  fixItems: FIX_ITEMS.map((it) => ({ name: it.name, gain: it.gain, note: it.note })),
  perField: Object.fromEntries([...per.entries()].map(([f, c]) => {
    const n = c.hit + c.wrong + c.missed;
    return [f, { n, hit: c.hit, wrong: c.wrong, missed: c.missed, rate: Number(((c.hit / n) * 100).toFixed(1)) }];
  })),
  residualReadErrors: Math.round(Math.max(0, rest)),
};
writeFileSync(join(ROOT, 'build', 'metadata_ceiling.json'), JSON.stringify(ceiling, null, 2), 'utf8');
console.log(`\n剩余"必须靠读懂论文解决"的错：约 ${Math.round(Math.max(0, rest))} 个字段（${(Math.max(0, rest) / N * 100).toFixed(1)}%），`
  + `主要是作者联系方式、病种归类、随机/盲法描述。`);
