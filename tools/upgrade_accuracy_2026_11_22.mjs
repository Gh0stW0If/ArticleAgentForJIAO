import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ingest} from '../packages/ingest/dist/index.js';
import {createComparisonSkill,createOutcomeSkill,createDeepSeekLlm} from '../packages/skills/dist/index.js';
import {loadLlmConfig} from './lib/llm-config.mjs';
import {readParticipantFlow} from './lib/participant-flow.mjs';
import {atomicJson} from './lib/workflow-store.mjs';

const root=resolve('.');
const output=join(root,'build/upgrade-accuracy/2026-11-22');
const baselineDir=join(root,'build/report/26篇全部字段复评_2026-11-21');
const indexFile=join(root,'build/extraction-pilot/november-remaining-16-2026-11-20/26篇结果索引.json');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const get=(obj,path)=>path?.split('.').reduce((x,k)=>x?.[k],obj);
const rows=read(join(baselineDir,'字段对照.json'));
const semantic=read(join(baselineDir,'语义判定缓存.json'));
const index=read(indexFile);
const cfg=loadLlmConfig(root);
fs.mkdirSync(join(output,'tasks'),{recursive:true});
fs.mkdirSync(join(output,'requests'),{recursive:true});
const resolved=row=>row.status!=='pending'?row.status:
 ['identical','same_meaning'].includes(semantic[row.judgeKey]?.verdict)?'correct':
 semantic[row.judgeKey]?.verdict==='contains_correct'?'partial':
 ['has_error','completely_different'].includes(semantic[row.judgeKey]?.verdict)?'wrong':'unknown';
const docs=new Map(index.scope.map(id=>[id,read(index.results[id].result)]));
const tasks=[];
for(const id of index.scope){
 const old=docs.get(id),unique=new Map();
 for(const row of rows.filter(r=>r.id===id&&r.path.endsWith('.missingDataRatio'))){
  const n=Number(row.path.split('.')[1]),comparison=old.comparisons[n];
  if(!comparison)throw Error('Baseline comparison missing '+id+' '+n);
  tasks.push({id,type:'missing',key:id+'-missing-'+n,n,
   plan:{intervention:comparison.intervention?.raw??'',control:comparison.control?.raw??''},
   cells:[row.path]});
 }
 for(const row of rows.filter(r=>r.id===id&&r.path.endsWith('.measurementUnit')&&r.mappedPath&&resolved(r)!=='unknown')){
  const n=Number(row.mappedPath.split('.')[1]),o=old.outcomes[n]?.outcome;
  if(!o)throw Error('Baseline outcome missing '+id+' '+n);
  const plan={name:o.name,instrument:o.instrument},identity=JSON.stringify([o.name?.raw,o.instrument?.raw]);
  if(!unique.has(identity))unique.set(identity,{id,type:'unit',key:id+'-unit-'+hash(identity).slice(0,12),plan,cells:[]});
  unique.get(identity).cells.push(row.path);
 }
 tasks.push(...unique.values());
}
const sources=['packages/core/dist/measurement-units.js','packages/skills/dist/outcome.js','packages/skills/dist/comparison.js','packages/skills/dist/missing-data.js','packages/skills/dist/measurement-units.js','packages/skills/dist/prompts.generated.js'];
const manifest={createdAt:new Date().toISOString(),scope:index.scope,baseline:indexFile,
 baselineHash:hash(fs.readFileSync(join(baselineDir,'字段对照.json'),'utf8')),
 provider:{model:cfg.model,baseUrl:cfg.baseUrl,wireApi:cfg.wireApi},
 sources:Object.fromEntries(sources.map(file=>[file,hash(fs.readFileSync(join(root,file),'utf8'))])),
 fixedTotals:{total:7673,correct:4623,unknown:315,decided:7358},
 tasks,method:'Freeze old outcome/comparison mapping and non-target scores; rerun deployed unit metadata and comparison skills only; never use reference values in extraction.'};
const manifestFile=join(output,'manifest.json');
if(fs.existsSync(manifestFile)){
 const prior=read(manifestFile);
 if(prior.baselineHash!==manifest.baselineHash||JSON.stringify(prior.sources)!==JSON.stringify(manifest.sources)||
 JSON.stringify(prior.provider)!==JSON.stringify(manifest.provider))throw Error('Evaluation inputs changed; use new directory');
}else atomicJson(manifestFile,manifest);

const materialCache=new Map(),flowCache=new Map();
const material=id=>{
 if(!materialCache.has(id))materialCache.set(id,ingest({rootDir:root,year:id.slice(0,4),studyId:id}).doc);
 return materialCache.get(id);
};
const flow=id=>{
 if(!flowCache.has(id))flowCache.set(id,readParticipantFlow(root,material(id)));
 return flowCache.get(id);
};
let cursor=0,completed=0,failed=0,liveCalls=0,cacheHits=0;
const started=Date.now();
const progress=()=>{
 atomicJson(join(output,'progress.json'),{at:new Date().toISOString(),total:tasks.length,completed,failed,
 liveCalls,cacheHits,elapsedMs:Date.now()-started});
};
const taskFile=t=>join(output,'tasks',t.key+'.json');
async function runTask(t){
 const file=taskFile(t);
 if(fs.existsSync(file)&&read(file).ok){completed++;return;}
 const calls=[];
 try{
  const rawLlm=createDeepSeekLlm({...cfg,maxTokens:10000,timeoutMs:180000,retries:1,
   onCall:x=>calls.push({tag:x.tag,ok:x.ok,ms:x.ms,usage:x.usage,error:x.error})});
  const llm={invoke:async request=>{
   const requestKey=hash({provider:manifest.provider,request});
   const cacheFile=join(output,'requests',requestKey+'.json');
   if(fs.existsSync(cacheFile)){cacheHits++;return read(cacheFile).response;}
   liveCalls++;
   const response=await rawLlm.invoke(request);
   if(!response.json||typeof response.json!=='object')throw Error('No parsed JSON returned');
   atomicJson(cacheFile,{requestKey,request,response,at:new Date().toISOString()});
   return response;
  }};
  const ctx={doc:material(t.id),llm,log:()=>{}};
  let result,field,extra;
  if(t.type==='missing'){
   const input=await flow(t.id);
   result=await createComparisonSkill({plannedComparisons:[t.plan]}).run({...ctx,doc:input.doc});
   const comparison=result.payload.comparisons?.[0];
   if(!comparison)throw Error('No comparison output');
   field=comparison.missingDataRatio;
   extra={comparison,flowWarnings:input.warnings};
  }else{
   result=await createOutcomeSkill({plannedOutcomes:[t.plan],comparisonCount:1}).run(ctx);
   if(result.issues.some(x=>x.code==='OUTCOME_ITEM_FAILED'))throw Error('Outcome item API/parse failed');
   const outcome=result.payload.outcomes?.[0];
   if(!outcome)throw Error('No outcome output');
   field=outcome.outcome?.measurementUnit;
   extra={outcome};
  }
  atomicJson(file,{...t,ok:true,at:new Date().toISOString(),field:field??null,issues:result.issues,
   unresolved:result.unresolved,calls,...extra});
  completed++;
  console.log(JSON.stringify({done:completed,total:tasks.length,key:t.key,raw:field?.raw??null,
   normalized:field?.normalized??null,apiMs:calls.reduce((s,x)=>s+x.ms,0)}));
 }catch(e){
  failed++;atomicJson(file,{...t,ok:false,at:new Date().toISOString(),error:e.message,calls});
  console.log(JSON.stringify({failed:t.key,error:e.message}));
 }
 progress();
}
console.log(JSON.stringify({tasks:tasks.length,unit:tasks.filter(t=>t.type==='unit').length,
 missing:tasks.filter(t=>t.type==='missing').length,model:cfg.model,workers:8}));
await Promise.all(Array.from({length:8},async()=>{while(cursor<tasks.length)await runTask(tasks[cursor++]);}));
progress();
console.log(JSON.stringify({complete:true,completed,failed,elapsedMs:Date.now()-started,liveCalls,cacheHits}));
if(failed)process.exitCode=2;
