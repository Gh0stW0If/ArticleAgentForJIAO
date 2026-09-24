/**
 * 影响因子的"金标准 vs 权威表"核对 → 记入 `build/gold_anomalies.json`。
 *
 * 背景：用户明确影响因子以 `Datas/IF-SCI-2019.xlsx`（JCR 2019 SCIE）为准，
 * 而实测金标准这一列与表**大面积不一致**（期刊名能对上表的 162 篇里，
 * 只有 54 篇数值相同，49 篇不同，另有 59 篇金标准填 0/NR 而表里有值）。
 *
 * 按项目既定政策（"可能的错位金标准先不要参与评分，只记录"），
 * 这些不一致**记录为疑似金标准问题并从评分中剔除**，否则机器按表填对反被判错。
 *
 * 判定口径（保守，只在有把握时才记）：
 *   · 金标准的期刊名归一后**能在表里精确找到**（不是近似匹配）；
 *   · 且金标准的 IF 与表值不同（数值比较；金标准填 0/NR 也算不同）。
 * 记 `reason` 里带上表值，便于人工逐条核对。
 *
 * 用法：node tools/if_gold_anomalies.mjs [--dry]
 *   --dry 只打印不写文件
 */

import { readIfEntriesFromXlsx, buildIfLookup, normJournal } from './lib/if.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REASON = '影响因子与 IF-SCI-2019.xlsx 不一致（以表为准）';
const REASON_JOURNAL = '金标准期刊名不在 IF-SCI-2019.xlsx 中，影响因子无法用表核对（以论文实际期刊为准）';
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const { entries } = readIfEntriesFromXlsx(join(ROOT, 'Datas', 'IF-SCI-2019.xlsx'));
const lookup = buildIfLookup(entries);
/**
 * 匹配口径与流水线完全一致（精确 / 别名 / 唯一缩写），但**只认这两种**：
 * 近似模糊匹配可能配到别的刊，用它来改金标准太冒险，一律不用。
 */
const strictLookup = (name) => {
  const r = lookup(name);
  return r && (r.how === 'exact' || r.how === 'abbrev') ? r : null;
};

const findings = [];
const stat = { total: 0, matched: 0, same: 0, diff: 0, goldZero: 0, notFound: 0, annotated: 0 };
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const ga of gold.articles ?? []) {
    const journal = String(ga.article?.journal?.raw ?? '').trim();
    const goldIf = String(ga.article?.impact_factor_2019?.raw ?? '').trim();
    stat.total++;
    /*
     * 金标准的期刊列里夹着人工批注（实测：`Journal of Reproductive Immunology? 实际期刊: Knowledge E…`），
     * 归一化会把问号后的说明切掉、于是"看起来"能对上表里某个刊——**这种不能算金标准的错**，
     * 跳过并在统计里单列。判据：含中文、含问号。
     */
    if (/[\u4e00-\u9fff]/.test(journal) || /[?？]/.test(journal)) { stat.annotated++; continue; }
    const table = strictLookup(journal);
    if (!table) { stat.notFound++; continue; }
    stat.matched++;
    const goldIsValue = goldIf && !/^(0|NR|NA|NE)$/i.test(goldIf);
    if (goldIsValue && Math.abs(Number(table.jif) - Number(goldIf)) < 0.001) { stat.same++; continue; }
    if (!goldIsValue) stat.goldZero++; else stat.diff++;
    const how = table.how === 'exact' ? '' : `（金标准写的是缩写，按表匹配到《${table.journal}》）`;
    findings.push({
      year: y,
      articleId: ga.article_id,
      scope: 'article',
      field: 'impact_factor_2019',
      value: goldIf || 'NR',
      reason: goldIsValue
        ? `${REASON}：金标准 ${goldIf}，表值 ${table.jif}（期刊《${table.journal}》）${how}`
        : `${REASON}：金标准填「${goldIf || '空'}」，表值 ${table.jif}（期刊《${table.journal}》）${how}`,
    });
  }
}

console.log(`\n影响因子核对（${stat.total} 篇）：`);
console.log(`  期刊名在表里精确命中：${stat.matched}｜完全一致：${stat.same}`
  + `｜数值不同：${stat.diff}｜金标准填 0/NR 而表里有值：${stat.goldZero}`);
console.log(`  期刊名不在表里：${stat.notFound}｜期刊列夹人工批注（跳过，不判对错）：${stat.annotated}`);
console.log(`  → 需记录为"疑似金标准问题"：${findings.length} 条`);

/*
 * 第二类：**金标准自己的期刊名不在表里**，而流水线用的期刊名（PDF/Crossref）在表里。
 * 典型：金标准把学会名当刊名（`International Association for the Study of Pain`）、
 * 或干脆串成了别的文章的刊名（2017-15 金标准写 Nephro-Urology Monthly，论文实为 JAMA Internal Medicine）。
 * 这类金标准的 IF 无法用权威表核对，按用户口径（以表为准）记录并从评分中剔除。
 *
 * 只在**两个条件同时成立**时才记，避免把"机器自己认错刊"算到金标准头上：
 *   ① 金标准的期刊名在表里查不到；
 *   ② 流水线用的期刊名在表里查得到（精确/缩写），且与金标准期刊名不是同一个。
 */
const mismatch = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const ga of gold.articles ?? []) {
    const goldJournal = String(ga.article?.journal?.raw ?? '').trim();
    const goldIf = String(ga.article?.impact_factor_2019?.raw ?? '').trim();
    if (/[\u4e00-\u9fff]/.test(goldJournal) || /[?？]/.test(goldJournal)) continue;   // 人工批注，跳过
    if (strictLookup(goldJournal)) continue;                                          // 表里能查到 → 已在上文处理
    const pf = join(ROOT, 'build', 'extraction', y, `${ga.article_id}.json`);
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    const ourJournal = String(pred.article?.journal?.raw ?? '').trim();
    const ourHit = strictLookup(ourJournal);
    if (!ourHit) continue;
    if (normJournal(ourJournal) === normJournal(goldJournal)) continue;
    mismatch.push({
      year: y,
      articleId: ga.article_id,
      scope: 'article',
      field: 'impact_factor_2019',
      value: goldIf || 'NR',
      reason: `${REASON_JOURNAL}：金标准期刊《${goldJournal}》不在表里；论文实际期刊《${ourHit.journal}》表值 ${ourHit.jif}`,
    });
  }
}
console.log(`  → 另有"金标准期刊名不在表里"的：${mismatch.length} 条（同样记录、不参与评分）`);
for (const m of mismatch.slice(0, 6)) console.log(`    ${m.articleId} ${m.reason.split('：').slice(1).join('：')}`);
findings.push(...mismatch);
for (const f of findings.slice(0, 8)) console.log(`    ${f.articleId} ${f.reason.split('：').slice(1).join('：')}`);

if (process.argv.includes('--dry')) {
  console.log('\n（--dry：未写入）');
  process.exit(0);
}

const file = join(ROOT, 'build', 'gold_anomalies.json');
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { at: null, years: [], total: 0, byReason: {}, anomalies: [] };
/* 合并语义：只替换本工具产生的两类 reason（与其他工具互不覆盖） */
const kept = (prev.anomalies ?? []).filter((a) => {
  const r = String(a.reason ?? '');
  return !r.startsWith(REASON) && !r.startsWith(REASON_JOURNAL);
});
const merged = [...kept, ...findings];
const byReason = {};
for (const a of merged) byReason[a.reason] = (byReason[a.reason] ?? 0) + 1;
writeFileSync(file, JSON.stringify({ ...prev, at: new Date().toISOString(), total: merged.length, byReason, anomalies: merged }, null, 2), 'utf8');
console.log(`\n已合并进 build/gold_anomalies.json（总 ${merged.length} 条）\n`);
