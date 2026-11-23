import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readWorkflow,saveWorkflow,editResult} from './lib/workflow-store.mjs';
import {readWorkflowMaterials} from './lib/workflow-materials.mjs';
import {runWorkflowStage} from './lib/workflow-engine.mjs';
const root=resolve('.');
process.env.AA_WORKFLOW_ROOT=join(root,'build/workflow-integration-check');
const material=await readWorkflowMaterials(root,'2015','2015-06');
const block=material.blocks.find(b=>b.grid?.some(row=>/CIC frequency/i.test(row[0])));
const row=block.grid.findIndex(row=>/CIC frequency/i.test(row[0]));
const column=2;
const pair=block.grid[row][column].match(/([\d.]+)\s*±\s*([\d.]+)/);
assert.ok(pair);
const scope={block:block.id,quote:(row+1)+' | '+block.grid[row].join(' | ')};
const source={block:block.id,quote:block.grid[row][column],row:row+1,column:column+1};
let state=readWorkflow(root,'2015','2015-06');
state.candidates=[
 {id:'integration-cic',name:'CIC frequency',instrument:'',domain:'',evidence:[{blockId:block.id,documentId:block.documentId,page:block.page}]},
 {id:'integration-unselected',name:'Residual urine volume',instrument:'',domain:'',evidence:[]},
];
state.basic={fields:[],status:'fixture'};
state.selection={revision:20,candidateIds:['integration-cic'],reviewer:'integration-check'};
state.candidateFingerprint=material.fingerprint;
saveWorkflow(root,state);
let calls=0;
const llm={invoke:async request=>{
 calls++;
 const chosen=JSON.parse(request.user.split('\n\n')[0].replace('选中结局：',''));
 assert.equal(chosen.name,'CIC frequency');
 return {json:{records:[{group:'Group 2',comparison:'',time:'not_reported',statistic:'mean',estimand:'absolute',
  scopeSource:scope,values:{estimate:{value:pair[1],source},sd:{value:pair[2],source}}}],unreported:[]}};
}};
state=await runWorkflowStage(root,'2015','2015-06','summary',{llm,fresh:true,selectionRevision:20});
assert.ok(calls>0);
assert.ok(state.result.records.length);
assert.ok(state.result.records.every(r=>r.candidateId==='integration-cic'));
const id=state.result.records[0].id;
await editResult(root,'2015','2015-06',{recordId:id,reviewer:'test-reviewer',revision:20,action:'confirm'});
calls=0;
state=await runWorkflowStage(root,'2015','2015-06','summary',{llm,selectionRevision:20});
assert.equal(calls,0);
assert.equal(state.confirmations?.[id],undefined);
const result={ok:true,checks:['只请求已选结局','真实解析表格数值可归属','同一选择重试复用成功检查点','重新汇总清除旧人工确认'],estimate:pair[1],sd:pair[2]};
fs.writeFileSync(join(process.env.AA_WORKFLOW_ROOT,'checks.json'),JSON.stringify(result,null,2));
console.log(result);
