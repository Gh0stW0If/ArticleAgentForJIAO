/**
 * 金标准**结局行级**错位检测：这一行到底属不属于这篇文章？
 *
 * 动机（实测，2015-06）：金标准 Sheet3 里 2015-06 名下有两行「2.maximum anxiety / VAS」，
 * 但整篇 2015-06 的 MinerU 产物里 `anxiety` 与 `VAS` **一次都没出现**；
 * 而 2015-05 那篇里 `maximum anxiety` 出现 8 次。金标准自己的 `literature_code` 也印证了：
 * 那两行是 `EN016-112`/`EN016-122`（EN016 = 2015-05），而 2015-06 自己的行是 `EN091-11/-12`。
 * 即：2015-05 的 4 行（疼痛/焦虑 × 2 个比较组）被拆到了两个文章块里。
 *
 * 影响很大：错位的行在评测里算「整行没抽到」，每行 30+ 个叶子全部计漏
 * （2015-06 的 74 个漏里有 70 个来自这两行），同时它们在真正的文章里又被算成「多」。
 *
 * 判据（与论文原文对齐，不依赖 literature_code 的编码规则）：
 *   结局名里**所有有辨识度的词**在该文章的正文/表格/图注里都找不到 → 该行疑似串篇。
 * 只做记录与评测排除，**不修改 Datas/**。
 *
 * 用法：node tools/gold_row_anomalies.mjs [--year 2015]
 * 产物：build/gold_row_anomalies.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, findMiddleFile } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const YEARS = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--year') YEARS.push(argv[++i]);
if (!YEARS.length) {
  // 默认扫 build/gold 下所有年份
  for (const f of readdirSync(join(ROOT, 'build', 'gold'))) {
    if (/^\d{4}\.json$/.test(f)) YEARS.push(f.replace('.json', ''));
  }
}

/**
 * 通用词：出现在几乎所有论文里，不能作为"这一行属不属于本篇"的证据。
 * 只保留有辨识度的实词（如 anxiety / fatigue / pain / bladder）。
 */
const GENERIC = new Set([
  'patients', 'patient', 'number', 'score', 'scores', 'level', 'levels', 'outcome', 'outcomes',
  'induced', 'after', 'before', 'during', 'with', 'without', 'treatment', 'group', 'groups',
  'total', 'clinical', 'state', 'change', 'changes', 'rate', 'rates', 'mean', 'median',
  'assess', 'assessed', 'assessment', 'measure', 'measured', 'measurement', 'index', 'scale',
  'questionnaire', 'test', 'time', 'times', 'week', 'weeks', 'month', 'months', 'day', 'days',
  'first', 'second', 'third', 'fourth', 'maximum', 'minimum', 'average', 'baseline',
  'trial', 'study', 'randomized', 'randomised', 'controlled', 'effect', 'effects',
]);

/** 归一化：小写、去连字符与标点（保留字母数字）。 */
const normText = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[\u2010-\u2015-]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 取结局名里有辨识度的词（≥4 字符、非通用词、去掉行首编号 "1." "2."）。 */
function distinctiveTokens(name) {
  const cleaned = String(name ?? '').replace(/^\s*\d+\s*[.、]\s*/, '');
  return [...new Set(normText(cleaned).split(' '))]
    .filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));
}

const findings = [];
const scanned = [];

for (const year of YEARS) {
  const goldFile = join(ROOT, 'build', 'gold', `${year}.json`);
  if (!existsSync(goldFile)) continue;
  const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
  for (const art of gold.articles ?? []) {
    const id = art.article_id;
    const mid = findMiddleFile(ROOT, year, id) ?? findMiddleFile(ROOT, year, `-${id}`);
    if (!mid) continue;
    let doc;
    try {
      doc = ingest({ rootDir: ROOT, year, studyId: mid === findMiddleFile(ROOT, year, `-${id}`) ? `-${id}` : id }).doc;
    } catch { continue; }
    // 论文全文（含表格网格与图注）作为"这个词是否出现在本篇"的判据
    const paperText = normText(doc.blocks.map((b) => b.text).join(' \n '));
    const rows = art.outcomes ?? [];
    scanned.push({ year, articleId: id, rows: rows.length });
    for (const [i, o] of rows.entries()) {
      const name = o.outcome?.name?.raw ?? '';
      const tokens = distinctiveTokens(name);
      if (tokens.length === 0) continue;
      const present = tokens.filter((t) => paperText.includes(t));
      if (present.length > 0) continue;
      // 同篇其他行的 literature_code 前缀（用于旁证）
      const prefixOf = (s) => String(s ?? '').match(/^([A-Za-z]+\d+)/)?.[1] ?? '';
      const myPrefix = prefixOf(o.literature_code?.raw);
      const others = [...new Set(rows.map((r) => prefixOf(r.literature_code?.raw)).filter(Boolean))];
      findings.push({
        year,
        articleId: id,
        rowIndex: i,
        outcomeName: name,
        instrument: o.outcome?.instrument?.raw ?? '',
        literatureCode: o.literature_code?.raw ?? '',
        reason:
          `结局名的实词（${tokens.join(', ')}）在本篇的正文/表格/图注里全部找不到——` +
          '该行疑似串到了别的文章（金标准整行错位），不参与评分',
        evidence: {
          missingTokens: tokens,
          articleLiteraturePrefix: myPrefix,
          allPrefixesInArticle: others,
        },
      });
    }
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  method: '结局名的实词必须能在该文章的 MinerU 产物里找到（正文+表格网格+图注）',
  scanned,
  findings,
};
mkdirSync(join(ROOT, 'build'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'gold_row_anomalies.json'), JSON.stringify(out, null, 2), 'utf8');

console.log(`\n=== 金标准结局行错位检测 ===`);
for (const s of scanned) console.log(`  已扫 ${s.articleId}（${s.rows} 行）`);
console.log(`\n发现 ${findings.length} 行疑似串篇：`);
for (const f of findings) {
  console.log(`  ${f.articleId} 第 ${f.rowIndex + 1} 行「${f.outcomeName}」/「${f.instrument}」` +
    ` literature_code=${f.literatureCode || '-'}`);
  console.log(`      找不到的词：${f.evidence.missingTokens.join(', ')}` +
    `（本篇出现过的文献前缀：${f.evidence.allPrefixesInArticle.join(', ') || '-'}）`);
}
console.log(`\n  报告 build/gold_row_anomalies.json\n`);
