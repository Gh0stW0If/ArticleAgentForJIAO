import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { readWorkflow, saveWorkflow, selectOutcomes, addCandidate, editResult, effectiveRecords, withStudyLock, studyDirectory } from './lib/workflow-store.mjs';
import { groundSource, numericSourceTokens } from './lib/workflow-materials.mjs';
import { validateResultRecord } from './lib/workflow-engine.mjs';
import { fieldReviewTarget, outcomeMaterials, reviewSummaryFields } from './lib/workflow-summary-review.mjs';
import { mergeResultRecord } from './lib/workflow-records.mjs';
import { workflowExportSheets } from './lib/workflow-export.mjs';

const root = join(process.cwd(), 'build', 'workflow-tests', 'store-' + process.pid);
fs.mkdirSync(root, { recursive: true });
const candidate = { id: 'c1', name: 'voided volume', instrument: '', domain: '', evidence: [{ blockId: 'mineru:37' }] };
const material = {
  blocks: [{
    id: 'mineru:37', documentId: 'paper', page: 4, bbox: [10, 10, 400, 250],
    type: 'table', text: 'Table 2. Results', caption: 'Table 2. Results',
    grid: [
      ['Outcome', 'Group 1', 'Group 2', 'Group 3'],
      ['Voided volume (ml) in the 1st month', '271.5±12.06', '375.5±10.06', '276.5±9.09'],
      ['CIC frequency', '1.7±0.14', '0.35±0.07', '1.35±0.21'],
    ],
  }],
};
const value = (raw, column = 2) => ({
  value: raw, source: { block: 'mineru:37', row: 2, column, quote: material.blocks[0].grid[1][column - 1] },
});
const record = () => ({
  group: 'Group 1', time: '1st month', comparison: '', estimand: 'absolute', statistic: 'mean',
  scopeSource: { block: 'mineru:37', quote: '2 | Voided volume (ml) in the 1st month | 271.5±12.06 | 375.5±10.06 | 276.5±9.09' },
  values: { estimate: value('271.5'), sd: value('12.06') },
});

test('selection persistence requires a reviewer and current revision, and invalidates an older summary', async () => {
  const state = readWorkflow(root, '2026', '2026-01');
  state.candidates = [{ ...candidate, name: 'pain', evidence: [] }];
  state.result = { runId: 'old', records: [] };
  saveWorkflow(root, state);
  await assert.rejects(selectOutcomes(root, '2026', '2026-01', { reviewer: '', revision: 0, candidateIds: ['c1'] }));
  const selected = await selectOutcomes(root, '2026', '2026-01', { reviewer: '医生', revision: 0, candidateIds: ['c1'] });
  assert.equal(selected.selection.revision, 1);
  assert.equal(selected.stages.summary.status, 'stale');
  await assert.rejects(selectOutcomes(root, '2026', '2026-01', { reviewer: '医生', revision: 0, candidateIds: [] }));
  assert.deepEqual(readWorkflow(root, '2026', '2026-01').selection.candidateIds, ['c1']);
});

test('same-study tasks are serialized and a dead process is recoverable', async () => {
  let release;
  const first = withStudyLock(root, '2026', '2026-02', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => withStudyLock(root, '2026', '2026-02', () => {}), /已有任务/);
  release();
  await first;
  const state = readWorkflow(root, '2026', '2026-02');
  state.stages.summary = { status: 'running', pid: 2147483000 };
  saveWorkflow(root, state);
  assert.equal(readWorkflow(root, '2026', '2026-02').stages.summary.status, 'interrupted');
});

test('rendered row anchors resolve to actual source cells and invented rows are rejected', () => {
  const source = groundSource(material, record().scopeSource);
  assert.ok(source);
  assert.match(source.quote, /271.5±12.06/);
  assert.doesNotMatch(source.quote, /^2 \|/);
  assert.equal(groundSource(material, { ...record().scopeSource, quote: record().scopeSource.quote.replace('271.5', '999') }), null);
  assert.equal(groundSource(material, value('999').source, '999'), null);
});

test('a complete SD pair is retained while wrong-arm values and cross-cell SD are blocked', () => {
  const item = record();
  const valid = validateResultRecord(material, candidate, item);
  assert.equal(valid.values.estimate, '271.5');
  assert.equal(valid.values.sd, '12.06');
  assert.equal(valid.status, 'reported');
  const wrong = { ...item, group: 'Group 2' };
  assert.match(validateResultRecord(material, candidate, wrong).rejected, /试验臂/);
  const cross = record();
  cross.values.sd = value('10.06', 3);
  const checked = validateResultRecord(material, candidate, cross);
  assert.equal(checked.values.sd, undefined);
  assert.equal(checked.status, 'needs_review');
});

test('header matching ignores preceding data values when finding an arm', () => {
  const copied = structuredClone(material);
  copied.blocks[0].grid.splice(1, 0, ['Age', '52.3', '51.1', '53.2']);
  const item = record();
  item.scopeSource.quote = item.scopeSource.quote.replace(/^2/, '3');
  item.values.estimate.source.row = 3;
  item.values.sd.source.row = 3;
  assert.equal(validateResultRecord(copied, candidate, item).values.estimate, '271.5');
});

test('a between-group CI uses its contrast column without masquerading as an arm mean', () => {
  const data = { blocks: [{ id: 'difference', documentId: 'paper', page: 7, type: 'table', text: 'CSBMs',
    caption: 'CSBMs', bbox: null, grid: [['Outcome','EA group','SA group','Between-group difference (95% CI)'],
      ['Weeks 1-8','1.76 (1.61 to 1.89)','0.87 (0.73 to 0.97)','0.90 (0.74 to 1.10)']] }] };
  const source = { block: 'difference', row: 2, column: 4, quote: '0.90 (0.74 to 1.10)' };
  const target = { id: 'csbm', name: 'CSBMs', instrument: 'CSBMs', evidence: [{blockId:'difference'}] };
  const item = { group:'EA vs SA', comparison:'EA vs SA', time:'Weeks 1-8', statistic:'difference',
    estimand:'between-group difference', scopeSource: {block:'difference',quote:'CSBMs'},
    values:{estimate:{value:'0.90',source},ciLower:{value:'0.74',source},ciUpper:{value:'1.10',source}} };
  const result = validateResultRecord(data,target,item);
  assert.equal(result.values.ciUpper,'1.10');
});

test('unknown time stays visible and incomplete CI endpoints are not silently accepted', () => {
  const item = record();
  item.time = null;
  item.values.ciLower = value('12.06');
  const result = validateResultRecord(material, candidate, item);
  assert.equal(result.time, 'not_reported');
  assert.equal(result.values.ciLower, undefined);
  assert.ok(result.issues.length >= 2);
});

test('manual additions, edits and confirmation survive reload and exports retain distinct time windows', async () => {
  let state = await addCandidate(root, '2026', '2026-03', { name: 'CSBM change', reviewer: '医生' });
  assert.equal(state.candidates[0].origin, 'human');
  state.basic = { fields: [] };
  state.result = {
    at: '2026-11-21', records: [
      { id: 'r1', candidateId: state.candidates[0].id, outcome: 'CSBM change', time: 'weeks 1–8', values: { estimate: '1.76' }, evidence: {}, issues: [], status: 'reported' },
      { id: 'r2', candidateId: state.candidates[0].id, outcome: 'CSBM change', time: 'weeks 9–20', values: { estimate: '1.96' }, evidence: {}, issues: [], status: 'reported' },
    ], outcomes: [],
  };
  saveWorkflow(root, state);
  await editResult(root, '2026', '2026-03', { recordId: 'r1', field: 'estimate', raw: '1.77', reviewer: '医生', revision: 0 });
  state = readWorkflow(root, '2026', '2026-03');
  assert.equal(effectiveRecords(state)[0].values.estimate, '1.77');
  assert.equal(state.result.records[0].values.estimate, '1.76');
  assert.equal(workflowExportSheets(state)[2].rows.length, 3);
  assert.notEqual(workflowExportSheets(state)[2].rows[1][6], workflowExportSheets(state)[2].rows[2][6]);
  assert.throws(() => studyDirectory(root, '2026', '../escape'));
  assert.ok(studyDirectory(root, '2026', '我的论文'));
});

test('plus/minus order and temporal labels cannot silently turn into a verified record', () => {
  const swapped = record();
  swapped.values.estimate = value('12.06');
  swapped.values.sd = value('271.5');
  assert.match(validateResultRecord(material, candidate, swapped).rejected, /数值次序/);
  const item = record();
  item.time = 'The clinical state of patients';
  assert.equal(validateResultRecord(material, candidate, item).status, 'needs_review');
});

test('a shared table cannot anchor another explicitly named scale domain', () => {
  const copy = structuredClone(material);
  copy.blocks[0].grid[1][0] = 'WOMAC stiffness';
  const item = record();
  item.scopeSource.quote = item.scopeSource.quote.replace('Voided volume (ml) in the 1st month','WOMAC stiffness');
  const selected = {...candidate, name:'WOMAC pain',instrument:'WOMAC',domain:'pain'};
  assert.match(validateResultRecord(copy, selected, item).rejected, /分域/);
});

test('OCR source numbers missing from the stated native PDF page remain visible for manual review', () => {
  const copy = structuredClone(material);
  copy.blocks.push({id:'native-page',type:'native',documentId:'paper',page:4,text:'A paragraph from the preceding PDF page'});
  const checked = validateResultRecord(copy, candidate, record());
  assert.equal(checked.values.estimate,'271.5');
  assert.equal(checked.status,'needs_review');
  assert.ok(checked.issues.some(issue=>issue.includes('跨页')));
});

test('absolute arm data deduplicate optional comparison labels while numeric conflicts remain visible', () => {
  const a=validateResultRecord(material,candidate,record());
  const b=validateResultRecord(material,candidate,{...record(),comparison:'Group 2'});
  assert.equal(a.id,b.id);
  const records=[];
  mergeResultRecord(records,a);mergeResultRecord(records,b);
  assert.equal(records.length,1);
  const conflicting=structuredClone(b);conflicting.values.estimate='272';
  mergeResultRecord(records,conflicting);
  assert.equal(records.length,2);
  assert.ok(records.every(r=>r.status==='needs_review'));
  assert.match(records[0].issues.join(''),/不同数值/);
});

test('native table headers plus a nonadjacent original row and wrapped block IDs are grounded without accepting invented fragments', () => {
 const m={blocks:[{id:'native',type:'native',documentId:'attachment',page:1,text:'Table S2 (N = 160).\nItems Control Ginger\nRow 1 10 20\nTotal score 49.45 ± 17.09 51.25 ± 15.05',bbox:null}]};
 assert.ok(groundSource(m,{block:'[[native]]',quote:'Table S2 (N=160).\nItems Control Ginger\nTotal score 49.45 ±17.09 51.25±15.05'}));
 assert.equal(groundSource(m,{block:'[[native]]',quote:'Table S2 (N=160).\nTotal score 999±17.09 51.25±15.05'}),null);
 assert.ok(groundSource(m,{block:'[[native]]',quote:'49.45±17.09'},'49.45'));
 assert.deepEqual(numericSourceTokens('n=1,234; Median 1.00 (0.50,4.00)'),[1234,1,.5,4]);
 assert.deepEqual(numericSourceTokens('0.1 (-0.3,0.5)'),[.1,-.3,.5]);
});

test('interval separators keep positive upper bounds and genuine negative signs separate', () => {
  assert.deepEqual(numericSourceTokens('10.5 (9.7–11.4)'), [10.5,9.7,11.4]);
  assert.deepEqual(numericSourceTokens('−1.3 (−1.8–−0.9)'), [-1.3,-1.8,-0.9]);
  assert.deepEqual(numericSourceTokens('0.2 (−0.4-1.3)'), [0.2,-0.4,1.3]);
});

test('summary includes the original outcome table even if it spells score as scale', () => {
  const relevant = { id:'oss',documentId:'paper',page:9,type:'table',text:'Oxford shoulder scale',
    grid:[['Oxford shoulder scale','Exercise group'],['6 months','43.35 (5.20)']] };
  const other = { id:'unrelated',documentId:'paper',page:11,type:'table',text:'Shoulder movement and range' };
  const target = { name:'Oxford Shoulder Score (OSS)',instrument:'Oxford Shoulder Score (OSS)',evidence:[] };
  assert.deepEqual(outcomeMaterials({sources:[],blocks:[relevant,other]},target).map(b=>b.id),['oss']);
});

test('high review sends only unresolved fields and keeps verified values', async () => {
  const clean = record();
  const unresolved = { ...clean, values:{ ...clean.values, sd:{ ...clean.values.sd, source:{ ...clean.values.sd.source, quote:'unverifiable' } } } };
  const checked = validateResultRecord(material, candidate, unresolved);
  assert.equal(checked.values.estimate,'271.5');
  assert.equal(fieldReviewTarget(clean,validateResultRecord(material,candidate,clean),material.blocks),null);
  const target = fieldReviewTarget(unresolved,checked,material.blocks);
  assert.deepEqual(target.fields,['sd']);
  let request;
  const repairs = await reviewSummaryFields({materials:material,candidate,targets:[target],
    validate:validateResultRecord,tag:'test-review',reasoningEffort:'xhigh',llm:{invoke:async current=>{
      request=current;
      return {json:{repairs:[{id:1, values:{sd:clean.values.sd, estimate:value('375.5',3)}}]}};
    }},
  });
  assert.equal(request.reasoningEffort,'xhigh');
  assert.deepEqual(JSON.parse(request.user.split('\n\n')[0]).targets[0].fields,['sd']);
  assert.deepEqual(repairs.get(0).values,{estimate:'271.5',sd:'12.06'});
  assert.deepEqual(repairs.get(0).reasoningReview,{effort:'xhigh',fields:['sd']});
});
