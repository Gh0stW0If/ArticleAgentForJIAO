/**
 * 抽取结果 × 金标准 评测
 *
 * 对照 `build/gold/<year>.json`（金标准）与 `build/extraction/<year>/*.json`（流水线），
 * 逐层逐字段给出 命中 / 编码命中 / 错 / 漏 / 多，并汇总成可比较的准确率。
 *
 * 用法：
 *   node tools/llm_eval.mjs --year 2015
 *   node tools/llm_eval.mjs --year 2015 --only 2015-01 --detail
 *
 * 三个层级的对齐方式（金标准与流水线的字段命名不同，必须显式跨接）：
 *   文章级    字段名 camelCase ↔ snake_case（camelToSnake，见下）
 *   比较组    按数组下标对齐（金标准每组一行；数量不符会单独报警）
 *   结局      按 literatureCode（金标准 STUDYID，如 EN009-1）优先对齐，
 *             退化为下标；时点键 baseline/end_of_treatment/follow_up_end 一并跨接
 *
 * 判定口径：
 *   hit        值相等（文本归一化后相等，或双方都是数值且数值相等）
 *   code-hit   值不同但受控编码相同（如原文写法差异，编码一致即视为可用）
 *   wrong      双方都有值但不等
 *   missed     金标准有、流水线没有
 *   extra      流水线有、金标准没有该列（不计入分母，单独列出以便发现"多抽"）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camelToSnake } from './lib/keys.mjs';
import { numericEqual, quantityEqual } from '../packages/core/dist/index.js';
import { judgePairs, VERDICT_LABEL, VERDICT_WEIGHT } from './lib/judge.mjs';
import { normText, normNum, tokensOf, dice, outcomeSimilarity, alignOutcomes, MIN_SCORE, isOutcomeCandidate } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ 错位金标准（不参与评分） ------------------------------ */

/**
 * 需求：可能的错位金标准先不参与评分，并记录下来。
 * `tools/gold_anomalies.mjs` 负责检测，这里按 (articleId, scope, field) 排除。
 * 注意：需在参数解析（opt）之后初始化 → 见下方 initExclusions()。
 */
const anomaliesFile = join(ROOT, 'build', 'gold_anomalies.json');
/**
 * 排除表里"叶子名"的历史写法 → 评分用的叶子名。
 * 审计工具走的是金标准结构（`binary.difference_estimate` 会记成 `difference`），
 * 评分走的是评测叶子名；两边必须能对上，否则排除表形同虚设。
 */
const LEAF_ALIASES = { difference: 'difference_estimate' };
/**
 * 排除表（**全部按"值"匹配**，不再按字段名整列排除）。
 *
 * 曾经的做法是"排除某篇文章的某个字段"，实测过度：同一篇里其他结局/时点的同名叶子
 * 明明答对也被排掉（Sheet3 从 33.5% 掉到 29.4%）。现在一律要求
 * 「文章 + 作用域 + 字段 + **金标准原值**」四者同时对上才排除。
 * 所有异常记录都带 value（见 tools/gold_anomalies.mjs / gold_vs_paper.mjs），因此可以这么做。
 */
const excludedSpecs = new Map();      // `${articleId}|${scope}|${field}` → Set(值)
const excludedValues = new Map();     // `${articleId}|${叶子名}` → Set(值)，用于 timepoints.*
const excludedHits = [];

/** 该字段值是否被判为"疑似错位"→ 不计分、只记录。 */
function isExcluded(articleId, scope, snakeField, goldRaw) {
  /*
   * 作用域要归一化：结局层的 `follow_up` 在评分代码里属于 `followUp` 作用域，
   * 而审计工具记录成 `outcome`——不归一化就排除不掉（实测踩到过）。
   */
  const scopes = scope === 'followUp' ? ['followUp', 'outcome'] : [scope];
  const raw = goldRaw === undefined ? undefined : String(goldRaw).trim();
  for (const sc of scopes) {
    const vals = excludedSpecs.get(`${articleId}|${sc}|${snakeField}`);
    if (vals && raw !== undefined && vals.has(raw)) {
      excludedHits.push(`${articleId}/${snakeField}=${raw}`);
      return true;
    }
  }
  /*
   * Sheet3 数值叶子：审计记的是 `timepoints.<叶子>`，而评分时作用域是
   * `<时点>.<块>`、字段名就是叶子名 → 用「文章 + 叶子 → 具体值」兜底匹配。
   */
  const vals = excludedValues.get(`${articleId}|${snakeField}`);
  if (vals && raw !== undefined && vals.has(raw)) {
    excludedHits.push(`${articleId}/${snakeField}=${raw}`);
    return true;
  }
  return false;
}

/* ------------------------------ 语义判定队列（Sheet1 描述性 / Sheet2 / Sheet3） ------------------------------ */

/**
 * 哪些字段交给 LLM 判语义。
 *
 * 需求：金标准里"无法标准化的自然语言信息"不能用逐字匹配判对错——
 * 同一句话截取窗口不同（金标准抄整句、机器抄要点）会被判成"错"。
 *
 * 实测（`tools/desc_field_judge.mjs`）：
 *   · 比较组级描述性字段 3,480 组失配里，**24% 是一方包含另一方**（同一句不同窗口）、
 *     9% 高度相似；`intervention` 达 47%、`condition` 达 69%；
 *   · 文章级同理（title/journal/first_author/author_contact/country）。
 * 因此把 **article 与 comparison 也纳入语义判定**——与 study/outcome 同一套判法。
 *
 * 编码/数值/哨兵值仍走严格比较（可判定，也没必要花判定费）。
 */
const JUDGE_SCOPES = /^(article|comparison|study|outcome|followUp|baseline|end_of_treatment|follow_up_end)/;
const isNumericLike = (s) => /^[-+]?\d+(\.\d+)?$/.test(String(s).trim());
/** 编码写法：`3`、`3/2`、`1;2`、`8;14` 这类（含金标准的多选写法）——一律严格比较 */
const isCodeLike = (s) => /^\d+(\s*[/;,、]\s*\d+)*$/.test(String(s).trim());
const shouldJudge = (scope, goldRaw, predRaw) => {
  if (!JUDGE_SCOPES.test(scope)) return false;
  if (!goldRaw || !predRaw) return false;
  // 纯数值/编码/哨兵值仍用严格比较
  if (isNumericLike(goldRaw) && isNumericLike(predRaw)) return false;
  if (isCodeLike(goldRaw) && isCodeLike(predRaw)) return false;
  if (/^(NR|NA|NE)$/i.test(String(goldRaw).trim()) && /^(NR|NA|NE)$/i.test(String(predRaw).trim())) return false;
  return true;
};

/**
 * **单位归一化判定**：带单位的时间/频次字段，先试确定性换算，能定就**不送 LLM**。
 *
 * 为什么需要（两个理由，第二个才是主要的）：
 *   1. **省钱**：这类字段的语义判定条目占比很高（比较组层 47%/44% 的条目要走 LLM）；
 *   2. **更稳**：LLM 判定本身有噪声——实测同一组 `"30"` vs `"30 minutes"`，
 *      在不同条目上被判过 1.0 也判过 0.5；而 `quantityEqual` 的结果可复现。
 *
 * 只在这些"表头指定了单位"的字段上启用；判不出来（定性描述、哨兵值）返回 null，
 * 照旧交给语义判定。
 */
const UNIT_FIELDS = new Set([
  'needle_retention_desc', 'course_desc', 'frequency_desc', 'max_followup_desc', 'insertion_depth_text',
]);
const unitDecided = (scope, field, goldRaw, predRaw) => {
  if (scope !== 'comparison' || !UNIT_FIELDS.has(field)) return null;
  const g = String(goldRaw ?? '').trim();
  const p = String(predRaw ?? '').trim();
  if (!g || !p) return null;
  if (/^(NR|NA|NE)[.。]?$/i.test(g) || /^(NR|NA|NE)[.。]?$/i.test(p)) return null;
  /* 形态一致（都是"数+单位"）且换算后同量 → 直接判对 */
  if (quantityEqual(g, p)) return 'identical';
  /* 两边的"数"完全一样、只是单位写法不同（如 `30` vs `30 min`）→ 也判对 */
  const numA = /^\s*(\d+(?:\.\d+)?)/.exec(g)?.[1];
  const numB = /^\s*(\d+(?:\.\d+)?)/.exec(p)?.[1];
  if (numA && numB && numA === numB) return 'same_meaning';
  return null;
};

/** 待判定的字段（收集完统一批量判定，避免逐条调用）。 */
const judgeQueue = [];
const judgeStat = { identical: 0, same_meaning: 0, contains_correct: 0, has_error: 0, completely_different: 0, unknown: 0 };
const enqueueJudge = (key, scope, field, goldRaw, predRaw) => {
  judgeQueue.push({ key, field: `${scope}.${field}`, gold: String(goldRaw), pred: String(predRaw) });
  return 'judged';   // 占位判定，统计在判定完成后单独给出
};

/* ------------------------------ 参数 ------------------------------ */

const argv = process.argv.slice(2);
const opt = { year: '2015', only: [], detail: false, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--year') opt.year = argv[++i];
  else if (a === '--only') opt.only.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
  else if (a === '--detail') opt.detail = true;
  else if (a === '--quiet') opt.quiet = true;
  else throw new Error(`未知参数 ${a}`);
}

/* 参数解析完成后再初始化"错位金标准"排除表（需要 opt.year） */
{
  /*
   * ⚠️ 「值未在论文中出现」这类发现**不能直接用**：原始判据（字面逐字匹配）偏严，
   * 论文里写 `week 24` / `24-week` / 小数点被排版吃掉，都会判成"找不到"。
   * 用这类误报当排除项 = 把本该扣的分抹掉，**准确率虚高**。
   * 所以先看 `tools/gold_evidence_check.mjs` 的宽容复核结论：
   *   found  → 复核后其实能在文中找到（误报）→ **不排除**
   *   weak   → 逐位数字能找到、写法可疑 → **不排除**（宁可不排除，不让分数虚高）
   *   strong → 连逐位数字都找不到 → 排除
   *   unknown→ 该篇没有解析产物，无法复核 → 排除（保持原判据）
   * 复核文件不存在时（未跑复核工具）退化为原行为，并在控制台提示。
   */
  const recheckFile = join(ROOT, 'build', 'gold_evidence_check.json');
  const VERDICT = new Map();
  if (existsSync(recheckFile)) {
    for (const it of JSON.parse(readFileSync(recheckFile, 'utf8')).items ?? []) {
      VERDICT.set(`${it.year}|${it.articleId}|${it.scope}|${it.field}|${String(it.value).trim()}`, it.verdict);
    }
  } else {
    console.warn('  ⚠️ 未找到 build/gold_evidence_check.json——"值不在论文里"的发现将按原判据全部排除，');
    console.warn('     这可能高估准确率。建议先跑：node tools/gold_evidence_check.mjs');
  }
  let skippedByRecheck = 0;
  const anomalies = existsSync(anomaliesFile) ? JSON.parse(readFileSync(anomaliesFile, 'utf8')) : null;
  for (const a of anomalies?.anomalies ?? []) {
    if (a.year !== opt.year) continue;
    if (a.reason === '值未在论文中出现（疑似错误金标准）' && VERDICT.size) {
      const k = `${a.year}|${a.articleId}|${a.scope}|${a.field}|${String(a.value).trim()}`;
      const v = VERDICT.get(k);
      if (v === 'found' || v === 'weak') { skippedByRecheck += 1; continue; }
    }
    /*
     * 建排除条目：非 timepoints 字段按「文章+作用域+字段 → 值集合」，
     * timepoints 叶子按「文章+叶子名 → 值集合」（评分时的作用域是 `<时点>.<块>`，对不上）。
     */
    const val = String(a.value ?? '').trim();
    if (!val) continue;
    if (/^timepoints\./.test(String(a.field))) {
      /*
       * ⚠️ 叶子名要对齐：`gold_vs_paper.mjs` 走金标准结构时把
       * `binary.difference_estimate` 记成 `timepoints.difference`（历史写法），
       * 而评分时用的叶子名是 `difference_estimate`——不归一化就永远排除不掉，
       * 本该剔除的疑似金标准值照常计分（实测 2019-02 的 7 个差值全因此没排除）。
       */
      const raw = String(a.field).replace(/^timepoints\./, '');
      const leaf = LEAF_ALIASES[raw] ?? raw;
      const key = `${a.articleId}|${leaf}`;
      if (!excludedValues.has(key)) excludedValues.set(key, new Set());
      excludedValues.get(key).add(val);
    } else {
      const key = `${a.articleId}|${a.scope}|${a.field}`;
      if (!excludedSpecs.has(key)) excludedSpecs.set(key, new Set());
      excludedSpecs.get(key).add(val);
    }
  }
  if (skippedByRecheck) {
    console.log(`  复核后恢复计分：${skippedByRecheck} 条"值不在论文里"的发现其实能在文中找到（不计入排除表）`);
  }
}

/**
 * 结局行级错位表：articleId → 该篇里被排除的 gold 行下标（整行不计分）。
 * 由 tools/gold_row_anomalies.mjs 生成；检测判据是"结局名的实词必须能在本篇里找到"。
 */
const excludedRowRows = new Map();
{
  const f = join(ROOT, 'build', 'gold_row_anomalies.json');
  if (existsSync(f)) {
    for (const x of JSON.parse(readFileSync(f, 'utf8')).findings ?? []) {
      if (x.year !== opt.year) continue;
      if (!excludedRowRows.has(x.articleId)) excludedRowRows.set(x.articleId, new Set());
      excludedRowRows.get(x.articleId).add(x.rowIndex);
    }
  }
}

/* ------------------------------ 跨接 ------------------------------ */

// camelCase ↔ snake_case：与 tools/field_coverage.mjs 共用同一实现（见 tools/lib/keys.mjs）
// 归一分词 / Dice / 结局行对齐：与诊断工具共用同一实现（见 tools/lib/align.mjs）

/** 金标准里不作为抽取目标/无对应列的字段（由数据管理流程填写，不由 LLM 推断）。 */
const NON_LLM_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check', 'title_sheet2', 'row_id', 'article_id', 'study_id']);

/** 流水线独有、金标准无对应列的字段。 */
const NO_GOLD_COLUMN = new Set(['doi', 'registration_ids', 'article_id', 'study_id', 'arm_number']);

const isNR = (s) => /^(nr|n\/r|not reported|未报告|na|n\/a|not applicable|不适用)$/i.test(String(s ?? '').trim());

/** 比较两个值。 */
function compareValue(predRaw, goldRaw) {
  if (predRaw === undefined || predRaw === null) return 'missed';
  if (isNR(predRaw) && isNR(goldRaw)) return 'hit';
  const a = normText(predRaw);
  const b = normText(goldRaw);
  if (a === b) return 'hit';
  /*
   * 数值判等用 @aa/core 的 numericEqual（按较短小数位四舍五入后比较）。
   *
   * ⚠️ 曾用"相对容差 0.5%"：|a-b| <= max(0.05, |b|*0.005)。它对效应量合理，
   * 但让**年份**白拿分——金标准 2015 vs 流水线 2018，差 3 ≤ 10.075 → 判命中；
   * publication_year 因此几乎全对（实测 47 篇年份不同却只记 3 处错），metadata 虚高约 1.2 个百分点。
   * 新口径不随数量级漂移：`41` vs `41.0` 仍算对，`2015` vs `2018` 一定算错。
   */
  if (numericEqual(a, b)) return 'hit';
  return 'wrong';
}

/** 单字段判定（先比 raw，再比 code）。 */
function judgeField(pred, gold) {
  if (!gold) return 'extra';
  const gRaw = gold.raw;
  if (pred === undefined || pred === null) return 'missed';
  const p = typeof pred === 'object' && pred !== null && 'raw' in pred ? pred : { raw: String(pred) };
  const rawVerdict = compareValue(p.raw, gRaw);
  if (rawVerdict === 'hit') return 'hit';
  const gc = gold.code;
  const pc = p.code;
  if (gc !== undefined && pc !== undefined && String(pc) === String(gc)) return 'code-hit';
  return 'wrong';
}

/* ------------------------------ 收集 ------------------------------ */

const goldFile = join(ROOT, 'build', 'gold', `${opt.year}.json`);
if (!existsSync(goldFile)) { console.error(`缺少金标准 ${goldFile}`); process.exit(2); }
const gold = JSON.parse(readFileSync(goldFile, 'utf8'));

const extrDir = join(ROOT, 'build', 'extraction', opt.year);
if (!existsSync(extrDir)) { console.error(`缺少抽取产物 ${extrDir}，请先运行 node tools/llm_run.mjs --year ${opt.year}`); process.exit(2); }

const ids = opt.only.length
  ? opt.only
  : readdirSync(extrDir).filter((f) => /^\d{4}-\d{1,2}\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();

/* ------------------------------ 统计容器 ------------------------------ */

const mkStat = () => ({ hit: 0, 'code-hit': 0, wrong: 0, missed: 0, extra: 0 });const addTo = (s, v) => { s[v] = (s[v] ?? 0) + 1; };
const pct = (s) => {
  const denom = s.hit + s['code-hit'] + s.wrong + s.missed;
  return denom ? ((s.hit + s['code-hit']) / denom) * 100 : 0;
};
const fmtPct = (s) => `${pct(s).toFixed(1)}%`;

/* 按字段聚合的命中情况（用于定位"哪个字段总是错"） */
const byField = new Map();
const fieldStat = (scope, field) => {
  const key = `${scope}.${field}`;
  if (!byField.has(key)) byField.set(key, mkStat());
  return byField.get(key);
};

/** 数一个对象里有多少个「字段值」（形如 { raw, evidence }）。 */
function countFieldLeaves(node) {
  let n = 0;
  const walk = (o) => {
    if (o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.raw === 'string') { n++; return; }
    Object.values(o).forEach(walk);
  };
  walk(node);
  return n;
}

/**
 * 覆盖率口径下的**候选边**：名字像（文本 Dice ≥ MIN_SCORE）**或**有数值佐证（重合 ≥2 个数）。
 *
 * 实现与口径说明见 `tools/lib/align.mjs` 的 `isOutcomeCandidate`
 * （与网页端「待人工裁定的结局行」共用，避免两边漂移）。
 * ⚠️ 不要退回 `score >= MIN_SCORE`：construct/subconstruct 加成会让每个产物行
 * 都成为候选，多对一之下漏抽会退化成 0。
 */

/**
 * 结局行的**路径拍平**：把一行拍成 `[路径, 字段对象]`。
 *
 * 只取 outcome / follow_up / timepoints 三块 —— 金标准行根上的 `literature_code`
 * 与 `arm_number` 不是抽取目标（等同 NON_LLM_GOLD），不该进分母。
 * 产物的块名是 camelCase（followUp），统一归一成金标准的 `follow_up`，
 * 这样两边路径能直接对齐。
 */
function flattenRow(row, blocks, conv) {
  const out = [];
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.raw === 'string') { out.push([prefix, node]); return; }
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${conv(k)}` : conv(k));
  };
  for (const b of blocks) {
    if (!row?.[b]) continue;
    walk(row[b], b === 'followUp' ? 'follow_up' : b);
  }
  return out;
}
const ROW_BLOCKS_GOLD = ['outcome', 'follow_up', 'timepoints'];
const ROW_BLOCKS_PRED = ['outcome', 'followUp', 'timepoints'];

/**
 * 路径 → (`byField` 用的 scope, field)。
 *
 *   outcome.x                    → ('outcome', 'x')
 *   follow_up.x                  → ('followUp', 'x')
 *   timepoints.tp.kind.role.leaf → ('tp.kind', 'leaf')   ← **组别段不进键**
 *
 * 组别（experimental/control）不进键是**故意**的：旧口径就是按 `tp.kind.leaf`
 * 聚合的，保持键不变才能让历史 `byField` 与新旧报告对照。
 */
function scopeFieldOf(path) {
  const seg = path.split('.');
  if (seg[0] === 'outcome') return { scope: 'outcome', field: seg.slice(1).join('.') };
  if (seg[0] === 'follow_up') return { scope: 'followUp', field: seg.slice(1).join('.') };
  return { scope: `${seg[1]}.${seg[2]}`, field: seg[seg.length - 1] };
}


/* 结局层额外统计：金标准行的"覆盖率" */
const outcomeCoverage = { goldRows: 0, alignedRows: 0, goldFields: 0, goldFieldsHit: 0 };
/**
 * 对齐口径披露：**靠数值佐证**配上的对会用到被评分的数值本身，
 * 所以必须单列出来——否则"配对改善"会被误读成"抽取改善"。
 */
const outcomeAlignment = { textOnly: 0, numericCorroborated: 0, weak: 0, note: [] };

const report = { year: opt.year, at: new Date().toISOString(), articles: [] };

/* ------------------------------ 逐篇评测 ------------------------------ */

for (const id of ids) {
  const f = join(extrDir, `${id}.json`);
  if (!existsSync(f)) { console.error(`  ⚠ 缺少 ${id} 的抽取产物，跳过`); continue; }
  const pred = JSON.parse(readFileSync(f, 'utf8'));
  const goldArt = (gold.articles ?? []).find((a) => a.article_id === id);
  if (!goldArt) { console.error(`  ⚠ 金标准里没有 ${id}，跳过`); continue; }

  const art = { id, article: mkStat(), comparison: mkStat(), outcome: mkStat(), notes: [] };

  /* ---- 文章级 ---- */
  const predArt = pred.article ?? {};
  const goldArtFields = goldArt.article ?? {};
  for (const [snake, gv] of Object.entries(goldArtFields)) {
    if (NON_LLM_GOLD.has(snake)) continue;
    /*
     * 文章级也要查排除表——此前只对 study/comparison/outcome 查，article 层的
     * 疑似错位金标准（如"年份不是 4 位数字"、影响因子与 IF-SCI-2019.xlsx 不一致）
     * 一直照常计分，等于让机器替金标准的错背分。
     */
    if (isExcluded(id, 'article', snake, gv.raw)) continue;
    const camel = Object.keys(predArt).find((k) => camelToSnake(k) === snake);
    const predField = camel ? predArt[camel] : undefined;
    /*
     * 文章级里的描述性字段（题目/期刊/作者/联系方式/病种/国家）交给语义判定——
     * 之前这里直接 judgeField（逐字比对），标题少个副标题、期刊写缩写都算错。
     */
    const verdict = shouldJudge('article', gv.raw, predField?.raw)
      ? enqueueJudge(`${id}/article.${snake}`, 'article', snake, gv.raw, predField.raw)
      : judgeField(predField, gv);
    if (process.env.AA_DEBUG_FIELD && snake === process.env.AA_DEBUG_FIELD) {
      console.error(`  [debug] ${id}.${snake}: gold=${JSON.stringify(gv?.raw)} pred=${JSON.stringify(predArt[camel]?.raw)} 键=${camel} → ${verdict}`);
    }
    if (verdict === 'judged') continue;
    addTo(art.article, verdict);
    addTo(fieldStat('article', snake), verdict);
    if ((verdict === 'wrong' || verdict === 'missed') && opt.detail) {
      art.notes.push(`文章级.${snake}: 金标准「${String(gv.raw).slice(0, 70)}」 vs 流水线「${camel ? String(predArt[camel]?.raw).slice(0, 70) : '（缺）'}」`);
    }
  }
  for (const k of Object.keys(predArt)) {
    if (k === 'articleId') continue;
    const snake = camelToSnake(k);
    if (NO_GOLD_COLUMN.has(snake) || !(snake in goldArtFields)) {
      if (predArt[k] && typeof predArt[k] === 'object' && 'raw' in predArt[k]) addTo(art.article, 'extra');
    }
  }
  // Sheet2（金标准 study 段）
  const so = predArt.studyOutcomes ?? {};
  const goldStudy = goldArt.study ?? {};
  const studyMap = {
    primary_outcome: 'primaryOutcome', outcome_pain: 'pain', outcome_nonpain: 'nonPain',
    outcome_function: 'function', outcome_qol: 'qualityOfLife', outcome_events: 'importantEvents',
    outcome_mortality: 'mortality', remarks: 'remarks',
  };
  let studyStat = null;
  for (const [snake, camel] of Object.entries(studyMap)) {
    const gv = goldStudy[snake];
    if (!gv) continue;
    if (isExcluded(id, 'study', snake, gv.raw)) continue;      // 疑似错位 → 不计分，只记录
    studyStat ??= mkStat();
    const predObj = so[camel];
    // Sheet2 是自然语言结局信息 → 交 LLM 判语义，不做字符匹配
    const verdict = shouldJudge('study', gv.raw, predObj?.raw)
      ? enqueueJudge(`${id}/study.${snake}`, 'study', snake, gv.raw, predObj.raw)
      : judgeField(predObj, gv);
    if (verdict === 'judged') continue;
    addTo(studyStat, verdict);
    addTo(fieldStat('study', snake), verdict);
    if ((verdict === 'wrong' || verdict === 'missed') && opt.detail) {
      art.notes.push(`Sheet2.${snake}: 金标准「${String(gv.raw).slice(0, 60)}」 vs 流水线「${so[camel]?.raw?.slice(0, 60) ?? '（缺）'}」`);
    }
  }
  art.study = studyStat ?? mkStat();

  /* ---- 比较组级 ---- */
  const goldCmps = goldArt.comparisons ?? [];
  const predCmps = pred.comparisons ?? [];
  if (goldCmps.length !== predCmps.length) {
    art.notes.push(`比较组数量不符：金标准 ${goldCmps.length} / 流水线 ${predCmps.length}`);
  }
  const nCmp = Math.max(goldCmps.length, predCmps.length);
  for (let i = 0; i < nCmp; i++) {
    const g = goldCmps[i]; const p = predCmps[i];
    if (!g || !p) {
      const scope = g ? 'missed' : 'extra';
      const n = countFieldLeaves(g ?? p) || 1;
      for (let k = 0; k < n; k++) addTo(art.comparison, scope);
      continue;
    }
    for (const [snake, gv] of Object.entries(g)) {
      if (NON_LLM_GOLD.has(snake)) continue;
      if (isExcluded(id, 'comparison', snake, gv.raw)) continue;   // 疑似错位/值不在论文里 → 不计分
      const camel = Object.keys(p).find((k) => camelToSnake(k) === snake);
      const predField = camel ? p[camel] : undefined;
      /*
       * 比较组级的描述性字段（干预方法/对照组/随机方法/分配隐藏/疗程/频次/留针时间…）
       * 同样交语义判定——这里以前直接逐字比对，而金标准常抄整句、机器抄要点，
       * 实测 3,480 组失配里 24% 是"一方包含另一方"（`tools/desc_field_judge.mjs`）。
       */
      /* 带单位的字段先试确定性换算判定；定不下来才走语义判定 */
      const unitHit = unitDecided('comparison', snake, gv.raw, predField?.raw);
      const verdict = unitHit ? (unitHit === 'identical' ? 'hit' : 'code-hit')
        : shouldJudge('comparison', gv.raw, predField?.raw)
          ? enqueueJudge(`${id}/comparison${i}.${snake}`, 'comparison', snake, gv.raw, predField.raw)
          : judgeField(predField, gv);
      if (verdict === 'judged') continue;
      addTo(art.comparison, verdict);
      addTo(fieldStat('comparison', snake), verdict);
      if ((verdict === 'wrong' || verdict === 'missed') && opt.detail) {
        art.notes.push(`比较组${i + 1}.${snake}: 金标准「${String(gv.raw).slice(0, 60)}」 vs 流水线「${camel ? String(p[camel]?.raw).slice(0, 60) : '（缺）'}」`);
      }
    }
  }

  /* ---- 结局级 ---- */
  /*
   * 结局行级错位（整行串篇）：**整行不参与评分**，只记录。
   *
   * 实测 2015-06：金标准名下有两行「2.maximum anxiety / VAS」，但该篇 MinerU 产物里
   * anxiety/VAS 一次都没出现（而 2015-05 里出现 8 次）；那两行的 literature_code 是
   * EN016-xxx（=2015-05），2015-06 自己的行是 EN091-xx。整行错位会被算成"整行没抽到"，
   * 单行 30+ 个叶子全计漏（该篇 74 个漏里 70 个来自这两行）。
   * 检测见 tools/gold_row_anomalies.mjs（判据：结局名实词必须能在本篇里找到）。
   */
  const excludedRowIdx = excludedRowRows.get(id);
  const goldOutsAll = goldArt.outcomes ?? [];
  const goldOuts = excludedRowIdx?.size
    ? goldOutsAll.filter((_, i) => !excludedRowIdx.has(i))
    : goldOutsAll;
  if (excludedRowIdx?.size) {
    const names = [...excludedRowIdx].map((i) => `第 ${i + 1} 行「${goldOutsAll[i]?.outcome?.name?.raw ?? '?'}」`);
    art.notes.push(`金标准错位行已排除（不计分）：${names.join('、')}——该行结局名在本篇里找不到，疑似串篇`);
  }
  const predOuts = pred.outcomes ?? [];
  if (goldOuts.length !== predOuts.length) {
    art.notes.push(`结局数量不符：金标准 ${goldOuts.length} / 流水线 ${predOuts.length}`);
  }
  /* 结局行对齐：文本相似度 + 数值佐证（实现见 tools/lib/align.mjs，与诊断工具共用） */
  const { goldToPred, alignments } = alignOutcomes(goldOuts, predOuts);
  for (const a of alignments) {
    if (a.kind === 'text') outcomeAlignment.textOnly++;
    else if (a.kind === 'numeric') {
      outcomeAlignment.numericCorroborated++;
      outcomeAlignment.note.push(`${id}: 金标准#${a.gi + 1} ↔ 流水线#${a.pi + 1}（重合数值 ${a.corr} 个，文本分 ${a.textScore.toFixed(2)}）`);
    } else outcomeAlignment.weak++;
  }
  if (opt.detail) {
    for (const [gi, g] of goldOuts.entries()) {
      const pi = goldToPred.get(gi);
      const a = alignments.find((x) => x.gi === gi);
      art.notes.push(`对齐：金标准#${gi + 1}「${(g.outcome?.name?.raw ?? '')}/${(g.outcome?.instrument?.raw ?? '')}」→ 流水线#${pi === undefined ? '（无）' : pi + 1}「${pi === undefined ? '' : `${predOuts[pi]?.outcome?.name?.raw ?? ''}/${predOuts[pi]?.outcome?.instrument?.raw ?? ''}`}」${a ? `［文本分 ${a.textScore.toFixed(2)}/数值佐证 ${a.corr}］` : ''}`);
    }
  }

  /*
   * ── 结局层计分：**覆盖率口径**（202609 定稿）──
   *
   * 旧口径是"结局行 1:1 配对"：金标准两行、产物的行只有一行 → 必有一行整行计漏抽；
   * 产物多出来的行全算 extra。这与实际用法不符 —— **多抽的可以人工裁掉，
   * 漏抽的才是硬伤**。实测 1108 个金标准行里只有 775 行能 1:1 配上，而未配上的
   * 333 行里约 42%（按叶子）在产物里其实是有数据的，只是那一行被别的金标准行占了。
   *
   * 因此改成：
   *   · **候选边**：`score ≥ MIN_SCORE`（保留数值佐证），不再要求 1:1；
   *   · **多对一**：一个产物行可以同时供给多个金标准行；
   *   · **要求去重**：同一篇内 (路径 + 值) 相同的金标准要求只计一次
   *     —— 实测 55.3% 的金标准叶子是同一篇内的重复要求（如按组/按臂把同一份数据
   *     列两行），不去重等于"同一份数据答对加一分、答错扣两分"，把口径带偏；
   *   · **产物侧多抽**：不被任何金标准行需要的行记 extra，并计入"人工裁定"队列。
   */
  const nOut = goldOuts.length;
  const adj = goldOuts.map((g) => {
    const list = [];
    for (let j = 0; j < predOuts.length; j++) {
      if (isOutcomeCandidate(g, predOuts[j])) list.push(j);
    }
    return list;
  });
  const neededPred = new Set();
  for (const list of adj) for (const j of list) neededPred.add(j);
  art.outcomeDeferredRows = predOuts.length - neededPred.size;
  for (let j = 0; j < predOuts.length; j++) {
    if (neededPred.has(j)) continue;
    const n = countFieldLeaves(predOuts[j]) || 1;
    for (let k = 0; k < n; k++) addTo(art.outcome, 'extra');
  }
  const flatPred = predOuts.map((p) => new Map(flattenRow(p, ROW_BLOCKS_PRED, camelToSnake)));

  const reqSeen = new Set();
  for (let i = 0; i < nOut; i++) {
    const g = goldOuts[i];
    const cands = adj[i];
    outcomeCoverage.goldRows++;
    outcomeCoverage.goldFields += countFieldLeaves(g);
    if (cands.length) {
      outcomeCoverage.alignedRows++;
      art.outcomeCoveredRows = (art.outcomeCoveredRows ?? 0) + 1;
    }

    for (const [path, gv] of flattenRow(g, ROW_BLOCKS_GOLD, (k) => k)) {
      const { scope, field } = scopeFieldOf(path);
      if (NON_LLM_GOLD.has(field)) continue;
      if (isExcluded(id, scope, field, gv.raw)) continue;   // 值不在论文里/疑似错位 → 不计分
      const rk = `${path}\u0000${normText(gv.raw)}`;
      if (reqSeen.has(rk)) continue;                        // 同一篇内的重复要求只计一次
      reqSeen.add(rk);

      /* 从候选行里取同路径的产物值；有"判等命中"的优先（多对一时取最合适的那一行） */
      let predField;
      for (const j of cands) {
        const v = flatPred[j].get(path);
        if (!v) continue;
        if (!predField) predField = v;
        if (compareValue(v.raw, gv.raw) === 'hit') { predField = v; break; }
      }

      // 时点块内的自然语言字段（如 measurement_range/unit）同样交 LLM 判语义
      const verdict = shouldJudge(scope, gv.raw, predField?.raw)
        ? enqueueJudge(`${id}/${scope}.${field}`, scope, field, gv.raw, predField.raw)
        : judgeField(predField, gv);
      if (verdict === 'judged') continue;
      addTo(art.outcome, verdict);
      addTo(fieldStat(scope, field), verdict);
      if ((verdict === 'wrong' || verdict === 'missed') && opt.detail) {
        art.notes.push(`${scope}.${field}: 金标准「${String(gv.raw).slice(0, 45)}」 vs 流水线「${predField ? String(predField.raw).slice(0, 45) : '（缺）'}」`);
      }
    }
  }

  art.predFields = countFields(pred);
  art.goldFields = countFields(goldArt);
  report.articles.push(art);

  if (!opt.quiet) {
    console.log(`\n──── ${id} ────`);
    console.log(`  文章级  ${fmtPct(art.article).padStart(6)}  ${summaryLine(art.article)}`);
    console.log(`  Sheet2  ${fmtPct(art.study).padStart(6)}  ${summaryLine(art.study)}`);
    console.log(`  比较组  ${fmtPct(art.comparison).padStart(6)}  ${summaryLine(art.comparison)}`);
    console.log(`  结局    ${fmtPct(art.outcome).padStart(6)}  ${summaryLine(art.outcome)}`);
    if (art.notes.length) {
      console.log(`  备注：`);
      for (const n of art.notes.slice(0, opt.detail ? 200 : 6)) console.log(`    · ${n}`);
      if (!opt.detail && art.notes.length > 6) console.log(`    · …共 ${art.notes.length} 条（--detail 查看全部）`);
    }
  }
}

function summaryLine(s) {
  return `命中 ${s.hit} / 编码命中 ${s['code-hit']} / 错 ${s.wrong} / 漏 ${s.missed}${s.extra ? ` / 多 ${s.extra}` : ''}`;
}

function countFields(node) {
  let n = 0;
  const walk = (o) => {
    if (o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.raw === 'string' && 'evidence' in o) { n++; return; }
    Object.values(o).forEach(walk);
  };
  walk(node);
  return n;
}

/* ------------------------------ 语义判定（Sheet2 / Sheet3 的自然语言部分） ------------------------------ */

let judgeResults = [];
if (judgeQueue.length) {
  const cfgPath = join(ROOT, 'runtime', 'llm.local.json');
  let cfg = {};
  if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* 忽略 */ } }
  const apiKey = process.env.DEEPSEEK_API_KEY ?? cfg.apiKey;
  if (!apiKey) {
    console.log(`\n  ⚠ ${judgeQueue.length} 组待语义判定，但未配置 API key（跳过，按"未判定"计）`);
  } else {
    process.stdout.write(`\n  语义判定 ${judgeQueue.length} 组（LLM 批量，带缓存）…`);
    judgeResults = await judgePairs(judgeQueue, {
      apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      model: process.env.AA_JUDGE_MODEL ?? cfg.model,
      batchSize: 8,
      onProgress: (m) => console.log(m),
    });
    for (const r of judgeResults) {
      judgeStat[r.verdict] = (judgeStat[r.verdict] ?? 0) + 1;
      addTo(fieldStat('judged', r.field), r.verdict === 'identical' || r.verdict === 'same_meaning' ? 'hit'
        : r.verdict === 'contains_correct' ? 'code-hit'
          : r.verdict === 'unknown' ? 'extra' : 'wrong');
    }
    console.log(' 完成');
  }
}

/* ------------------------------ 汇总 ------------------------------ */

const total = { article: mkStat(), study: mkStat(), comparison: mkStat(), outcome: mkStat() };
for (const a of report.articles) for (const k of Object.keys(total)) {
  for (const [v, c] of Object.entries(a[k])) total[k][v] = (total[k][v] ?? 0) + c;
}

console.log(`\n══════ ${opt.year} 汇总（${report.articles.length} 篇） ══════`);
for (const [k, label] of [['article', '文章级'], ['study', 'Sheet2'], ['comparison', '比较组'], ['outcome', '结局']]) {
  console.log(`  ${label.padEnd(4)} 准确率 ${fmtPct(total[k]).padStart(6)}   ${summaryLine(total[k])}   （严格字符匹配口径）`);
}

/*
 * 语义判定口径：Sheet2/Sheet3 的金标准是**无法标准化的自然语言结局信息**，
 * 严格字符匹配必然低估。因此这两处的自然语言字段改为 LLM 判定，
 * 得分权重：完全一致=1、含义一致=1、包含正确信息=0.5、存在错误/完全不一致=0。
 */
if (judgeResults.length) {
  const judgedTotal = judgeResults.length;
  const weighted = judgeResults.reduce((acc, r) => acc + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
  console.log(`\n  ── 语义判定口径（Sheet2 / Sheet3 的自然语言字段，共 ${judgedTotal} 组）──`);
  for (const [v, label] of Object.entries(VERDICT_LABEL)) {
    const n = judgeStat[v] ?? 0;
    if (n) console.log(`    ${label.padEnd(6)} ${String(n).padStart(3)}  (${((n / judgedTotal) * 100).toFixed(0)}%)`);
  }
  console.log(`    加权得分 ${(weighted).toFixed(1)} / ${judgedTotal} = ${((weighted / judgedTotal) * 100).toFixed(1)}%`);
}

/* ------------------------------ 按金标准工作表汇总（Sheet1 / 2 / 3） ------------------------------ */

/*
 * 与数据集的三张表对齐（用户与标注者的心智模型）：
 *   Sheet1 = 文章级字段 + 比较组级字段（每行一个研究 / 一个比较组）
 *   Sheet2 = 文章的结局分类（疼痛/非疼痛症状/功能/生活质量/重要事件/死亡率）
 *   Sheet3 = 结局 × 时点的数值
 *
 * 口径说明：
 *   · 编码/数值字段走严格比较（可判定），Sheet2/Sheet3 的自然语言字段走 LLM 语义判定；
 *   · 一层的准确率 = (严格命中 + 严格编码命中 + 语义加权分) / (严格分母 + 语义组数)；
 *   · 已被判定为"错位/值不在论文里"的字段不计分（只记录）。
 */
/*
 * ⚠️ 分组必须按**前缀**做三分，不能二分。
 *
 * 这里原来写的是 `judgedOutcome = judgeResults.filter(r => !r.field.startsWith('study.'))`，
 * 于是 `article.*` 与 `comparison.*` 的语义判定条目被**并进了 Sheet3**——
 * 实测 2015 年 Sheet3 的 224 条语义条目里有 **158 条（70%）本属 Sheet1**
 * （44 条 `article.*` + 114 条 `comparison.*`）。
 * 后果是双重的：Sheet3 被污染，而 Sheet1 的 `judged` 是空数组、只剩下严格可比字段。
 */
const judgedStudy = judgeResults.filter((r) => r.field.startsWith('study.'));
const judgedSheet1 = judgeResults.filter((r) => /^(article|comparison)\./.test(r.field));
const judgedOutcome = judgeResults.filter(
  (r) => !r.field.startsWith('study.') && !/^(article|comparison)\./.test(r.field),
);
const wsum = (list) => list.reduce((s, r) => s + (VERDICT_WEIGHT[r.verdict] ?? 0), 0);
const denomOf = (s) => s.hit + s['code-hit'] + s.wrong + s.missed;
const numOf = (s) => s.hit + s['code-hit'];

const sheet = (label, stat, judged) => {
  const num = numOf(stat) + wsum(judged);
  const den = denomOf(stat) + judged.length;
  const rate = den ? (num / den) * 100 : 0;
  console.log(
    `  ${label.padEnd(26)} 准确率 ${rate.toFixed(1).padStart(5)}%   ` +
    `（严格 ${numOf(stat)}/${denomOf(stat)}${judged.length ? ` + 语义 ${wsum(judged).toFixed(1)}/${judged.length}` : ''}，` +
    `漏 ${stat.missed}，多 ${stat.extra}）`,
  );
  return { label, num, den, rate, strict: stat, judged };
};

console.log(`\n  ── 按金标准工作表汇总 ──`);
const sheet1 = sheet('Sheet1（文章级+比较组）', {
  hit: total.article.hit + total.comparison.hit,
  'code-hit': total.article['code-hit'] + total.comparison['code-hit'],
  wrong: total.article.wrong + total.comparison.wrong,
  missed: total.article.missed + total.comparison.missed,
  extra: total.article.extra + total.comparison.extra,
}, judgedSheet1);
const sheet2 = sheet('Sheet2（结局分类）', total.study, judgedStudy);
const sheet3 = sheet('Sheet3（结局×时点）', total.outcome, judgedOutcome);
report.sheets = { sheet1, sheet2, sheet3 };

if (excludedHits.length) {  console.log(`\n  ── 疑似错位金标准：${excludedHits.length} 个字段值不参与评分 ──`);
  const uniq = [...new Set(excludedHits)].slice(0, 8);
  for (const u of uniq) console.log(`    ${u}`);
  if (excludedHits.length > uniq.length) console.log(`    …共 ${excludedHits.length} 个（明细见 build/gold_anomalies.json）`);
}

/* 最差的字段（帮助定位要改的提示词/规则） */
const worst = [...byField.entries()]
  .map(([key, s]) => ({ key, s, n: s.hit + s['code-hit'] + s.wrong + s.missed, rate: pct(s) }))
  .filter((x) => x.n >= Math.max(2, report.articles.length))
  .sort((a, b) => a.rate - b.rate)
  .slice(0, 20);

/*
 * 结局层的第二口径：**覆盖率**。
 *
 * 为什么需要它：严格准确率把"多抽的结局"整行算进"多"、"少抽的金标准行"整行算进"漏"，
 * 于是条数对齐主导了分数——而条数取决于金标准的取舍习惯（实测 2015-01 的论文自己那句
 * 549 字的 secondary outcomes 声明里列了 7 个指标，金标准只收其中 3 个），
 * 这个取舍无法从文本唯一确定。
 * 覆盖率回答的是另一个问题：**金标准里的每一条结局、每一个数值，我们抽到了没有？**
 * 这对"能不能用于系统评价"更有意义（多抽的可以人工裁掉，漏抽的才是硬伤）。
 */
console.log(`\n  ── 结局层覆盖率（另一个口径）──`);
const rowRate = outcomeCoverage.goldRows ? (outcomeCoverage.alignedRows / outcomeCoverage.goldRows) * 100 : 0;
console.log(`    金标准结局行被覆盖：${outcomeCoverage.alignedRows}/${outcomeCoverage.goldRows}（${rowRate.toFixed(0)}%）`);
console.log(`    （严格准确率仍按上面的口径计算；两者并列看，避免被"条数对齐"单方面主导）`);

/*
 * 对齐口径披露。
 * 「靠数值佐证配上的对」会用到被评分的数值本身（如金标准 est −41 对上流水线 −41），
 * 因此这一部分必须单列：它改善的是"行有没有配对"，不是"值有没有抽对"。
 */
console.log(`\n  ── 结局行对齐方式（口径披露）──`);
console.log(`    纯文本配上 ${outcomeAlignment.textOnly} 对 / 靠数值佐证配上 ${outcomeAlignment.numericCorroborated} 对 / 弱对齐 ${outcomeAlignment.weak} 对`);
for (const n of outcomeAlignment.note) console.log(`      · ${n}`);

console.log(`\n  ── 准确率最低的字段（出现 ≥${Math.max(2, report.articles.length)} 次）──`);for (const w of worst) console.log(`    ${w.rate.toFixed(0).padStart(3)}%  ${w.key.padEnd(46)} ${summaryLine(w.s)}`);

/* 完全命中 / 完全错的字段数 */
const perfect = [...byField.entries()].filter(([, s]) => s.wrong === 0 && s.missed === 0 && (s.hit + s['code-hit']) > 0);
const zero = [...byField.entries()].filter(([, s]) => s.hit === 0 && s['code-hit'] === 0 && (s.wrong + s.missed) > 0);
console.log(`\n  字段总数 ${byField.size}：全对 ${perfect.length} / 全错(含漏) ${zero.length}`);

report.total = total;
report.byField = Object.fromEntries([...byField.entries()].map(([k, v]) => [k, v]));
/* 语义判定明细（本次评测的，不是缓存里的历史对）——用于按字段/按篇回溯 */
report.judged = judgeResults.map((r) => ({
  key: r.key, field: r.field, verdict: r.verdict,
  gold: r.gold.slice(0, 200), pred: r.pred.slice(0, 200),
  ...(r.reason ? { reason: r.reason } : {}),
}));
report.judgeStat = judgeStat;
report.excludedMisaligned = [...new Set(excludedHits)];
report.outcomeAlignment = {
  textOnly: outcomeAlignment.textOnly,
  numericCorroborated: outcomeAlignment.numericCorroborated,
  weak: outcomeAlignment.weak,
  note: outcomeAlignment.note,
};
const outDir = join(ROOT, 'build', 'eval');
mkdirSync(outDir, { recursive: true });
/*
 * ⚠️ `--only` 是"单篇问诊"用的：只评几篇。
 * 若仍写 `build/eval/<year>.json`，会把该年的**全量**报告覆盖成只含这几篇的小报告，
 * 而 `report_clinicians.mjs` 正是按年份文件统计的——静默把整体数字改小。
 * 因此 --only 时另写一个文件名，绝不动全量报告。
 */
const outFile = join(outDir, opt.only.length ? `${opt.year}-only.json` : `${opt.year}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  报告 ${outFile.replace(ROOT + '\\', '')}\n`);
