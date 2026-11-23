import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {ingest} from '../packages/ingest/dist/index.js';
import {createComparisonSkill,createDeepSeekLlm} from '../packages/skills/dist/index.js';
import {loadLlmConfig} from './lib/llm-config.mjs';
import {readParticipantFlow} from './lib/participant-flow.mjs';
import {atomicJson} from './lib/workflow-store.mjs';
const root=resolve('.');
const output=join(root,'build/units-missing-validation/2026-11-21');
fs.mkdirSync(output,{recursive:true});
const cfg=loadLlmConfig(root);
const ids=process.argv.slice(2).filter(id=>/^\d{4}-\d+$/.test(id));
if(!ids.length)ids.push('2018-02','2016-01');
await Promise.all(ids.map(async id=>{
 const file=join(output,id+'.json');
 if(fs.existsSync(file)&&!process.argv.includes('--fresh')){console.log('已有验证',id);return;}
 const old=JSON.parse(fs.readFileSync(join(root,'build/extraction',id.slice(0,4),id+'.json'),'utf8'));
 const flow=await readParticipantFlow(root,ingest({rootDir:root,year:id.slice(0,4),studyId:id}).doc);
 const calls=[];
 const llm=createDeepSeekLlm({...cfg,maxTokens:10000,timeoutMs:180000,retries:1,onCall:c=>{calls.push({tag:c.tag,ok:c.ok,ms:c.ms,error:c.error});console.log(id,c.ok?'API完成':'API失败');}});
 const plan={intervention:old.comparisons[0].intervention.raw,control:old.comparisons[0].control.raw};
 const result=await createComparisonSkill({plannedComparisons:[plan]}).run({doc:flow.doc,llm,log:()=>{}});
 const comparison=result.payload.comparisons[0];
 atomicJson(file,{id,at:new Date().toISOString(),flowWarnings:flow.warnings,calls,comparison,issues:result.issues});
 console.log(id,JSON.stringify({ratio:comparison?.missingDataRatio,frames:comparison?.missingData?.frames.length,issues:comparison?.missingData?.issues},null,2));
}));
