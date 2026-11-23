import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWorkflowUnit} from './lib/workflow-units.mjs';
import {readWorkflow,saveWorkflow,editResult,effectiveRecords} from './lib/workflow-store.mjs';
import {workflowExportSheets} from './lib/workflow-export.mjs';
import {join} from 'node:path';
test('normalizes an explicitly sourced unit and recovers only a relevant row-header unit',()=>{
 const materials={blocks:[{id:'table',documentId:'p',page:1,text:'',grid:[['Outcome','Group A'],['Residual volume (mL)','20±2']]}]};
 const source={blockId:'table',documentId:'p',page:1,row:2,column:2,quote:'20±2'};
 const scope={...source,quote:'Residual volume (mL)'};
 const candidate={name:'Residual volume',evidence:[]};
 assert.equal(resolveWorkflowUnit(materials,candidate,{statistic:'mean'},source,scope).canonical,'mL');
 const explicit={statistic:'mean',unit:{value:'milliliters',source:{block:'table',quote:'Residual volume (mL)'}}};
 assert.equal(resolveWorkflowUnit(materials,candidate,explicit,source,scope).canonical,'mL');
});
test('does not infer a measurement unit from sample size n or a nearby time header',()=>{
 const materials={blocks:[{id:'table',documentId:'p',page:1,text:'n=40',grid:[['Time (days)','Group A (n=40)'],['MRS','20±2']]}]};
 const source={blockId:'table',documentId:'p',page:1,row:2,column:2,quote:'20±2'};
 const issues=[];
 const unit=resolveWorkflowUnit(materials,{name:'MRS total score',evidence:[]},{statistic:'mean',unit:{value:'n',source:{block:'table',quote:'n=40'}}},source,source,issues);
 assert.equal(unit.status,'not_reported');
 assert.ok(issues.some(issue=>issue.includes('样本量')));
});
test('unit editing is audited and exported without converting the numerical result',async()=>{
 const root=join(process.cwd(),'build/workflow-tests/units-'+process.pid);
 let state=readWorkflow(root,'2026','2026-01');
 state.result={records:[{id:'r',outcome:'duration',values:{estimate:'30'},evidence:{},issues:[],status:'reported',unit:{raw:'minutes',canonical:'min',status:'reported'}}],outcomes:[]};
 saveWorkflow(root,state);
 await editResult(root,'2026','2026-01',{recordId:'r',field:'unit',raw:'分钟',revision:0,reviewer:'doctor'});
 state=readWorkflow(root,'2026','2026-01');
 const row=effectiveRecords(state)[0];
 assert.equal(row.unit.canonical,'min');
 assert.equal(row.values.estimate,'30');
 assert.equal(row.humanEdits[0].field,'unit');
 const sheet=workflowExportSheets(state)[2];
 assert.equal(sheet.rows[1][sheet.rows[0].indexOf('测量单位(规范)')],'min');
});

test('scale scores keep their evidence and export NA as the standardized unit', () => {
  const materials = { blocks: [{ id: 'scale', documentId: 'p', page: 1, text: 'MoCA total score ranges from 0 to 30.' }] };
  const item = { statistic: 'mean', unit: { value: 'score', source: { block: 'scale', quote: 'MoCA total score' } } };
  const source = { blockId: 'scale', documentId: 'p', page: 1, quote: 'MoCA total score' };
  const candidate = { name: 'MoCA total score', evidence: [] };
  const unit = resolveWorkflowUnit(materials, candidate, item, source, source);
  assert.equal(unit.canonical, 'NA');
  assert.equal(unit.raw, 'score');
  assert.equal(unit.status, 'not_applicable');
  assert.equal(unit.source.quote, 'MoCA total score');
  const unverified = resolveWorkflowUnit(materials, candidate, { statistic: 'mean' }, source, source);
  assert.equal(unverified.status, 'not_reported');

  const state = readWorkflow(join(process.cwd(), 'build/workflow-tests/scale-' + process.pid), '2026', '2026-01');
  state.result = { records: [{ id: 'score', values: { estimate: '24' }, evidence: {},
    unit: { raw: 'points', canonical: 'point', status: 'reported', source } }], outcomes: [] };
  const [headers, row] = workflowExportSheets(state)[2].rows;
  assert.equal(row[headers.indexOf('测量单位(规范)')], 'NA');
  assert.equal(row[headers.indexOf('原文单位')], 'points');
  assert.equal(row[headers.indexOf('估计值')], '24');
  assert.match(row[headers.indexOf('单位来源')], /MoCA total score/);
});
