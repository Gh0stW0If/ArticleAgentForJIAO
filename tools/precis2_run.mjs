/**
 * PRECIS-2 评分运行器（第二篇）
 *
 *   MinerU _middle.json ──ingest──▶ MiniDoc ──precis2 SKILL──▶ build/precis2/<year>/<id>.json
 *
 * 用法：
 *   node tools/precis2_run.mjs --year 2015
 *   node tools/precis2_run.mjs --year 2015 --only 2015-01
 *   node tools/precis2_run.mjs --year 2015 --fresh        # 忽略缓存
 *   node tools/precis2_run.mjs --year 2015 --skip-existing
 *
 * 缓存与 `llm_run` 同一套（请求指纹 → build/llm-cache/），但键前缀 `precis2-`，
 * 避免与三张表的抽取缓存互相污染。
 *
 * 与三张表抽取的关系：**独立产物、独立缓存**。PRECIS-2 不修改 build/extraction，
 * 这样第二篇的评分可以按 05 单独迭代提示词，而不会影响第一篇的准确率基线。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from '../packages/ingest/dist/index.js';
import { studiesFromPdfNames } from '../packages/core/dist/index.js';
import {
  createDeepSeekLlm,
  createPrecis2Skill,
  requestKey,
  resetGroundingStats,
  groundingStats,
} from '../packages/skills/dist/index.js';
import { loadLlmConfig, llmCacheSuffix } from './lib/llm-config.mjs';

const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    year: '2015', only: [], fresh: false, skipExisting: false,
    config: null, model: null, dry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--year') out.year = next();
    else if (a === '--only') out.only.push(...String(next()).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--skip-existing') out.skipExisting = true;
    else if (a === '--config') out.config = next();
    else if (a === '--model') out.model = next();
    else if (a === '--dry') out.dry = true;
    else if (a === '--help' || a === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

/** 与 llm_run 同一判据：只从 PDF 文件名取正文研究号，附件不单独跑。 */
function listStudies(year) {
  const dir = join(ROOT, 'Datas', 'articles', year);
  if (!existsSync(dir)) return [];
  const { studies, skipped } = studiesFromPdfNames(readdirSync(dir));
  if (skipped.length) {
    console.log(`  [研究清单] 跳过 ${skipped.length} 个非正文 PDF（附件/分册）：${skipped.join('、')}`);
  }
  return studies.map((s) => s.studyId).sort((a, b) => a.localeCompare(b));
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadLlmConfig(ROOT, { path: args.config ?? undefined });
const model = args.model ?? cfg.model;
const cacheSuffix = llmCacheSuffix({ ...cfg, model });

const log = (msg, data) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
};

const cacheDir = join(ROOT, 'build', 'llm-cache');
mkdirSync(cacheDir, { recursive: true });
let cacheHit = 0;
let cacheMiss = 0;

const llm = createDeepSeekLlm({
  ...cfg,
  model,
  // PRECIS-2 输出较长（九领域 × 证据 + 依据）。0 = 不限制，避免长输出被截断成坏 JSON。
  maxTokens: 0,
  onCall: (info) => {
    const u = info.usage ? ` in=${info.usage.inputTokens ?? '?'} out=${info.usage.outputTokens ?? '?'}` : '';
    log(`  ${info.ok ? '✓' : '✗'} ${info.tag} ${info.ms}ms${u}${info.error ? ' — ' + info.error : ''}`);
  },
});

const cachedLlm = {
  async invoke(req) {
    const key = `precis2-${requestKey(req)}-${model.replace(/[^\w.-]/g, '_')}${cacheSuffix}`;
    const file = join(cacheDir, `${key}.json`);
    if (!args.fresh && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      cacheHit++;
      log(`  ⏎ 命中缓存 ${req.tag}`);
      return hit.response;
    }
    cacheMiss++;
    const response = await llm.invoke(req);
    writeFileSync(file, JSON.stringify({
      key, tag: req.tag, model: response.model,
      prompt: { system: req.system, user: req.user },
      response,
      at: new Date().toISOString(),
    }, null, 2), 'utf8');
    return response;
  },
};

const studies = args.only.length ? args.only : listStudies(args.year);
if (!studies.length) {
  console.error(`${args.year} 下没有找到 PDF`);
  process.exit(2);
}

console.log(`\n=== PRECIS-2 评分运行 ===`);
console.log(`  年份   ${args.year}`);
console.log(`  研究   ${studies.join(', ')}`);
console.log(`  模型   ${model} (${cfg.baseUrl})`);
console.log(`  配置   ${cfg.configPath}`);
console.log(`  缓存   ${args.fresh ? '禁用(--fresh)' : '开启'}\n`);

const outDir = join(ROOT, 'build', 'precis2', args.year);
mkdirSync(outDir, { recursive: true });

const skill = createPrecis2Skill();
const runSummary = {
  year: args.year, model, baseUrl: cfg.baseUrl, at: new Date().toISOString(),
  skill: { id: skill.id, version: skill.version },
  articles: [],
};

for (const studyId of studies) {
  console.log(`\n──── ${studyId} ────`);
  const t0 = Date.now();
  const outFile = join(outDir, `${studyId}.json`);

  if (args.skipExisting && existsSync(outFile)) {
    console.log('  ⏭ 已有产物，跳过（--skip-existing）');
    runSummary.articles.push({ studyId, skipped: true });
    continue;
  }

  let ing;
  try {
    ing = ingest({ rootDir: ROOT, year: args.year, studyId });
  } catch (e) {
    console.error(`  ✗ 解析产物读取失败：${e.message}`);
    runSummary.articles.push({ studyId, ok: false, error: e.message });
    continue;
  }
  const doc = ing.doc;
  console.log(`  MiniDoc: ${doc.stats.totalBlocks} 块 / ${doc.stats.pagesCovered} 页 / 表 ${doc.stats.tables} / 图 ${doc.stats.figures}`);

  if (studyId !== doc.articleId) {
    console.error(`  ✗ 跳过：studyId=${studyId} 会被归约为 articleId=${doc.articleId}（附件/分册？）`);
    runSummary.articles.push({ studyId, ok: false, error: `studyId 与 articleId 不一致（${studyId} → ${doc.articleId}）` });
    continue;
  }

  resetGroundingStats();
  const callsBefore = llm.calls.length;

  let out;
  try {
    out = await skill.run({ doc, llm: cachedLlm, log, legend: { get: () => undefined } });
  } catch (e) {
    console.error(`  ✗ SKILL 失败：${e.message}`);
    runSummary.articles.push({ studyId, ok: false, error: e.message, ms: Date.now() - t0 });
    continue;
  }

  const extra = skill.validate ? skill.validate(out, { doc, llm: cachedLlm, log, legend: { get: () => undefined } }) : [];
  const issues = [...out.issues, ...extra];
  const calls = llm.calls.slice(callsBefore);
  const usage = calls.reduce((a, c) => ({
    inputTokens: (a.inputTokens ?? 0) + (c.usage?.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (c.usage?.outputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0 });

  const record = {
    studyId,
    year: args.year,
    at: new Date().toISOString(),
    model,
    skill: { id: out.skillId, version: skill.version },
    payload: out.payload,
    issues,
    unresolved: out.unresolved,
    grounding: { ...groundingStats },
    usage,
    ms: Date.now() - t0,
    calls: calls.map((c) => ({ ok: c.ok, ms: c.ms, in: c.usage?.inputTokens, out: c.usage?.outputTokens, error: c.error })),
  };

  if (args.dry) {
    console.log('  [dry] 不落盘。payload 摘要：');
    console.log(JSON.stringify({
      usualCareContext: out.payload.usualCareContext,
      domains: Object.fromEntries(Object.entries(out.payload.domains).map(([k, v]) => [k, v?.label])),
    }, null, 2));
  } else {
    writeFileSync(outFile, JSON.stringify(record, null, 2), 'utf8');
    console.log(`  ✓ 九领域：${Object.entries(out.payload.domains).map(([k, v]) => `${k}=${v?.label ?? '—'}`).join(' ')}`);
    console.log(`  接地 ${groundingStats.exact + groundingStats.degradedMid + groundingStats.degradedTail}/${groundingStats.exact + groundingStats.degradedMid + groundingStats.degradedTail + groundingStats.notFound + groundingStats.noQuote} 条引文；issue ${issues.length}；${record.ms}ms`);
  }

  runSummary.articles.push({
    studyId,
    ok: true,
    ms: record.ms,
    domains: Object.fromEntries(Object.entries(out.payload.domains).map(([k, v]) => [k, v?.label])),
    grounded: Object.values(out.payload.domains).filter((d) => d?.grounded).length,
    ungrounded: Object.values(out.payload.domains).filter((d) => d && !d.grounded && !d.absenceBased).length,
    issues: issues.length,
    unresolved: out.unresolved.length,
    usage,
  });
}

runSummary.cache = { hit: cacheHit, miss: cacheMiss };
if (!args.dry) {
  writeFileSync(join(outDir, '_run.json'), JSON.stringify(runSummary, null, 2), 'utf8');
  console.log(`\n报告 build/precis2/${args.year}/_run.json`);
}
