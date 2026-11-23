import fs from 'node:fs';
import { join } from 'node:path';
import { createDeepSeekLlm, createArticleMetaSkill, createStudyPlanSkill, createComparisonSkill, legendFor } from '../../packages/skills/dist/index.js';
import { ingest } from '../../packages/ingest/dist/index.js';
import { readParticipantFlow } from './participant-flow.mjs';
import { resolveWorkflowUnit } from './workflow-units.mjs';
import { mergeResultRecord } from './workflow-records.mjs';
import { outcomeMaterials, fieldReviewTarget, reviewSummaryFields } from './workflow-summary-review.mjs';
import { finalReviewSnapshot, canReviewSummary, reviewFinalRecords } from './workflow-final-review.mjs';
import { mergeCandidates } from './workflow-candidates.mjs';
import { loadLlmConfig } from './llm-config.mjs';
import { ARTICLE_FIELDS, COMPARISON_FIELDS } from '../canonical-field-map.mjs';
import { readWorkflowMaterials, renderBlock, groundSource, numericSourceTokens } from './workflow-materials.mjs';
import { readWorkflow, saveWorkflow, atomicJson, studyDirectory, withStudyLock, fingerprint, effectiveRecords } from './workflow-store.mjs';

const candidatePrompt = '你是临床试验结局识别员。完整列出正文与附表中报告或明确测量的所有结局候选，供医生人工勾选。'
 + '包括主要、次要、探索性、功能、症状、生活质量、生理指标、医疗使用、过程结局、不良事件及各量表分域。禁止因为没有“primary/secondary”措辞或不属于某分类而省略。'
 + 'domain 仅填写量表的具体分域名称，未细分的结局填空字符串，禁止写一般功能分类或说明句。量表总分和各分域分别列出，例如 WOMAC pain、stiffness、physical function。不要将不同量表合成一个候选。同一结局的比较组和时间点在一个候选中列全。'
 + '保留原文名称与缩写，name 使用论文语言，不翻译。返回 JSON {candidates:[{name,instrument,domain,primary,reportedTimes:[],sources:[{block,quote}]}]}。'
 + '每个候选至少一个逐字来源。block 原样取材料 [[...]] 内的标识，不含方括号，quote 逐字复制。没提供具体数值但引用附表的结局也应保留。';
const numericKeys = ['estimate', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper', 'events', 'n'];
const summaryPrompt = '你是临床试验数据提取员。只汇总指定的一个结局，识别并逐项列出正文与附件中所有报告时点、试验臂、对照臂及比较。'
 + '每个量表分域独立，禁止拿其他量表或分域代替。每个时间窗、绝对值、较基线变化和组间差独立。只按原文明示的试验臂取数，禁止擅自合并。共享对照仅以其原文明示名称记录。'
 + '返回 JSON {records:[{group,comparison,time,estimand,statistic,unit:{value,source:{block,quote}},scopeSource:{block,quote},values:{estimate:{value,source:{block,quote,row,column}},sd:{value,source},se:{value,source},ciLower:{value,source},ciUpper:{value,source},iqrLower:{value,source},iqrUpper:{value,source},events:{value,source},n:{value,source}}}],unreported:[],notes:[]}。'
 + 'unit 必须查本结局自己的行标题、列标题、脚注或方法定义，返回原文单位及逐字来源。找不到填 NR，明确不适用填 NA，材料不足填 NE；不能把样本量 n 作为均值单位。原文 points、mL、VMS/day 等保留原写法。原文把该数值写作量表 score 或分数时，摘录该结局原文中的 score、分等词及来源，程序统一将规范单位记为 NA。若明确以 mm 或 cm 报告，保留该单位。不换算数值；% 与比例不能混用。OR/RR/HR 为无量纲，不能沿用原测量值的物理单位。'
 + 'statistic 取 mean、median、difference、OR、RR、HR、rate、events。estimand 保留 absolute 或 change from baseline 或 between-group difference 等原文口径。'
 + 'group、comparison、time 必须原文可定位。scopeSource 引用能确认结局、分域、时点及组别的表格行/表头或正文。'
 + '每个数值逐字引用自己的源单元格。均值及 SD/SE、点估计及区间边界的 source.quote 必须使用同一个包含完整数值组合的单元格或原文句子。row/column 仅用于 mineru 网格，1 基。上下限必须属于同一估计。SD、SE 各单值，CI 两界，IQR 两界；未报告的键省略，禁止填 NR/NE 等哨兵到数值。'
 + 'block 原样取 [[...]] 中标识。value 只写数字，quote 原样复制。不同 PDF 的来源不能混用。原文数字排版冲突或证据不够时放 notes。'
 + '只引用附表但缺失附表时放 unreported，不能取其他表格的近似数值。IQR 的点估计不必落于 CI 规则，CI 要验证上下限。';
function chunks(blocks, limit = 22000) {
  const result = [];
  let group = [], size = 0;
  for (const block of blocks) {
    const text = renderBlock(block, 13000);
    if (group.length && size + text.length > limit) { result.push(group); group = []; size = 0; }
    group.push(block); size += text.length;
  }
  if (group.length) result.push(group);
  return result;
}
function basicFields(basic) {
  const fields = [];
  const labels = new Map([...ARTICLE_FIELDS, ...COMPARISON_FIELDS].map(f => [f.key, f.label]));
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.raw === 'string') { fields.push({ path, label: labels.get(path.split('.').at(-1)) ?? path.split('.').at(-1), ...node }); return; }
    for (const [key, value] of Object.entries(node)) if (key !== 'missingData') walk(value, path ? path + '.' + key : key);
  }
  walk(basic.article, 'article');
  walk(basic.comparisons, 'comparisons');
  return fields;
}
export function validateResultRecord(materials, candidate, item) {
  const issues = [], values = {}, evidence = {};
  const scope = groundSource(materials, item.scopeSource);
  if (!scope || !String(item.group ?? '').trim()) return { rejected: '缺少结局组别来源', raw: item };
  if (!String(item.time ?? '').trim()) issues.push('原文未明确时点，请核对');
  else if (!/baseline|pre[- ]?treatment|post|before|after|during|follow|end|completion|week|month|day|hour|minute|year|\bwk\b|\bmo\b|\bT\d+\b|基线|治疗|随访|周|月|天|日|小时/i.test(String(item.time))) {
    issues.push('报告时点表述不能确认，请核对');
  }

  for (const key of numericKeys) {
    const claim = item.values?.[key];
    if (!claim || claim.value === undefined || claim.value === null || String(claim.value).trim() === '') continue;
    const raw = String(claim.value).trim().replace(/[−–]/g, '-');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      issues.push(key + ' 数值格式无法确认'); continue;
    }
    const source = groundSource(materials, claim.source, raw);
    if (!source) { issues.push(key + ' 来源无法定位'); continue; }
    values[key] = raw; evidence[key] = source;
    const nativePage = materials.blocks.find(block => block.type === 'native' && block.documentId === source.documentId && block.page === source.page);
    if (nativePage) {
      const numbers = numericSourceTokens(nativePage.text);
      if (!numbers.includes(Number(raw))) issues.push(key + ' 未在同页 PDF 原生文字找到，可能有跨页或符号编码差异，请核对');
    }
  }
  const sourcePair = keys => {
    const sources = keys.map(key => evidence[key]).filter(Boolean);
    if (sources.length !== keys.length) return false;
    const first = sources[0];
    return sources.every(s => s.documentId === first.documentId && s.page === first.page && s.blockId === first.blockId
      && (first.row ? s.row === first.row && s.column === first.column : s.quote === first.quote));
  };
  for (const key of ['sd', 'se']) {
    if (values[key] && (Number(values[key]) < 0 || !sourcePair(['estimate', key]))) {
      delete values[key]; delete evidence[key]; issues.push(key + ' 未与同一估计来源对齐');
    }
  }
  const dispersionQuote = String(evidence.sd?.quote ?? evidence.se?.quote ?? '').normalize('NFKC').replace(/[−–]/g, '-').trim();
  const plusMinus = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*±\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(dispersionQuote);
  if (plusMinus && values.estimate && (Number(values.estimate) !== Number(plusMinus[1]) || Number(values.sd ?? values.se) !== Number(plusMinus[2]))) {
    return { rejected: '均值和离散度与原文 ± 两侧的数值次序不符', raw: item };
  }
  if (values.sd && values.se) { delete values.se; delete evidence.se; issues.push('同时返回 SD 与 SE，需核对类型'); }
  for (const pair of [['ciLower', 'ciUpper'], ['iqrLower', 'iqrUpper']]) {
    const [lower, upper] = pair;
    if (!(lower in values || upper in values)) continue;
    const ci = lower === 'ciLower';
    const invalid = !values[lower] || !values[upper] || Number(values[lower]) > Number(values[upper])
      || !sourcePair(values.estimate ? ['estimate', lower, upper] : [lower, upper])
      || ci && values.estimate !== undefined && (Number(values.estimate) < Number(values[lower]) || Number(values.estimate) > Number(values[upper]));
    if (invalid) {
      delete values[lower]; delete values[upper]; delete evidence[lower]; delete evidence[upper];
      issues.push(pair.join('/') + ' 区间或同源关系待核对');
    }
  }
  if (values.events !== undefined && (!Number.isSafeInteger(Number(values.events)) || Number(values.events) < 0)) {
    delete values.events; issues.push('事件数非法');
  }
  if (values.n !== undefined && (!Number.isSafeInteger(Number(values.n)) || Number(values.n) <= 0
    || values.events !== undefined && Number(values.events) > Number(values.n))) {
    delete values.n; issues.push('分母或事件范围待核对');
  }
  if (!Object.keys(values).length) return { rejected: '所有数值均缺少可验证来源', raw: item };
  if (values.estimate && !['sd', 'se', 'ciLower', 'iqrLower'].some(key => values[key]) && /±/.test(evidence.estimate?.quote ?? '')) {
    issues.push('原表含离散度，本条尚未确认其类型或数值');
  }
  const pointSource = evidence.estimate ?? evidence.events;
  if (pointSource?.row && pointSource.column) {
    const pointBlock = materials.blocks.find(b => b.id === pointSource.blockId);
    const headerCells = pointBlock?.grid?.slice(0, Math.min(pointSource.row - 1, 4)).map(row => row[pointSource.column - 1] ?? '') ?? [];
    const namedHeader = /\b(?:group|arm|control|sham|EA|SA|acupuncture|electroacupuncture|exercise|treatment|Hz|placebo|intervention|experimental)\b/i;
    const header = headerCells.filter(cell => namedHeader.test(cell)).join(' ');
    const rowHeader = pointBlock?.grid?.[pointSource.row - 1]?.[0] ?? '';
    if (candidate.domain) {
      const domains = [
        ['pain', /\bpain\b/i], ['stiffness', /\bstiffness\b/i],
        ['physical function', /physical function/i], ['anxiety', /\banxiety\b/i],
        ['depression', /depress/i], ['sleep', /\bsleep\b/i],
        ['somatic', /\bsomatic\b/i], ['memory', /\bmemory\b/i],
      ];
      const expected = domains.filter(([,pattern]) => pattern.test(candidate.domain)).map(([label]) => label);
      const actual = domains.filter(([,pattern]) => pattern.test(rowHeader)).map(([label]) => label);
      if (expected.length && actual.length && !actual.some(label => expected.includes(label))) {
        return { rejected: '源数值所属量表分域与选中分域不一致', raw: item };
      }
    }
    const simplify = s => String(s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/\bgroup\b/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    const groupKey = simplify(item.group);
    const hasNamedColumn = /\b(?:group|arm|control|sham|EA|SA|acupuncture|electroacupuncture|exercise|treatment|Hz|placebo|intervention|experimental)\b/i.test(header);
    const groupHeaders = hasNamedColumn ? [header] : [rowHeader];
    const matches = groupHeaders.some(label => {
      const key = simplify(label);
      if (/^\d+$/.test(groupKey)) return key === groupKey;
      return key === groupKey || key.length > 2 && groupKey.length > 2 && (key.includes(groupKey) || groupKey.includes(key));
    });
    const contrast = /^(difference|OR|RR|HR)$/i.test(String(item.statistic)) || /between[- ]group/i.test(String(item.estimand));
    const contrastColumn = /difference|ratio|\bvs\.?\b|\b(?:OR|RR|HR)\b/i.test(headerCells.join(' '));
    if (groupKey && !matches && !(contrast && contrastColumn)) return { rejected: '试验臂名称与源单元格的行列标题未对齐', raw: item };
  }
  const scopeBlock = materials.blocks.find(b => b.id === scope.blockId);
  const headingText = (scopeBlock?.caption ?? '') + '\n' + (scopeBlock?.grid?.slice(0, 5).flat().join(' ') ?? '') + '\n' + (scopeBlock?.text ?? '');
  const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // Outcome anchoring requires explicit instrument, name or a cited candidate source block.
  const instrument = candidate.instrument?.split(':')[0].trim();
  const candidateLinked = candidate.evidence?.some(e => e.blockId === scope.blockId);
  const nameTokens = String(candidate.name).split(/\s+/).filter(s => s.length > 3);
  const enoughWords = nameTokens.filter(s => normalize(headingText).includes(normalize(s))).length >= Math.min(2, nameTokens.length);
  if (!candidateLinked && !(instrument && normalize(headingText).includes(normalize(instrument))) && !(nameTokens.length && enoughWords)) {
    return { rejected: '取数来源未与选中结局或量表相符', raw: item };
  }
  const unit = resolveWorkflowUnit(materials, candidate, item, pointSource, scope, issues);
  const identity = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[−–]/g, '-').replace(/\s+/g, '');
  const contrastRecord = /^(difference|OR|RR|HR)$/i.test(String(item.statistic)) || /between[- ]group/i.test(String(item.estimand));
  return {
    id: fingerprint([candidate.id, identity(item.group), contrastRecord ? identity(item.comparison) : '', identity(item.time), identity(item.estimand), identity(item.statistic), scope.documentId]).slice(0, 24),
    candidateId: candidate.id, outcome: candidate.name, instrument: candidate.instrument ?? '', domain: candidate.domain ?? '',
    group: String(item.group), comparison: String(item.comparison ?? ''), time: String(item.time ?? 'not_reported'),
    estimand: String(item.estimand ?? ''), statistic: String(item.statistic ?? ''),
    values, evidence, unit, scopeSource: scope, issues, status: issues.length ? 'needs_review' : 'reported',
  };
}
export async function runWorkflowStage(root, year, study, stage, options = {}) {
  if (!['basic', 'candidates', 'summary', 'review'].includes(stage)) throw new Error('未知工作流阶段');
  return withStudyLock(root, year, study, async () => {
    const state = readWorkflow(root, year, study);
    if (stage === 'summary' && options.selectionRevision !== undefined && options.selectionRevision !== state.selection.revision) throw new Error('选择版本已改变，请重新启动汇总');
    if (stage === 'summary' && !state.selection.candidateIds.length) throw new Error('请先选择并保存结局');
    if (stage === 'review') {
      if (options.selectionRevision !== undefined && options.selectionRevision !== state.selection.revision) throw new Error('结局选择已更新，请重新汇总');
      if (!canReviewSummary(state)) throw new Error('请先汇总当前所选结局');
    }
    if (stage !== 'basic' && !state.basic) throw new Error('请先提取基础字段');
    const dir = studyDirectory(root, year, study);
    const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + stage;
    const startedAt = new Date().toISOString();
    state.stages[stage] = { status: 'running', pid: process.pid, runId, startedAt, completed: 0, total: 0 };
    saveWorkflow(root, state);
    const log = message => { console.log(message); state.stages[stage].message = message; saveWorkflow(root, state); };
    const calls = [];
    try {
      const materials = await readWorkflowMaterials(root, year, study);
      if ((stage === 'summary' || stage === 'review') && state.candidateFingerprint !== materials.fingerprint) throw new Error('原文或候选已改变，请重新生成候选并确认选择');
      state.sources = materials.sources;
      state.materialFingerprint = materials.fingerprint;
      state.warnings = materials.warnings;
      const cfg = options.llm ? null : loadLlmConfig(root);
      const model = stage === 'review' ? cfg?.reviewModel : cfg?.model;
      const stageEffort = cfg?.reasoningStages[stage] ?? undefined;
      const difficultEffort = cfg?.reasoningStages.difficult ?? null;
      const baseLlm = options.llm ?? createDeepSeekLlm({
        ...cfg, model, reasoningEffort: stageEffort, maxTokens: stage === 'review' ? 5000 : stage === 'candidates' ? 5000 : stage === 'summary' ? 6500 : 8000, timeoutMs: options.timeoutMs ?? 150000, retries: 1,
        onCall: info => {
          calls.push({ tag: info.tag, ok: info.ok, ms: info.ms, usage: info.usage, reasoningEffort: info.reasoningEffort });
          console.log(info.ok ? 'API 完成 ' + info.tag : 'API 调用失败 ' + info.tag);
        },
      });
      const modelSettings = {
        model: model ?? 'test',
        baseUrl: cfg?.baseUrl ?? '',
        ...(stageEffort ? { reasoningEffort: stageEffort } : {}),
      };
      const cacheDir = join(root, 'build', 'workflow-llm-cache');
      const llm = { invoke: async request => {
        const key = fingerprint({ version: 3, ...modelSettings, request });
        const file = join(cacheDir, key + '.json');
        if (!options.fresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).response;
        if (options.offline) throw new Error('没有本地缓存响应，请在线重试此任务');
        const response = await baseLlm.invoke(request);
        atomicJson(file, { at: new Date().toISOString(), request, response });
        return response;
      } };
      if (stage === 'basic') {
        if (options.reuseBasics) {
          const source = join(root, 'build', 'extraction', year, study + '.json');
          if (!fs.existsSync(source)) throw new Error('找不到已有基础字段');
          const old = JSON.parse(fs.readFileSync(source, 'utf8'));
          state.basic = {
            article: old.article, comparisons: old.comparisons, studyPlan: old.pipeline?.studyPlan,
            importedFrom: source, at: startedAt, status: 'imported',
          };
        } else {
          let doc;
          try { doc = ingest({ rootDir: root, year, studyId: study }).doc; }
          catch {
            doc = {
              articleId: study, year, sourcePdf: materials.sources[0].path, mineruDir: '', schemaVersion: 'AA_MINIDOC/1.0',
              blocks: materials.blocks.map((b, index) => ({ index, page: b.page, text: b.text, bbox: b.bbox,
                type: b.grid ? 'table' : 'text', section: b.page <= 2 ? 'abstract' : 'methods',
                ...(b.grid ? { table: { grid: b.grid, html: '', caption: b.caption } } : {}) })),
              pages: [], stats: { totalBlocks: materials.blocks.length, pagesCovered: 0, tables: 0, figures: 0, equations: 0, droppedNoise: 0 },
              warnings: materials.warnings,
            };
          }
          log('读取受试者流程图及本地识别缓存');
          const flow = await readParticipantFlow(root, doc);
          doc = flow.doc;
          state.warnings.push(...flow.warnings);
          const ctx = { doc, llm, log, legend: { get: (_level, field) => legendFor(field)?.legend } };
          log('提取文献及研究基础信息');
          const article = await createArticleMetaSkill().run(ctx);
          log('识别试验组和对照组');
          const plan = await createStudyPlanSkill().run(ctx);
          if (!plan.payload?.comparisons?.length) throw new Error('未能识别比较组，请核对基础信息后重试');
          const comparisons = await createComparisonSkill({
            plannedComparisons: plan.payload.comparisons.map(p => ({ intervention: p.intervention?.raw ?? '', control: p.control?.raw ?? '' })),
          }).run(ctx);
          if (calls.length && !calls.some(c => c.ok)) throw new Error('基础信息 API 调用全部失败');
          state.basic = { article: article.payload, comparisons: comparisons.payload.comparisons, studyPlan: plan.payload, at: startedAt,
            issues: [...article.issues, ...plan.issues, ...comparisons.issues], status: 'extracted' };
        }
        state.basic.fields = basicFields(state.basic);
        for (const key of Object.keys(state.confirmations ?? {})) if (key.startsWith('basic:')) delete state.confirmations[key];
        log('基础字段已保存');
      }
      if (stage === 'candidates') {
        const groups = chunks(materials.blocks);
        const candidates = [];
        const errors = [];
        state.stages.candidates.total = groups.length;
        const processChunk = async (blocks, i) => {
          log('识别候选材料 ' + (i + 1) + '/' + groups.length);
          try {
            const response = await llm.invoke({
              system: candidatePrompt, user: blocks.map(b => renderBlock(b, 13000)).join('\n\n'),
              temperature: 0, tag: 'workflow-candidates:' + study + ':' + (i + 1),
            });
            if (!Array.isArray(response.json?.candidates)) throw new Error('未返回候选列表');
            for (const item of response.json.candidates) {
              if (!String(item.name ?? '').trim()) continue;
              const evidence = (item.sources ?? []).map(source => groundSource(materials, source)).filter(Boolean);
              if (!evidence.length) { errors.push('候选缺少可定位证据：' + item.name); continue; }
              const signature = [item.name, item.instrument ?? '', item.domain ?? ''].map(s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
              const id = 'candidate-' + fingerprint(signature).slice(0, 24);
              const present = candidates.find(c => c.id === id);
              if (present) { present.evidence.push(...evidence); continue; }
              candidates.push({
                id, name: String(item.name).trim(), instrument: String(item.instrument ?? '').trim(),
                domain: String(item.domain ?? '').trim(), primary: item.primary === true,
                reportedTimes: Array.isArray(item.reportedTimes) ? item.reportedTimes.map(String) : [],
                evidence, origin: 'model', sourceStatus: 'reported',
              });
            }
          } catch (error) { errors.push('材料 ' + (i + 1) + '：' + error.message); }
          state.stages.candidates.completed++;
          saveWorkflow(root, state);
        };
        let nextCandidateChunk = 0;
        const candidateWorker = async () => {
          while (nextCandidateChunk < groups.length) {
            const i = nextCandidateChunk++;
            await processChunk(groups[i], i);
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, groups.length) }, candidateWorker));
        if (!candidates.length) throw new Error('未得到可定位的候选结局：' + errors.slice(0, 3).join('；'));
        const manual = state.candidates.filter(c => c.origin === 'human');
        const oldSelection = structuredClone(state.selection);
        state.candidateFingerprint = materials.fingerprint;
        state.candidates = [...mergeCandidates(candidates), ...manual];
        state.selection.candidateIds = oldSelection.candidateIds.filter(id => state.candidates.some(c => c.id === id));
        state.selection.revision++;
        state.stages.summary = { status: state.result ? 'stale' : 'idle' };
        state.stages.candidates.errors = errors;
        state.stages.candidates.status = errors.length ? 'partial' : 'done';
      }
      if (stage === 'summary') {
        const selected = state.candidates.filter(c => state.selection.candidateIds.includes(c.id));
        const revision = state.selection.revision;
        const previous = state.result;
        const records = [], outcomes = [];
        let queue = 0;
        state.stages.summary.total = selected.length;
        async function worker() {
          while (queue < selected.length) {
            const candidate = selected[queue++];
            const checkpoint = join(dir, 'checkpoints', fingerprint([materials.fingerprint, revision, candidate.id, 17, modelSettings, cfg?.wireApi, cfg?.adaptiveReasoning, difficultEffort]) + '.json');
            let output;
            if (!options.fresh && fs.existsSync(checkpoint)) output = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
            else {
              const groups = chunks(outcomeMaterials(materials, candidate), 26000);
              const local = [], rejected = [], errors = [], unreported = [], accepted = [], targets = [];
              for (const [i, blocks] of groups.entries()) {
                try {
                  const response = await llm.invoke({
                    system: summaryPrompt,
                    user: '选中结局：' + JSON.stringify({ name: candidate.name, instrument: candidate.instrument, domain: candidate.domain })
                      + '\n\n' + blocks.map(b => renderBlock(b, 13000)).join('\n\n'),
                    temperature: 0, tag: 'workflow-summary:' + study + ':' + candidate.id + ':' + (i + 1),
                  });
                  if (!Array.isArray(response.json?.records)) throw new Error('响应不含 records 数组');
                  for (const item of response.json.records) {
                    const result = validateResultRecord(materials, candidate, item);
                    if (result.rejected) rejected.push(result);
                    else {
                      accepted.push(result);
                      if (cfg?.adaptiveReasoning && targets.length < 6) {
                        const target = fieldReviewTarget(item, result, blocks);
                        if (target) targets.push({ ...target, recordIndex: accepted.length - 1 });
                      }
                    }
                  }
                  unreported.push(...(response.json.unreported ?? []), ...(response.json.notes ?? []));
                } catch (error) { errors.push(error.message); }
              }
              if (targets.length) {
                try {
                  log('疑难字段复核：' + candidate.name + '（' + targets.length + '条待核对记录）');
                  const repairs = await reviewSummaryFields({
                    materials, candidate, targets, llm, validate: validateResultRecord,
                    tag: 'workflow-summary-review:' + study + ':' + candidate.id,
                    reasoningEffort: difficultEffort,
                  });
                  for (const [index, record] of repairs) accepted[targets[index].recordIndex] = record;
                } catch (error) {
                  unreported.push({ reason: '疑难字段复核未完成，保留已定位的数值：' + error.message });
                }
              }
              for (const record of accepted) mergeResultRecord(local, record);
              output = { candidateId: candidate.id, records: local, rejected, errors, unreported,
                status: errors.length ? 'failed' : local.length && !rejected.length && local.every(record => record.status === 'reported') ? 'done' : 'needs_review' };
              if (!errors.length && local.length) atomicJson(checkpoint, output);
            }
            records.push(...output.records);
            outcomes.push(output);
            state.stages.summary.completed++;
            log('已汇总 ' + state.stages.summary.completed + '/' + selected.length + '：' + candidate.name);
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, selected.length) }, worker));
        for (const record of previous?.records ?? []) if (state.confirmations) delete state.confirmations[record.id];
        state.result = {
          runId, at: new Date().toISOString(), selectionRevision: revision, materialFingerprint: materials.fingerprint,
          records, outcomes, previousRunId: previous?.runId ?? null,
        };
        if (previous) atomicJson(join(dir, 'history', previous.runId + '.json'), previous);
        atomicJson(join(dir, 'runs', runId + '.json'), state.result);
        state.stages.summary.status = outcomes.every(o => o.status === 'done') && records.length ? 'done' : 'partial';
        state.stages.summary.errors = outcomes.flatMap(o => o.errors);
      }
      if (stage === 'review') {
        const records = effectiveRecords(state);
        const review = await reviewFinalRecords({
          materials, records, llm, study,
          progress: (completed, total) => {
            state.stages.review.completed = completed;
            state.stages.review.total = total;
            log('最终复核 ' + completed + '/' + total + ' 批');
          },
        });
        state.review = {
          ...review, effort: stageEffort ?? null, at: new Date().toISOString(), sourceRunId: state.result.runId,
          snapshot: finalReviewSnapshot(state, records),
        };
        state.stages.review.status = review.unchecked ? 'partial' : 'done';
        state.stages.review.errors = review.errors;
      }
      state.stages[stage].status = state.stages[stage].status === 'running' ? 'done' : state.stages[stage].status;
      state.stages[stage].finishedAt = new Date().toISOString();
      delete state.stages[stage].pid;
      state.runs.push({ runId, stage, startedAt, endedAt: state.stages[stage].finishedAt, status: state.stages[stage].status, calls });
      saveWorkflow(root, state);
      return state;
    } catch (error) {
      state.stages[stage] = { ...state.stages[stage], status: 'failed', message: error.message, finishedAt: new Date().toISOString() };
      delete state.stages[stage].pid;
      state.runs.push({ runId, stage, startedAt, status: 'failed', error: error.message, calls });
      saveWorkflow(root, state);
      throw error;
    }
  });
}
