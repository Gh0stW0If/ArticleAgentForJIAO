import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {readWorkflowMaterials} from './lib/workflow-materials.mjs';
import {readWorkflow,saveWorkflow,fingerprint,atomicJson} from './lib/workflow-store.mjs';
import {runWorkflowStage} from './lib/workflow-engine.mjs';
import {workflowExportSheets} from './lib/workflow-export.mjs';
import {buildXlsx} from './lib/xlsxwrite.mjs';
const root=resolve('.');
const output=join(root,'build/workflow-validation/2026-11-21');
process.env.AA_WORKFLOW_ROOT=output;
const file=join(output,'_progress.json');
const progress=JSON.parse(fs.readFileSync(file,'utf8'));
for(const [id,entry] of Object.entries(progress.papers)){
 if(entry.status!=='completed')continue;
 const year=id.slice(0,4);
 let state=readWorkflow(root,year,id);
 if(Object.values(state.stages).some(stage=>stage.status==='running')){console.log('仍在运行，稍后重放',id);continue;}
 const materials=await readWorkflowMaterials(root,year,id);
 if(state.candidateFingerprint!==materials.fingerprint){
  const folder=join(output,year,id);
  const earlier=fs.readdirSync(folder).filter(name=>name.startsWith('materials-')).map(name=>JSON.parse(fs.readFileSync(join(folder,name),'utf8')))
    .find(item=>item.fingerprint===state.candidateFingerprint);
  if(!earlier||fingerprint(earlier.blocks)!==fingerprint(materials.blocks))throw new Error(id+' 原文材料发生实质改变，需要重新识别候选');
  // Parser version migration is allowed only for byte-identical extracted blocks.
  state.candidateFingerprint=materials.fingerprint;
  saveWorkflow(root,state);
 }
 state=await runWorkflowStage(root,year,id,'summary',{offline:true,selectionRevision:state.selection.revision});
 entry.originalApiErrors ??= (entry.outcomeStatuses ?? []).flatMap(outcome => outcome.errors ?? []);
 entry.records=state.result.records.length;
 entry.outcomeStatuses=state.result.outcomes.map(o=>({candidateId:o.candidateId,status:o.status,records:o.records.length,rejected:o.rejected.length,errors:o.errors}));
 entry.workflowSummaryStatus=state.stages.summary.status;
 entry.numericFieldsByType={};
 for(const r of state.result.records)for(const k of Object.keys(r.values))entry.numericFieldsByType[k]=(entry.numericFieldsByType[k]??0)+1;
 entry.localValidationVersion=13;
 entry.replayedAt=new Date().toISOString();
 atomicJson(file,progress);
 atomicJson(join(output,year,id,'测试选择与结果.json'),entry);
 fs.writeFileSync(join(output,year,id,'验收结果.xlsx'),buildXlsx(workflowExportSheets(state)));
 console.log('本地重放',id,entry.records);
}
