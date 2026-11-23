/**
 * 抽取流水线运行器（真实调用 DeepSeek）
 *
 * 把三个 SKILL 串成一次完整抽取：
 *
 *   MinerU _middle.json ──ingest──▶ MiniDoc ──┬─ article-meta  SKILL ─▶ 文章级字段
 *                                            ├─ comparison    SKILL ─▶ 比较组[]
 *                                            └─ outcome       SKILL ─▶ 结局[]
 *                                                        │
 *                                                  合并 + auditEvidence
 *                                                        ▼
 *                                    build/extraction/<year>/<id>.json
 *
 * 用法：
 *   node tools/llm_run.mjs --year 2015                    # 全部 6 篇
 *   node tools/llm_run.mjs --year 2015 --only 2015-01     # 单篇（调提示词时用）
 *   node tools/llm_run.mjs --year 2015 --skill comparison # 只跑一个 SKILL
 *   node tools/llm_run.mjs --year 2015 --skill outcomePlan,audit --seed-dir build/extraction --out-dir build/pilot
 *   node tools/llm_run.mjs --year 2015 --fresh            # 忽略缓存，强制重新请求
 *
 * 缓存：请求指纹（tag+system+user+model）→ build/llm-cache/<key>.json。
 * 同一份材料与提示词重复运行不会重复付费；改了提示词即自动失效。
 * 缓存里存的是模型原始响应（含 quote），因此评测与回归都能离线复现。
 *
 * 密钥：只从 runtime/llm.local.json 或环境变量读取，永不写入产物。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from '../packages/ingest/dist/index.js';
import { auditEvidence, studiesFromPdfNames } from '../packages/core/dist/index.js';
import {
  createArticleMetaSkill,
  createComparisonSkill,
  createOutcomeSkill,
  createOutcomeValuesSkill,
  applyMeasurementType,
  validateExtractedIntervals,
  comparisonScope,
  declaredPrimaryChange,
  matchesDeclaredChange,
  sameOutcomeLabel,
  sourceEventPair,
  createOutcomePlanSkill,
  createOutcomeAuditSkill,
  createStudyPlanSkill,
  createDeepSeekLlm,
  requestKey,
  legendFor,
  groundingStats,
  resetGroundingStats,
} from '../packages/skills/dist/index.js';
import { createCrossrefClient } from '../packages/crossref/dist/index.js';
import { createEuropePmcClient } from '../packages/europepmc/dist/index.js';
import { readIfEntriesFromXlsx, buildIfLookup } from './lib/if.mjs';
import { loadLlmConfig, llmCacheSuffix } from './lib/llm-config.mjs';
import { readParticipantFlow } from './lib/participant-flow.mjs';
import { applyNativeTableRepairs, readNativeTables } from './lib/source-table-repair.mjs';

/*
 * 数据根目录（Datas / build / runtime 所在处）。
 *
 * ⚠️ 必须支持 `AA_ROOT`：桌面壳（Electron）把「流水线代码」和「用户工作区」分开——
 * 代码在 exe 内的 `resources/app`，数据在用户选的工作区目录。壳启动时把工作区写进
 * `AA_ROOT`（见 `apps/desktop/main.mjs`）并让子进程继承环境变量。
 * 不读它的话，打包后 `ROOT` 会解析成 `resources/app`，于是：
 *   · 读不到工作区的 `runtime/llm.local.json`（报"未找到配置文件"）
 *   · 抽取产物写进 exe 自己的解包目录，界面永远看不到（实测踩到）
 * 命令行用法不受影响：不设 `AA_ROOT` 时仍是"脚本所在目录的上一级"= 仓库根。
 */
const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const out = { year: '2015', only: [], skill: 'all', fresh: false, crossref: true, europepmc: true, dry: false, config: null, model: null, outDir: null, seedDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--year') out.year = next();
    else if (a === '--only') out.only.push(...String(next()).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--skill') out.skill = next();
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--no-crossref') out.crossref = false;
    else if (a === '--no-europepmc') out.europepmc = false;
    else if (a === '--dry') out.dry = true;
    else if (a === '--out-dir') out.outDir = next();
    else if (a === '--seed-dir') out.seedDir = next();
    else if (a === '--config') out.config = next();
    else if (a === '--model') out.model = next();
    else if (a === '--help' || a === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

/* ------------------------------ 配置读取 ------------------------------ */

/* ------------------------------ 模型列表 ------------------------------ */

function listStudies(year) {
  const dir = join(ROOT, 'Datas', 'articles', year);
  if (!existsSync(dir)) return [];
  /*
   * ⚠️ 不能"从文件名里正则捞研究号"：`2024-12-01.pdf`（附件）会被捞成 `2024-12-01`，
   * 被当成独立研究跑一遍；而 articleIdOf 又会把它归约回 `2024-12`，
   * 于是附件那一次**覆盖掉正文的产物**（正文 9 页 → 附件 1 页，结局计划直接为空）。
   * 判据与实现在 @aa/core 的 studiesFromPdfNames（有单测）。
   */
  const { studies, skipped } = studiesFromPdfNames(readdirSync(dir));
  if (skipped.length) {
    console.log(`  [研究清单] 跳过 ${skipped.length} 个非正文 PDF（附件/分册）：${skipped.join('、')}`);
  }
  return studies.map((s) => s.studyId).sort((a, b) => a.localeCompare(b));
}

/* ------------------------------ 主流程 ------------------------------ */

const args = parseArgs(process.argv.slice(2));
const cfg = loadLlmConfig(ROOT, { path: args.config ?? undefined });
const model = args.model ?? cfg.model;
const cacheSuffix = llmCacheSuffix({ ...cfg, model });

const log = (msg, data) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
};

/* 缓存包装：同材料同提示词不重复请求 */
const cacheDir = join(ROOT, 'build', 'llm-cache');
let cacheHit = 0;
let cacheMiss = 0;

const llm = createDeepSeekLlm({
  ...cfg,
  model,
  onCall: (info) => {
    const u = info.usage ? ` in=${info.usage.inputTokens ?? '?'} out=${info.usage.outputTokens ?? '?'}` : '';
    log(`  ${info.ok ? '✓' : '✗'} ${info.tag} ${info.ms}ms${u}${info.error ? ' — ' + info.error : ''}`);
  },
});

/** 本次运行的 quote 定位统计从 0 起算（模块级计数器会跨文章累加）。 */
resetGroundingStats();

const cachedLlm = {
  async invoke(req) {
    const key = `${requestKey(req)}-${model.replace(/[^\w.-]/g, '_')}${cacheSuffix}`;
    const file = join(cacheDir, `${key}.json`);
    if (!args.fresh && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      cacheHit++;
      log(`  ⏎ 命中缓存 ${req.tag}`);
      return hit.response;
    }
    cacheMiss++;
    const response = await llm.invoke(req);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      key, tag: req.tag, model: response.model,
      prompt: { system: req.system, user: req.user },
      response,
      at: new Date().toISOString(),
    }, null, 2), 'utf8');
    return response;
  },
};

const crossref = args.crossref && cfg.crossrefMailto
  ? createCrossrefClient({ mailto: cfg.crossrefMailto })
  : undefined;

/*
 * Europe PMC：**第二校验源**（题名常比 Crossref 更完整，实测 27 篇题名失分里 20 篇如此）。
 * 它不需要 API key，但同样带 `mailto` 更礼貌，所以沿用同一个配置项；
 * `--no-europepmc` 可单独关掉（与 Crossref 解耦，便于对照实验）。
 */
const europepmc = args.europepmc && cfg.crossrefMailto
  ? createEuropePmcClient({ mailto: cfg.crossrefMailto })
  : undefined;

/*
 * 影响因子查表：从 Datas/IF-SCI-2019.xlsx 建索引（JCR 2019 SCIE）。
 * 论文里没有影响因子，只能查表；索引优先用 build/if-2019.json（`pnpm if:index` 生成），
 * 缺失时现算一次，保证"拿到新语料直接跑"也不会退化成让模型猜。
 */
const ifLookup = (() => {
  try {
    const idxFile = join(ROOT, 'build', 'if-2019.json');
    if (existsSync(idxFile)) {
      const j = JSON.parse(readFileSync(idxFile, 'utf8'));
      console.log(`  [影响因子] 用索引 build/if-2019.json（${j.entries?.length ?? 0} 个期刊）`);
      return buildIfLookup(j.entries ?? []);
    }
    const { entries, sheet } = readIfEntriesFromXlsx(join(ROOT, 'Datas', 'IF-SCI-2019.xlsx'));
    console.log(`  [影响因子] 现算索引：表《${sheet}》${entries.length} 个期刊`);
    return buildIfLookup(entries);
  } catch (e) {
    console.warn(`  ⚠ 影响因子索引不可用（${e.message}）——该字段将保持模型输出，可能不准`);
    return undefined;
  }
})();

const skills = {
  article: createArticleMetaSkill(ifLookup ? { ifLookup } : {}),
  comparison: createComparisonSkill(),
  // outcome 需要知道「有几个比较组」才能按 (比较组 × 结局) 扇出，因此延后构造（见下）
};

const legend = { get: (_level, field) => legendFor(field)?.legend };

const studies = args.only.length ? args.only : listStudies(args.year);
if (!studies.length) {
  console.error(`${args.year} 下没有找到 PDF`);
  process.exit(2);
}

console.log(`\n=== 抽取运行 ===`);
console.log(`  年份   ${args.year}`);
console.log(`  研究   ${studies.join(', ')}`);
console.log(`  SKILL  ${args.skill}`);
console.log(`  模型   ${model} (${cfg.baseUrl})`);
console.log(`  配置   ${cfg.configPath}`);
console.log(`  Crossref ${crossref ? '开' : '关'} | 缓存 ${args.fresh ? '禁用(--fresh)' : '开启'}\n`);

const stageOrder = ['plan', 'article', 'comparison', 'outcomePlan', 'outcome', 'outcomeValues', 'audit'];
const stages = args.skill === 'all' ? stageOrder : args.skill.split(',');
if (stages.some(stage => !stageOrder.includes(stage))) throw new Error(`未知抽取阶段 ${args.skill}`);
const outDir = join(args.outDir ? resolve(ROOT, args.outDir) : join(ROOT, 'build', 'extraction'), args.year);
const seedDir = args.seedDir ? resolve(ROOT, args.seedDir, args.year) : null;
const outcomeWork = stages.some(stage => ['outcomePlan', 'outcome', 'outcomeValues', 'audit'].includes(stage));
mkdirSync(outDir, { recursive: true });

const runSummary = {
  year: args.year, model, baseUrl: cfg.baseUrl, at: new Date().toISOString(),
  skill: args.skill, articles: [],
};

for (const studyId of studies) {
  console.log(`\n──── ${studyId} ────`);
  const t0 = Date.now();
  /**
   * 本篇开始的调用计数。
   *
   * 用来判定"全盘失败"：`llm.calls` 每次请求都推一条带 `ok` 的记录。
   * ⚠️ 光看"有没有抛异常"不够 —— 每个 SKILL 的失败都被 catch 住、记进 issues
   * 后继续跑下一个，所以"余额用尽"这种全盘失败也会走完全程、写出几乎空的产物。
   * 而且"所有 SKILL 都失败"这个判据也不够：实测 7 个 SKILL 里有 4 个"成功地"
   * 跑出了 0 项（每次调用都失败但被吞掉），照样被判成成功。
   * **调用级**才是准的。
   */
  const callsBefore = llm.calls.length;

  let ing;
  try {
    ing = ingest({ rootDir: ROOT, year: args.year, studyId });
  } catch (e) {
    console.error(`  ✗ 解析产物读取失败：${e.message}`);
    runSummary.articles.push({ studyId, ok: false, error: e.message });
    continue;
  }
  const native = outcomeWork ? readNativeTables(ROOT, args.year, studyId, ing.doc) : { doc: ing.doc, repairs: [], unresolved: [] };
  const doc = native.doc;
  console.log(`  MiniDoc: ${doc.stats.totalBlocks} 块 / ${doc.stats.pagesCovered} 页 / 表 ${doc.stats.tables} / 图 ${doc.stats.figures}`);

  /*
   * 兜底护栏：产物文件名用的是 `doc.articleId`。
   * 若传进来的 studyId 形如 `2024-12-01`（附件的比较组式后缀），articleIdOf 会把它归约成
   * `2024-12` → **写到正文那篇的文件上**，把正文结果覆盖成附件的结果。
   * 实测这就是 2024-12 准确率 5.1%（全语料最低）的成因。
   * 这里显式拦下：studyId 与 articleId 不一致就不写，宁可报错也不要静默覆盖。
   */
  if (studyId !== doc.articleId) {
    console.error(`  ✗ 跳过：studyId=${studyId} 会被归约为 articleId=${doc.articleId}，`
      + `写入会覆盖正文产物（该文件应为正文 PDF 的抽取结果）。`);
    runSummary.articles.push({ studyId, ok: false, error: `studyId 与 articleId 不一致（${studyId} → ${doc.articleId}）` });
    continue;
  }

  const ctx = { doc, llm: cachedLlm, ...(crossref ? { crossref } : {}), ...(europepmc ? { europepmc } : {}), log, legend };

  const issues = [];
  const unresolved = [];
  const perSkill = {};

  /*
   * 局部重跑要**合并**而不是整体覆盖。
   *
   * 实测踩到的坑：`--skill outcome` 会把整份文档重写成"只有 outcomes"，
   * 于是 article / comparisons 凭空消失（评测表上表现为整层 0%，很容易误判成模型变差）。
   * 因此先读回已有产物，只覆盖本次真正跑过的层；issue/unresolved 按 skill 过滤后再并。
   */
  const outFile = join(outDir, `${doc.articleId}.json`);
  const seedFile = seedDir && join(seedDir, `${doc.articleId}.json`);
  const previousFile = existsSync(outFile) ? outFile : seedFile;
  if (seedFile && !existsSync(previousFile)) throw new Error(`找不到局部复跑的种子结果 ${seedFile}`);
  const prev = previousFile ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
  const ranSkills = new Set();
  const ranSkillIds = new Set();

  /** 上游规划结果（study-plan / outcome-plan 的产出），供下游使用 */
  let planPayload = prev?.pipeline?.studyPlan ?? null;
  let outcomePlanPayload = prev?.pipeline?.outcomePlan ?? null;
  let planCount = planPayload?.comparisons?.length ?? 0;

  const extraction = {
    schemaVersion: 'AA_EXTRACTION/1.0',
    year: args.year,
    articleId: doc.articleId,
    sourcePdf: doc.sourcePdf,
    generatedAt: new Date().toISOString(),
    pipeline: {
      name: 'aa-skills',
      version: '0.1.0',
      modelIds: [model],
      mineru: ing.mineru,
      /*
       * 上游规划产物必须随文档一起保留。
       * 局部重跑（--skill outcome）若丢掉它，outcome 会退化成「自己枚举」，
       * 条数与金标准对不上（实测 4 条变 9 条，且准确率掉 6 个点）。
       */
      ...(prev?.pipeline?.studyPlan ? { studyPlan: prev.pipeline.studyPlan } : {}),
      ...(prev?.pipeline?.outcomePlan ? { outcomePlan: prev.pipeline.outcomePlan } : {}),
      ...(args.skill !== 'all' ? { partialRun: { skills: [args.skill], previousGeneratedAt: prev?.generatedAt ?? null } } : {}),
    },
    article: prev?.article,
    comparisons: prev?.comparisons ?? [],
    outcomes: prev?.outcomes ?? [],
    unresolved: [],
    issues: [],
  };

  const plannedChange = outcomeWork ? declaredPrimaryChange(doc) : undefined;
  let unresolvedPrimary = false;
  const planPrimary = () => {
    if (!plannedChange) return;
    const title = plannedChange.planned.name.raw;
    const matches = label => matchesDeclaredChange(plannedChange, label);
    const declared = outcomePlanPayload ?? { outcomes: [], otherOutcomes: [], rejected: [] };
    const index = declared.outcomes.findIndex(outcome => matches(outcome.name?.raw ?? ''));
    if (index < 0) {
      outcomePlanPayload = { ...declared, outcomes: [plannedChange.planned, ...declared.outcomes] };
      issues.push({ severity: 'info', code: 'PRIMARY_DECLARATION_RECOVERED', message: title, skill: 'outcomePlan' });
    } else if (declared.outcomes[index].name.raw !== title) {
      const outcomes = [...declared.outcomes];
      outcomes[index] = { ...outcomes[index], ...plannedChange.planned };
      outcomePlanPayload = { ...declared, outcomes };
    }
    extraction.pipeline.outcomePlan = outcomePlanPayload;
    return matches;
  };
  const indexOfPair = studyId => {
    const suffix = String(studyId ?? '').slice(doc.articleId.length);
    return /^-\d{2}$/.test(suffix) ? Number(suffix.slice(1)) - 1 : 0;
  };
  const checks = { primaryChange: false, eventPairs: 0, nativeOutcomePairs: 0 };
  const applySourceEvidence = () => {
    const matchesPrimary = planPrimary();
    const scoped = index => comparisonScope(doc.articleId, index, planPayload);
    if (matchesPrimary) {
      const scope = planCount === 1 ? scoped(0) : undefined;
      const hasArm = (header, text) => {
        const alias = header.replace(/\s+group\b.*$/i, '').trim();
        const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        return Boolean(alias && tokens.includes(alias.toLowerCase()));
      };
      if (scope && hasArm(plannedChange.groupLabels[0], scope.intervention)
          && hasArm(plannedChange.groupLabels[1], scope.control)) {
        const matched = extraction.outcomes.filter(row => matchesPrimary(row.outcome?.name?.raw ?? ''));
        if (!matched.length) {
          extraction.outcomes.push({ studyId: doc.articleId, outcome: { name: plannedChange.planned.name } });
        }
        if (matched.length > 1) {
          if (!unresolvedPrimary) unresolved.push({
            raw: plannedChange.planned.name.raw, evidence: plannedChange.planned.name.evidence, confidence: 0,
            reason: '同一主要结局对应多条抽取记录，请核对口径', skillId: 'outcome-plan',
          });
          unresolvedPrimary = true;
        }
        const row = matched.length > 1 ? undefined : matched[0] ?? extraction.outcomes.at(-1);
        if (row) {
          row.outcome.name = plannedChange.planned.name;
          // Only supply the windows verified in the single source table.
          row.timepoints = { ...row.timepoints, ...structuredClone(plannedChange.timepoints) };
          row.preferredResult = 'betweenGroupDifference';
          applyMeasurementType(row, row.timepoints);
          checks.primaryChange = true;
        }
      } else if (!unresolvedPrimary) {
        unresolvedPrimary = true;
        unresolved.push({
          raw: plannedChange.planned.name.raw, evidence: plannedChange.planned.name.evidence, confidence: 0,
          reason: '已找到主要结局结果行，比较组列需核对', skillId: 'outcome-plan',
        });
      }
    }
    let events = 0;
    let repaired = 0;
    for (const [index, row] of extraction.outcomes.entries()) {
      const scope = scoped(indexOfPair(row.studyId));
      if (scope) row.comparisonScope = scope;
      if (scope && planCount > 1) {
        const points = Object.values(row.timepoints ?? {}).filter(time => time.binary?.experimental?.events || time.binary?.control?.events);
        const pair = points.length === 1 ? sourceEventPair(doc, row.outcome?.name?.raw ?? '', scope) : undefined;
        if (pair) {
          points[0].binary = { ...points[0].binary, ...pair };
          applyMeasurementType(row, row.timepoints);
          events++;
        }
      }
      repaired += applyNativeTableRepairs(row, native.repairs);
      if (row.timepoints) {
        const review = [];
        validateExtractedIntervals(row.timepoints, `outcomes.${index}`, issues, review, false);
        unresolved.push(...review.map(item => ({ ...item, skillId: 'outcome-values' })));
      }
    }
    checks.eventPairs = events;
    checks.nativeOutcomePairs = repaired;
  };

  for (const name of stageOrder) {
    if (!stages.includes(name)) continue;
    ranSkills.add(name);
    if (name === 'outcome') planPrimary();
    if (name === 'outcomeValues' || name === 'audit') applySourceEvidence();
    /*
     * 上游两个规划 SKILL 先判定结构，再把结论注入下游：
     *   study-plan   → comparison 按计划逐组抽取、outcome 按比较组数扇出
     *   outcome-plan → outcome 不再自己枚举结局（清单带"声明句锚定"校验）
     * comparison 失败时按 1 个比较组兜底。
     */
    const planned = (planPayload?.comparisons ?? [])
      .map((c) => ({
        intervention: c.intervention?.raw ?? '',
        control: c.control?.raw ?? '',
      }))
      .filter((c) => c.intervention || c.control);

    /**
     * outcome-plan 的清单 → outcome 的 plannedOutcomes。
     * 直接传**已落地的 FieldValue**（带证据），不要再重新定位——见 outcome.ts 里的说明。
     */
    const plannedOutcomes = (outcomePlanPayload?.outcomes ?? [])
      .map((o) => ({
        ...(o.name ? { name: o.name } : {}),
        ...(o.instrument ? { instrument: o.instrument } : {}),
      }))
      .filter((o) => o.name || o.instrument);

    /*
     * 数值层：给定上一层（outcome）已经定好的结局清单，**逐个「结局 × 比较组」行**抽数值。
     *
     * 为什么单独一个 SKILL：数值列的识别规则（ITT vs PP、变异值是 SD 还是 95%CI、
     * 例数在正文里、四件套）篇幅很大，塞进结局字段的提示词里会把字段图例挤掉，两边都做不好。
     * 拆开后 `outcome-values` 的提示词全是"取哪一列"，`outcome` 的提示词只讲字段定义。
     *
     * ⚠️ 比较组身份必须传下去：多臂试验的表格按臂分行（A/B/C），同一结局在不同比较组下
     * 取的是**不同的行**（2015-04：比较组 1 取 A 行 −1.56、比较组 2 取 B 行 −2.34）。
     * 无法定位比较组时留空，提示词会退化成"全文只有一个比较组"的说法。
     */
    const comparisonOfRow = (studyId) => {
      /*
       * 扇出时 studyId 形如 `2015-04-02`（比较组序号从 1 开始）；单比较组时就是文章号 `2015-04`。
       *
       * ⚠️ 必须用**文章号 + `-NN`** 来匹配，不能只匹配结尾的 `-数字`：
       * `2015-04` 自身就以 `-04` 结尾，用裸后缀正则会把它解析成"第 4 个比较组"，
       * 于是单比较组的论文全部取不到比较组标签（实测 2015-02/03 就是这样静默退化的）。
       */
      const m = new RegExp(`^${doc.articleId}-(\\d{2})$`).exec(String(studyId ?? ''));
      const idx = m ? Number(m[1]) - 1 : 0;
      const scoped = comparisonScope(doc.articleId, idx, planPayload);
      if (scoped) return scoped;
      const c = extraction.comparisons?.[idx];
      if (!c) return undefined;
      const intervention = (c.intervention?.raw ?? '').trim();
      const control = (c.control?.raw ?? '').trim();
      return intervention || control ? { intervention, control } : undefined;
    };
    const valueTargets = (extraction.outcomes ?? [])
      .map((o, rowIndex) => {
        const comparison = comparisonOfRow(o.studyId);
        return {
          rowIndex,
          name: (o.outcome?.name?.raw ?? '').trim(),
          instrument: (o.outcome?.instrument?.raw ?? '').trim(),
          ...(o.outcome?.measurementUnit?.raw ? { unit: String(o.outcome.measurementUnit.raw) } : {}),
          ...(comparison ? { comparison } : {}),
        };
      })
      .filter((t) => t.name || t.instrument);

    const skill = name === 'plan'
      ? createStudyPlanSkill()
      : name === 'outcomePlan'
        ? createOutcomePlanSkill({
            primaryHint: extraction.article?.studyOutcomes?.primaryOutcome,
            explicitChange: plannedChange?.planned,
          })
        : name === 'audit'
          // 事后验证：只针对已抽取的结局层做查漏补缺（不做全量重抽）
          ? createOutcomeAuditSkill({ extracted: extraction.outcomes })
          : name === 'comparison'
            ? createComparisonSkill({ plannedComparisons: planned })
            : name === 'outcomeValues'
              ? createOutcomeValuesSkill({ targets: valueTargets })
              : name === 'outcome'
                ? createOutcomeSkill({
                    comparisonCount: planCount || Math.max(1, extraction.comparisons.length),
                    ...(plannedOutcomes.length ? { plannedOutcomes } : {}),
                  })
                : skills[name];
    const st = Date.now();
    try {
      let skillContext = ctx;
      if (name === 'comparison') {
        const flow = await readParticipantFlow(ROOT, doc);
        skillContext = { ...ctx, doc: flow.doc };
        for (const message of flow.warnings) {
          console.warn(`  ⚠ ${message}`);
          issues.push({ severity: 'warning', code: 'FLOW_DIAGRAM_OCR', message, skill: name });
        }
      }
      const out = await skill.run(skillContext);
      ranSkillIds.add(out.skillId);
      const extra = skill.validate ? skill.validate(out, ctx) : [];
      perSkill[name] = {
        ms: Date.now() - st,
        fields: name === 'article'
          ? Object.keys(out.payload ?? {}).length
          : name === 'plan'
            ? (out.payload?.comparisons?.length ?? 0)
            : name === 'outcomePlan'
              ? (out.payload?.outcomes?.length ?? 0)
              : name === 'audit'
                ? (out.payload?.filled?.length ?? 0)
                : name === 'outcomeValues'
                  ? (out.payload?.values?.length ?? 0)
              : (out.payload?.comparisons ?? out.payload?.outcomes ?? []).length,
        issues: out.issues.length + extra.length,
        unresolved: out.unresolved.length,
      };
      issues.push(
        ...out.issues.map((i) => ({ ...i, skill: name })),
        ...extra.map((i) => ({ ...i, skill: name })),
      );
      unresolved.push(...out.unresolved.map((u) => ({ ...u, skillId: out.skillId })));

      if (name === 'plan') {
        planPayload = out.payload;
        planCount = out.payload?.comparisons?.length ?? 0;
        extraction.pipeline.studyPlan = out.payload;
      } else if (name === 'outcomePlan') {
        outcomePlanPayload = out.payload;
        extraction.pipeline.outcomePlan = out.payload;
        planPrimary();
      } else if (name === 'audit') {
        extraction.pipeline.outcomeAudit = {
          ...out.payload,
          filled: out.payload.filled.length,
          reported: out.payload.reported.length,
          reportedItems: out.payload.reported,
          filledItems: out.payload.filled,
        };
      } else if (name === 'article') {
        /*
         * 两个联网源都写进 `article.external`（而不是散在顶层），
         * 好处是"哪些字段是外部源给的"一眼可辨、也便于前端分开呈现。
         */
        const { studyOutcomes, crossref: cr, europepmc: epmc, ...rest } = out.payload ?? {};
        const external = {
          ...(cr ? { crossref: cr } : {}),
          ...(epmc ? { europepmc: epmc } : {}),
        };
        extraction.article = {
          articleId: doc.articleId,
          ...rest,
          ...(studyOutcomes ? { studyOutcomes } : {}),
          ...(Object.keys(external).length ? { external } : {}),
        };
      } else if (name === 'comparison') {
        extraction.comparisons = out.payload?.comparisons ?? [];
      } else if (name === 'outcomeValues') {
        /*
         * 数值层回填：按 rowIndex 把时点块合进已存在的结局行。
         *
         * 只覆盖时点块，**不动结局自身字段**——名称/工具/编码由 outcome 负责，
         * 两边各写一半、互不覆盖，局部重跑任何一边都不会把另一边冲掉。
         */
        const filled = out.payload?.values ?? [];
        let merged = 0;
        let mtAdjusted = 0;
        for (const v of filled) {
          const row = extraction.outcomes?.[v.rowIndex];
          if (!row || !v.timepoints || Object.keys(v.timepoints).length === 0) continue;
          // 新的时点候选已重新校验，旧端点不可混入本轮数值。
          row.timepoints = v.timepoints;
          if (v.preferredResult) row.preferredResult = v.preferredResult;
          else delete row.preferredResult;
          /*
           * 数值与编码自洽：填了 difference_* 就该是 measurementType=2、填了 events 就该是 3。
           * 模型经常在这里自相矛盾（实测 2015-04 的 BDI 两行填了差值却写 1），
           * 因此由代码确定性推导后写回，不再依赖提示词。
           */
          if (applyMeasurementType(row, row.timepoints)) mtAdjusted++;
          merged++;
        }
        extraction.pipeline.outcomeValues = {
          rows: extraction.outcomes?.length ?? 0,
          values: filled.length,
          merged,
          measurementTypeAdjusted: mtAdjusted,
        };
        console.log(`             回填时点数值 ${merged} 行（其中修正 measurementType ${mtAdjusted} 行）`);
      } else {
        const fresh = out.payload?.outcomes ?? [];
        /*
         * 局部重跑 `--skill outcome` 时，本层只产出结局自身字段（数值归 outcome-values）。
         * 先把上一次已回填的时点块带过来，避免"重跑结局字段"顺手把数值冲掉；
         * 随后 outcome-values 再跑一次就会覆盖成最新值。
         */
        const prevRows = extraction.outcomes ?? [];
        for (const row of fresh) {
          const matches = prevRows.filter(old => old.studyId === row.studyId
            && sameOutcomeLabel(old.outcome?.name?.raw ?? '', row.outcome?.name?.raw ?? '')
            && (old.outcome?.instrument?.raw === row.outcome?.instrument?.raw
              || sameOutcomeLabel(old.outcome?.instrument?.raw ?? '', row.outcome?.instrument?.raw ?? '')));
          if (matches.length !== 1) continue;
          row.timepoints ??= matches[0].timepoints;
          row.preferredResult ??= matches[0].preferredResult;
        }
        extraction.outcomes = fresh;
      }
      console.log(`  ${name.padEnd(10)} ✓ ${perSkill[name].fields} 项, ${perSkill[name].ms}ms, issue ${perSkill[name].issues}, unresolved ${perSkill[name].unresolved}`);
    } catch (e) {
      perSkill[name] = { ms: Date.now() - st, error: e.message, kind: e.kind };
      issues.push({ severity: 'error', code: 'SKILL_FAILED', message: `${name}: ${e.message}` });
      console.error(`  ${name.padEnd(10)} ✗ ${e.message}`);
    }
  }

  if (outcomeWork) {
    applySourceEvidence();
    extraction.pipeline.sourceOutcomeChecks = { ...checks, tableRepairs: native.repairs, tableUnresolved: native.unresolved };
  }

  extraction.issues = [...(prev?.issues ?? []).filter(item => !ranSkills.has(item.skill)), ...issues];
  extraction.unresolved = [...(prev?.unresolved ?? []).filter(item => !ranSkillIds.has(item.skillId)), ...unresolved];

  /*
   * 证据审计只针对"字段-bearing"的部分。
   * 不能对整个文档调用：`unresolved` 里的候选条目形状是 { raw, evidence: [] }（有意为空，
   * 表示"有材料但没抽出字段"），会被 auditEvidence 误判成缺证据。
   */
  const violations = auditEvidence({
    article: extraction.article,
    comparisons: extraction.comparisons,
    outcomes: extraction.outcomes,
  });
  if (violations.length) {
    extraction.issues = [...extraction.issues, ...violations.map((p) => ({
      severity: 'error', code: 'EVIDENCE_MISSING', message: `字段缺少证据：${p}`, path: p,
    }))];
  }

  const file = outFile;
  writeFileSync(file, JSON.stringify(extraction, null, 2), 'utf8');

  const fieldCount = (() => {
    let n = 0;
    const walk = (o) => {
      if (o === null || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o.raw === 'string' && 'evidence' in o) { n++; return; }
      Object.values(o).forEach(walk);
    };
    walk(extraction);
    return n;
  })();

  const errors = extraction.issues.filter((i) => i.severity === 'error').length;
  const warns = extraction.issues.filter((i) => i.severity === 'warning').length;

  /*
   * "跑完没抛异常" ≠ "抽成功了"（判据说明见 callsBefore 处）。
   * ⚠️ 假成功比直接报错危险得多：实测 2015-06 的 14 次调用全 403，
   * 产物只剩 149 个叶子（基线 434），跑批却报"成功 6 / 6 篇"。
   */
  const artCalls = llm.calls.slice(callsBefore);
  const okCalls = artCalls.filter((c) => c.ok).length;
  const failedCalls = artCalls.length - okCalls;
  const skillNames = Object.keys(perSkill);
  const skillFailed = skillNames.filter((n) => perSkill[n]?.error);

  const catastrophic = fieldCount === 0
    || (artCalls.length > 0 && okCalls === 0)
    || (skillNames.length > 0 && skillFailed.length === skillNames.length);
  const failure = catastrophic
    ? (artCalls.length > 0 && okCalls === 0
      ? `本篇 ${artCalls.length} 次 LLM 调用全部失败（首个：${artCalls.find((c) => !c.ok)?.error ?? '未知'}）`
      : skillFailed.length
        ? `全部 ${skillFailed.length} 个 SKILL 都失败（首个：${perSkill[skillFailed[0]].error}）`
        : '没有抽到任何字段')
    : null;

  console.log(`  → ${file.replace(ROOT + '\\', '')}`);
  console.log(`  字段 ${fieldCount} | 证据违规 ${violations.length} | issue error ${errors} / warn ${warns} | ${Date.now() - t0}ms`);
  if (failedCalls > 0) {
    // 部分失败也要看得见：以前只在上面逐行打 ✗，汇总里完全看不出来
    const pct = ((failedCalls / artCalls.length) * 100).toFixed(0);
    console.warn(`  ⚠ ${failedCalls}/${artCalls.length} 次调用失败（${pct}%）`
      + (skillFailed.length ? `，涉及 SKILL：${skillFailed.join('、')}` : ''));
  }

  runSummary.articles.push({
    studyId: doc.articleId, ok: !catastrophic, file: file.replace(ROOT + '\\', ''),
    perSkill, fields: fieldCount, evidenceViolations: violations.length,
    errors, warns, ms: Date.now() - t0,
    calls: artCalls.length, callsFailed: failedCalls,
    skillsFailed: skillFailed.length, skillsTotal: skillNames.length,
    ...(failure ? { error: failure } : {}),
    comparisons: extraction.comparisons.length, outcomes: extraction.outcomes.length,
  });
}

/* ------------------------------ 汇总 ------------------------------ */

const usage = llm.calls.reduce((acc, c) => ({
  calls: acc.calls + 1,
  inputTokens: acc.inputTokens + (c.usage?.inputTokens ?? 0),
  outputTokens: acc.outputTokens + (c.usage?.outputTokens ?? 0),
  ms: acc.ms + c.ms,
}), { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 });

runSummary.usage = usage;
runSummary.cache = { hit: cacheHit, miss: cacheMiss };
/*
 * quote 逐字命中率：衡量"提示词要求的『quote 逐字复制』有没有被听进去"。
 * `exact` 越高越好；`degraded*` 说明模型回传了"更规范"的版本；
 * `notFound` 是**真的丢字段**（定位失败 → 整个字段不入库）。
 */
runSummary.grounding = { ...groundingStats };
writeFileSync(join(outDir, '_run.json'), JSON.stringify(runSummary, null, 2), 'utf8');

console.log(`\n=== 汇总 ===`);
console.log(`  实际请求 ${usage.calls} 次（缓存命中 ${cacheHit}） | 输入 ${usage.inputTokens} tok / 输出 ${usage.outputTokens} tok | 累计 ${(usage.ms / 1000).toFixed(1)}s`);
const g = groundingStats;
const gTot = g.exact + g.degradedMid + g.degradedTail + g.notFound;
if (gTot) {
  console.log(`  quote 定位：逐字命中 ${g.exact}/${gTot}（${((g.exact / gTot) * 100).toFixed(1)}%）`
    + ` | 降级 ${g.degradedMid + g.degradedTail} | 定位失败丢字段 ${g.notFound} | 无 quote ${g.noQuote}`);
}
const failed = runSummary.articles.filter((a) => !a.ok);
console.log(`  成功 ${runSummary.articles.length - failed.length} / ${runSummary.articles.length} 篇`);
if (failed.length) {
  // 把失败原因一并打出来：以前只有一行"成功 N/M"，得往上翻几十行才知道为什么
  console.error('\n  ✗ 失败的篇：');
  for (const a of failed) console.error(`    ${a.studyId}  字段 ${a.fields}  —— ${a.error ?? '未知原因'}`);
}
console.log(`  报告 ${join(outDir, '_run.json')}\n`);
process.exit(failed.length ? 1 : 0);
