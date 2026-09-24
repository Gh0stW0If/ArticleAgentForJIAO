/**
 * 低准确率文章的"问诊"工具：把一篇论文丢分的原因落到可核对的证据上。
 *
 * 为什么需要它
 * ------------
 * `build/eval/<year>.json` 只给出"对/错/漏/多"，看不到**为什么**。靠读几篇印象做结论
 * 很容易归错因（例如把"材料没给到模型"误判成"模型读不懂"）。本工具把每篇的
 * 抽取产物里**已经记录下来的**故障信号汇总起来，按证据分类：
 *
 *   · 结构  — studyPlan 空 / 没有比较组 / 没有对照组 → 下游必然整片漏
 *   · 材料  — NO_MATERIAL / NO_TABLES_IN_MATERIAL / NO_ANCHORED_OUTCOMES
 *   · 证据  — unresolved 里 "quote 无法定位" 的条数（模型给了原文出处但定位失败）
 *   · 数值  — NO_TIMEPOINT_DATA / OUTCOME_VALUE_EMPTY / AUDIT_NO_TIMEPOINT
 *   · 编码  — CODE_DECODE_FAILED（确定性编码映射不到）
 *   · 解析  — 该篇有几张空表（跨页续表没还原，属"原文没读全"）
 *   · 粒度  — "多填" 远多于命中（机器拆得过细 / 对齐失败）
 *
 * 用法：
 *   node tools/diagnose_low.mjs                 # 全量，按准确率升序打印前 25 篇
 *   node tools/diagnose_low.mjs --top 40
 *   node tools/diagnose_low.mjs --article 2023-19 --dump   # 单篇全部证据
 * 输出：build/low_accuracy_diagnosis.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const topN = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 25;
const onlyArticle = argv.includes('--article') ? argv[argv.indexOf('--article') + 1] : null;
const dump = argv.includes('--dump');

const YEARS = ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/* 解析健康：该篇有几张表没还原出来 */
const emptyTables = new Map();
for (const p of readJson(join(ROOT, 'build', 'parse_health.json'))?.papers ?? []) {
  emptyTables.set(`${p.year}/${p.studyId}`, p);
}

/* 金标准自身的问题条数（排除项越多，该篇的准确率越不该被拿来评判机器） */
const goldIssues = new Map();
for (const a of readJson(join(ROOT, 'build', 'gold_anomalies.json'))?.anomalies ?? []) {
  const k = `${a.year}/${a.articleId}`;
  goldIssues.set(k, (goldIssues.get(k) ?? 0) + 1);
}
const misfiledRows = new Map();
for (const f of readJson(join(ROOT, 'build', 'gold_row_anomalies.json'))?.findings ?? []) {
  const k = `${f.year}/${f.articleId}`;
  misfiledRows.set(k, (misfiledRows.get(k) ?? 0) + 1);
}

const rows = [];
for (const year of YEARS) {
  const rep = readJson(join(ROOT, 'build', 'eval', `${year}.json`));
  if (!rep) continue;
  const extrDir = join(ROOT, 'build', 'extraction', year);
  for (const a of rep.articles ?? []) {
    const g = (k, f) => a[k]?.[f] ?? 0;
    const sheets = ['article', 'comparison', 'outcome'];
    const hit = sheets.reduce((x, k) => x + g(k, 'hit') + g(k, 'code-hit'), 0);
    const wrong = sheets.reduce((x, k) => x + g(k, 'wrong'), 0);
    const missed = sheets.reduce((x, k) => x + g(k, 'missed'), 0);
    const extra = sheets.reduce((x, k) => x + g(k, 'extra'), 0);
    const n = hit + wrong + missed;

    const ex = readJson(join(extrDir, `${a.id}.json`));
    const issues = ex?.issues ?? [];
    const codes = new Map();
    for (const i of issues) codes.set(i.code, (codes.get(i.code) ?? 0) + 1);
    const c = (code) => codes.get(code) ?? 0;

    const unresBySkill = new Map();
    for (const u of ex?.unresolved ?? []) unresBySkill.set(u.skillId, (unresBySkill.get(u.skillId) ?? 0) + 1);
    const unresolvedTotal = ex?.unresolved?.length ?? 0;

    const plan = ex?.pipeline?.studyPlan ?? {};
    const planOutcomes = ex?.pipeline?.outcomePlan ?? {};
    const ph = emptyTables.get(`${year}/${a.id}`);

    rows.push({
      id: a.id, year,
      hit, wrong, missed, extra, n,
      rate: n ? (hit / n) * 100 : 0,
      /* 结构 */
      groups: (plan.groups ?? []).length,
      comparisonsPlanned: (plan.comparisons ?? []).length,
      outcomesPlanned: (planOutcomes.outcomes ?? []).length,
      comparisonsProduced: (ex?.comparisons ?? []).length,
      outcomesProduced: (ex?.outcomes ?? []).length,
      /* 材料 */
      noMaterial: c('NO_MATERIAL'),
      noTablesInMaterial: c('NO_TABLES_IN_MATERIAL'),
      noAnchoredOutcomes: c('NO_ANCHORED_OUTCOMES'),
      /* 证据定位 */
      unresolvedTotal, unresBySkill: Object.fromEntries(unresBySkill),
      /* 数值 */
      noTimepointData: c('NO_TIMEPOINT_DATA'),
      outcomeValueEmpty: c('OUTCOME_VALUE_EMPTY'),
      auditNoTimepoint: c('AUDIT_NO_TIMEPOINT'),
      auditCiIncomplete: c('AUDIT_CI_INCOMPLETE'),
      /* 编码 */
      codeDecodeFailed: c('CODE_DECODE_FAILED'),
      /* 解析 */
      tables: ph?.tables ?? null, emptyTbl: ph?.empty ?? 0,
      /* 金标准侧 */
      goldIssues: goldIssues.get(`${year}/${a.id}`) ?? 0,
      misfiledRows: misfiledRows.get(`${year}/${a.id}`) ?? 0,
      notes: a.notes ?? [],
    });
  }
}

/** 把证据翻译成"主因 + 辅因"，供人快速定位。判据都写在条件里，可核对。 */
function diagnose(r) {
  const out = [];
  if (r.groups === 0 && r.comparisonsProduced === 0) out.push('结构：研究结构没识别出来（组别/比较组为 0）');
  else if (r.comparisonsProduced === 0) out.push('结构：识别到组别但没产出比较组');
  if (r.noMaterial > 0) out.push(`材料：方法学章节没给到模型（${r.noMaterial} 处）`);
  if (r.noTablesInMaterial > 0) out.push(`材料：材料里没有表格（${r.noTablesInMaterial} 处）→ 数值只能靠正文`);
  if (r.noAnchoredOutcomes > 0) out.push('材料：没有可锚定的结局（下游无法抽结局层）');
  if (r.unresolvedTotal >= 20) out.push(`证据：模型给的出处定位失败 ${r.unresolvedTotal} 处`);
  else if (r.unresolvedTotal > 0) out.push(`证据：少量出处定位失败（${r.unresolvedTotal} 处）`);
  if (r.noTimepointData > 0 || r.outcomeValueEmpty > 0) out.push(`数值：结局没拿到时点数值（${r.noTimepointData + r.outcomeValueEmpty} 处）`);
  if (r.codeDecodeFailed >= 5) out.push(`编码：确定性编码映射失败 ${r.codeDecodeFailed} 个字段`);
  if (r.emptyTbl > 0) out.push(`解析：该篇有 ${r.emptyTbl} 张表没还原（跨页续表）`);
  if (r.extra > r.hit * 1.5 && r.extra >= 30) out.push(`粒度：多填 ${r.extra} 条（远多于命中 ${r.hit}）`);
  if (r.misfiledRows > 0) out.push(`金标准：${r.misfiledRows} 行疑似串篇（已排除计分）`);
  if (!out.length) out.push('未发现结构性故障信号——属"逐字段读错/写法不同"，需逐条看字段');
  return out;
}
for (const r of rows) r.diagnosis = diagnose(r);
rows.sort((a, b) => a.rate - b.rate);

/* ------------------------------ 语料级：失分到底来自哪一层 ------------------------------ */

/**
 * 单篇印象容易归错因，所以再算一层"总量账"：
 *  1. Sheet3 的"漏"里，有多少来自**整条金标准结局行没配上**（对齐失败），而不是行配上了却没抽到字段；
 *  2. 没配上的那些行，机器其实**有没有抽到同一个量表**（说明是"粒度/命名不一致"而非"没读到"）；
 *  3. 各类故障信号对应的平均准确率（有没有真的拉低分数）。
 * 判据与评测一致：对齐用 tools/lib/align.mjs 的 alignOutcomes（与 llm_eval 同一实现）。
 */
async function corpusStats() {
  const { alignOutcomes, numericCorroboration, normText, dice } = await import('./lib/align.mjs');
  const LEAVES = (node) => {
    let n = 0;
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o.raw === 'string') { n++; return; }
      Object.values(o).forEach(walk);
    };
    walk(node);
    return n;
  };
  const S = (v) => normText(v ?? '').trim();
  const ok = (s) => s.length > 1 && !/^(na|nr|ne|none)$/.test(s);
  const sim = (a, b) => (ok(a) && ok(b) ? dice(a, b) : 0);

  let goldRows = 0, alignedRows = 0, unalignedRows = 0, unalignedMiss = 0, totalMiss = 0;
  let multiDomain = 0, instrPresent = 0, numShared = 0, numGE2 = 0;
  for (const { year, id } of rows) {
    const gold = readJson(join(ROOT, 'build', 'gold', `${year}.json`));
    const ga = (gold?.articles ?? []).find((x) => x.article_id === id);
    const pred = readJson(join(ROOT, 'build', 'extraction', year, `${id}.json`));
    if (!ga || !pred) continue;
    const go = ga.outcomes ?? [], po = pred.outcomes ?? [];
    const { goldToPred } = alignOutcomes(go, po);
    const cnt = new Map();
    for (const r of go) cnt.set(S(r.outcome?.instrument?.raw), (cnt.get(S(r.outcome?.instrument?.raw)) ?? 0) + 1);
    goldRows += go.length;
    totalMiss += r0(id, year);
    for (const [i, row] of go.entries()) {
      if (goldToPred.has(i)) { alignedRows++; continue; }
      unalignedRows++;
      unalignedMiss += LEAVES(row) || 8;
      const ip = S(row.outcome?.instrument?.raw);
      if (ok(ip) && (cnt.get(ip) ?? 0) >= 2) multiDomain++;
      if (ok(ip) && po.some((p) => sim(ip, S(p.outcome?.instrument?.raw)) >= 0.6)) instrPresent++;
      let best = 0;
      for (const p of po) best = Math.max(best, numericCorroboration(row, p));
      if (best >= 1) numShared++;
      if (best >= 2) numGE2++;
    }
  }
  function r0(id, year) {
    const rep = readJson(join(ROOT, 'build', 'eval', `${year}.json`));
    const a = (rep?.articles ?? []).find((x) => x.id === id);
    return a?.outcome?.missed ?? 0;
  }
  return { goldRows, alignedRows, unalignedRows, unalignedMiss, totalMiss, multiDomain, instrPresent, numShared, numGE2 };
}

const cs = await corpusStats();
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
console.log('=== 语料级：Sheet3 的"漏"从哪来 ===');
console.log(`  金标准结局行 ${cs.goldRows}｜配上 ${cs.alignedRows}｜没配上 ${cs.unalignedRows}（${pc(cs.unalignedRows, cs.goldRows)}）`);
console.log(`  Sheet3 总漏 ${cs.totalMiss}｜其中来自"整行没配上" ${cs.unalignedMiss}（${pc(cs.unalignedMiss, cs.totalMiss)}）`);
console.log(`  没配上的行里：同一量表在别处也有行（多域量表）${cs.multiDomain}（${pc(cs.multiDomain, cs.unalignedRows)}）`
  + `｜机器抽到了同一量表 ${cs.instrPresent}（${pc(cs.instrPresent, cs.unalignedRows)}）`
  + `｜与某台机器行有数值重合 ${cs.numShared}（${pc(cs.numShared, cs.unalignedRows)}）`);
console.log();
function group(label, test) {
  const yes = rows.filter(test); const no = rows.filter((r) => !test(r));
  if (!yes.length) return;
  const mean = (a) => a.reduce((x, r) => x + r.rate, 0) / a.length;
  const my = yes.reduce((x, r) => x + r.missed, 0); const mn = no.reduce((x, r) => x + r.missed, 0);
  console.log(`  ${label.padEnd(34)} ${String(yes.length).padStart(3)} 篇｜平均 ${mean(yes).toFixed(1)}%｜对照 ${no.length} 篇 ${mean(no).toFixed(1)}%｜占全部漏的 ${pc(my, my + mn)}`);
}
console.log('=== 各故障信号 vs 平均准确率（对照=没有该信号的篇）===');
console.log('  读法：看"平均 vs 对照"的差距判断有没有关系；最后一列只是体量占比，**不代表因果**');
group('方法学章节没给到模型', (r) => r.noMaterial > 0);
group('材料里没有表格', (r) => r.noTablesInMaterial > 0);
group('没有可锚定的结局', (r) => r.noAnchoredOutcomes > 0);
group('没产出任何比较组', (r) => r.comparisonsProduced === 0);
group('确定性编码失败 ≥5 个字段', (r) => r.codeDecodeFailed >= 5);
group('出处定位失败 ≥10 处', (r) => r.unresolvedTotal >= 10);
group('该篇有空表（解析没还原）', (r) => r.emptyTbl > 0);
group('多填 > 命中（粒度/对齐）', (r) => r.extra > r.hit);
console.log();

if (onlyArticle) {
  const r = rows.find((x) => x.id === onlyArticle);
  if (!r) { console.error(`没有 ${onlyArticle} 的评测记录`); process.exit(2); }
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log('\n准确率最低的 %d 篇（严格口径，三张表合计）\n', Math.min(topN, rows.length));
  console.log('篇号       准确率   对/错/漏     多填   主因');
  for (const r of rows.slice(0, topN)) {
    console.log(
      r.id.padEnd(10),
      (r.rate.toFixed(1) + '%').padStart(6),
      (` ${r.hit}/${r.wrong}/${r.missed}`).padEnd(14),
      String(r.extra).padStart(6),
      '  ' + r.diagnosis[0],
    );
    for (const d of r.diagnosis.slice(1)) console.log(' '.repeat(38) + '· ' + d);
  }
  const med = rows[Math.floor(rows.length / 2)];
  console.log(`\n（中位数 ${med.rate.toFixed(1)}%，共 ${rows.length} 篇；--top N 调整篇数，--article <篇号> 单篇细看）\n`);
}

if (dump) {
  const r = rows.find((x) => x.id === onlyArticle);
  if (r) for (const nt of r.notes) console.log('   · ' + nt);
}

const outFile = join(ROOT, 'build', 'low_accuracy_diagnosis.json');
writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), articles: rows }, null, 2), 'utf8');
console.log(`  明细 ${outFile.replace(ROOT + '\\', '')}\n`);
