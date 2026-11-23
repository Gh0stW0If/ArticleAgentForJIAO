import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflowStage } from './lib/workflow-engine.mjs';
import { readWorkflowMaterials } from './lib/workflow-materials.mjs';
import { readWorkflow, selectOutcomes, addCandidate, atomicJson } from './lib/workflow-store.mjs';
import { dice } from './lib/align.mjs';
import { workflowExportSheets } from './lib/workflow-export.mjs';
import { buildXlsx } from './lib/xlsxwrite.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'build', 'workflow-validation', '2026-11-21');
process.env.AA_WORKFLOW_ROOT = output;
const gold = JSON.parse(fs.readFileSync(join(root, 'build/report/26篇全部字段复评_2026-11-21/结局配对.json'), 'utf8'));
const ids = JSON.parse(fs.readFileSync(join(root, 'build/extraction-pilot/november-remaining-16-2026-11-20/26篇结果索引.json'), 'utf8')).scope;
const statusFile = join(output, '_progress.json');
let report = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {
  startedAt: new Date().toISOString(), source: '11月核对表结局名称与量表，测试选择独立保存',
  papers: Object.fromEntries(ids.map(id => [id, { status: 'queued' }])),
};
const save = () => atomicJson(statusFile, report);
const nameTokens = value => String(value ?? '').toLowerCase().replace(/\([^)]*\)/g, '').split(/[^\p{L}\p{N}]+/u)
  .filter(v => v.length > 1 && !['the','of','each','time','times','per','day','daily','mean','ml','score'].includes(v));
const normalized = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
async function validate(id) {
  const year = id.slice(0, 4);
  const entry = report.papers[id];
  if (entry.status === 'completed' && entry.validatorVersion === 6) return;
  try {
    entry.status = 'running'; entry.startedAt = new Date().toISOString(); save();
    console.log('开始', id);
    let state = readWorkflow(root, year, id);
    if (!state.basic) await runWorkflowStage(root, year, id, 'basic', { reuseBasics: true });
    // Candidate and selected-value stages use real API responses. Existing extraction supplies the cached basic stage.
    if (state.candidateFingerprint !== (await readWorkflowMaterials(root, year, id)).fingerprint) state = await runWorkflowStage(root, year, id, 'candidates', { offline: process.argv.includes('--offline') });
    else state = readWorkflow(root, year, id);
    const initialCandidates = structuredClone(state.candidates.filter(c => c.origin === 'model'));
    const reference = [...new Map(gold.filter(r => r.id === id && r.name && !/未命名/.test(r.name))
      .map(r => [normalized(r.name) + '|' + normalized(r.instrument), r])).values()];
    const decisions = [], selected = [];
    for (const ref of reference) {
      const ranked = initialCandidates.map(c => {
        const exactName = normalized(ref.name) === normalized(c.name);
        const instrument = !/^(NR|NA|NE)$/i.test(ref.instrument ?? '') && ref.instrument
          ? dice(ref.instrument, c.instrument) : 0;
        const a = new Set(nameTokens(ref.name)), b = new Set(nameTokens(c.name));
        const common = [...a].filter(v => b.has(v)).length;
        const name = Math.max(dice(ref.name, c.name), a.size && b.size ? 2 * common / (a.size + b.size) : 0);
        return { c, score: exactName ? 3 : name + instrument * 0.8, name, instrument };
      }).sort((a, b) => b.score - a.score);
      let match = ranked[0];
      const good = match && (match.score >= 1.2 && match.name >= .25 || match.name >= .78 || match.score === 3)
        && !(ranked[1] && match.score < 3 && Math.abs(match.score - ranked[1].score) < .08);
      if (!good) {
        const existing = state.candidates.find(c => c.origin === 'human' && normalized(c.name) === normalized(ref.name));
        if (existing) match = { c: existing };
        else {
          state = await addCandidate(root, year, id, { name: ref.name, instrument: /^(NR|NA|NE)$/i.test(ref.instrument ?? '') ? '' : ref.instrument, reviewer: '11月参考名单回归测试' });
          match = { c: state.candidates.at(-1) };
        }
        decisions.push({ name: ref.name, instrument: ref.instrument, candidateId: match.c.id, originallyFound: false, method: '按已有人工名单补加测试候选' });
      } else decisions.push({ name: ref.name, instrument: ref.instrument, candidateId: match.c.id, originallyFound: true, method: '结局名称和工具对齐' });
      selected.push(match.c.id);
    }
    if (!selected.length) throw new Error('没有可用的11月参考结局选择');
    if (!state.result || !entry.summaryFinished || entry.validatorVersion !== 6) {
      state = await selectOutcomes(root, year, id, {
        revision: state.selection.revision, candidateIds: [...new Set(selected)], reviewer: '11月参考名单回归测试',
      });
      state = await runWorkflowStage(root, year, id, 'summary', { selectionRevision: state.selection.revision, offline: process.argv.includes('--offline') });
      entry.summaryFinished = true;
      entry.validatorVersion = 6;
    }
    const byType = {};
    for (const r of state.result.records) {
      for (const key of Object.keys(r.values)) byType[key] = (byType[key] ?? 0) + 1;
    }
    entry.status = 'completed';
    entry.finishedAt = new Date().toISOString();
    entry.candidateCount = initialCandidates.length;
    entry.referenceSelections = reference.length;
    entry.referenceFound = decisions.filter(r => r.originallyFound).length;
    entry.manualTestAdditions = decisions.filter(r => !r.originallyFound).length;
    entry.decisions = decisions;
    entry.selectedCount = state.selection.candidateIds.length;
    entry.records = state.result.records.length;
    entry.outcomeStatuses = state.result.outcomes.map(r => ({ candidateId: r.candidateId, status: r.status, records: r.records.length, rejected: r.rejected.length, errors: r.errors }));
    entry.numericFieldsByType = byType;
    entry.workflowSummaryStatus = state.stages.summary.status;
    entry.resultFile = join(output, year, id, 'workflow.json');
    const sheets = workflowExportSheets(state);
    fs.writeFileSync(join(output, year, id, '验收结果.xlsx'), buildXlsx(sheets));
    atomicJson(join(output, year, id, '测试选择与结果.json'), entry);
    save();
    console.log('完成', id, '候选', initialCandidates.length, '匹配参考', entry.referenceFound + '/' + reference.length, '记录', entry.records);
  } catch (error) {
    entry.status = 'failed'; entry.error = error.message; entry.finishedAt = new Date().toISOString();
    save(); console.error('失败', id, error.message);
  }
}
let cursor = 0;
async function worker() { while (cursor < ids.length) await validate(ids[cursor++]); }
const concurrency = Math.max(1, Math.min(6, Number(process.env.AA_WORKFLOW_VALIDATION_CONCURRENCY) || 3));
await Promise.all(Array.from({ length: concurrency }, worker));
report.finishedAt = new Date().toISOString();
report.completed = Object.values(report.papers).filter(p => p.status === 'completed').length;
save();
console.log('验收结束', report.completed, '/', ids.length);
process.exitCode = report.completed === ids.length ? 0 : 1;
