import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {readWorkflow,selectOutcomes,atomicJson} from './lib/workflow-store.mjs';
import {runWorkflowStage} from './lib/workflow-engine.mjs';
import {workflowExportSheets} from './lib/workflow-export.mjs';
import {buildXlsx} from './lib/xlsxwrite.mjs';
const root=resolve('.');
const output=join(root,'build/workflow-selected-demo');
process.env.AA_WORKFLOW_ROOT=output;
const year='2017',id='2017-05';
let state=readWorkflow(root,year,id);
if(!state.basic)state=await runWorkflowStage(root,year,id,'basic',{reuseBasics:true});
state=await runWorkflowStage(root,year,id,'candidates');
const selected=[
 state.candidates.find(c=>/MDASI|M\.?\s*D\.?\s*Anderson/i.test(c.name)),
 state.candidates.find(c=>/occurrence rate of vomiting/i.test(c.name)),
].filter(Boolean);
if(selected.length!==2)throw new Error('预期原文候选尚未找到');
state=await selectOutcomes(root,year,id,{revision:state.selection.revision,candidateIds:selected.map(c=>c.id),reviewer:'原文候选流程验收'});
state=await runWorkflowStage(root,year,id,'summary',{selectionRevision:state.selection.revision});
const result={paper:id,selected:selected.map(c=>c.name),records:state.result.records.length,outcomes:state.result.outcomes.map(o=>({name:state.candidates.find(c=>c.id===o.candidateId).name,status:o.status,records:o.records.length,rejected:o.rejected.length,errors:o.errors}))};
atomicJson(join(output,'checks.json'),result);
fs.writeFileSync(join(output,'原文候选示例.xlsx'),buildXlsx(workflowExportSheets(state)));
console.log(result);
