import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { readReviewTables } from './import_review.mjs';
import { readWorkbook } from './lib/xlsx.mjs';
import { dice } from './lib/align.mjs';
import { ARTICLE_FIELDS, COMPARISON_FIELDS } from './canonical-field-map.mjs';
import { text, number, normalizeUnit, normalizeRatio, normalizePValue, compareLegacySexDistribution, equivalentDuplicateSD } from './lib/review-format.mjs';
import { quantityEqual } from '../packages/core/dist/index.js';
import { createDeepSeekLlm } from '../packages/skills/dist/index.js';
import { loadLlmConfig } from './lib/llm-config.mjs';
import { createHash } from 'node:crypto';

const root=process.cwd();
const output=join(root,'build/report/26篇全部字段复评_2026-11-21');
fs.mkdirSync(output,{recursive:true});
const read=path=>JSON.parse(fs.readFileSync(path,'utf8'));
const index=read('build/extraction-pilot/november-remaining-16-2026-11-20/26篇结果索引.json');
const docs=new Map(index.scope.map(id=>[id,read(index.results[id].result)]));
const oldDocs=new Map(index.scope.map(id=>[id,read(join('build/reextract-backups/20261116-192556-234',id.slice(0,4),id+'.json'))]));
const folder=join('Datas/design',fs.readdirSync('Datas/design').find(name=>name.startsWith('2026-11')));
const refs=new Map(), declarations=new Map(), excluded=[];
const put=rec=>refs.set(rec.id+'|'+rec.path,rec);
const main=fs.readdirSync(folder).find(name=>name.includes('2026-11-03.xlsx'));
for(const table of readReviewTables(fs.readFileSync(join(folder,main)),'xlsx')){
 for(const [i,r] of table.rows.entries()){
  const id=r[2]?.replace(/^-+/,'');
  if(!docs.has(id))continue;
  const path=r[6], value=String(r[13]??'').trim();
  const rec={id,path,value,label:r[4],sheet:table.tag,reviewed:Boolean(r[10]?.trim()),source:main,sourceRow:i+2,rowTitle:r[3]};
  if(path.startsWith('outcomes.')){
   const n=Number(path.split('.')[1]), k=id+'|'+n;
   const d=declarations.get(k)??{id,n,study:r[3]?.match(/（(\d{4}-\d{2}(?:-\d{2})?)）$/)?.[1]??id};
   if(path.endsWith('.outcome.name'))d.name=value||r[7]||'';
   if(path.endsWith('.outcome.instrument'))d.instrument=value||r[7]||'';
   declarations.set(k,d);
  }
  if(!value){excluded.push({...rec,reason:'人工表未提供参考值'});continue;}
  put(rec);
 }
}
const defs=new Map([...ARTICLE_FIELDS,...COMPARISON_FIELDS].map(d=>[d.key,d]));
const sheet1Keys=[
 null,null,'outliersInfluential','title','publicationYear','language','journal','journalClass','impactFactor2019','firstAuthor','authorContact','funding1','funding2','registrationReported','condition','conditionSystem','acuteOrSurgery','country','countryClass','trialCenterCount',
 'intervention','control','controlType','controlTypeConverted','comparisonType','randomizationMethod','randomizationClass','allocationConcealment','allocationClass','stratificationBlocking','blindingParticipants','blindingOutcomeAssessor','patientExpectation','practitionerCommunication','practitionerYears','practitionerEducation','practitionerSpecialty','acupunctureType','stimulationType','pointSelection','pointLocationClass','protocolSource','frequencyDesc','frequencyValue','frequencyUnit','courseDesc','courseValue','courseUnit','totalSessions','deqi','insertionDepthText','insertionDepthClass','needleRetentionDesc','needleRetentionValue','needleRetentionUnit','needleCountText','needleCountMin','postInsertionManipulation','needleAngleClass','needleDirectionClass','maxFollowupDesc','maxFollowupValue','maxFollowupUnit','sexExperimental','sexControl','typeOfData','baselineCatExperimentalNeg','baselineCatExperimentalPos','baselineCatControlNeg','baselineCatControlPos','priorAcupuncture','priorAcupunctureExperimental','priorAcupunctureControl','randomizedN','randomizedNExperimental','randomizedNControl','analyzedNExperimental','analyzedNControl','dropoutTotal','missingDataRatio','missingDataReported','primaryAnalysis','missingDataHandling',
];
const articleKeys=new Set(ARTICLE_FIELDS.map(f=>f.key));
const sheet2Keys={2:'title',3:'studyOutcomes.primaryOutcome',4:'studyOutcomes.pain',5:'studyOutcomes.nonPain',6:'studyOutcomes.function',7:'studyOutcomes.qualityOfLife',8:'studyOutcomes.importantEvents',9:'studyOutcomes.mortality',10:'studyOutcomes.remarks'};
const correction=value=>{
 const s=String(value).trim();
 const m=/(?:应(?:该)?\s*(?:改为|为)|改为)\s*[:：]?\s*([\s\S]+)/.exec(s);
 return m?m[1].trim().replace(/[)）]\s*$/,'').replace(/[;；]\s*$/,'').trim():s;
};
const freeName=fs.readdirSync(folder).find(name=>name.startsWith('2020-2025')&&name.endsWith('.xlsx'));
const overrides=[];
for(const sheet of readWorkbook(fs.readFileSync(join(folder,freeName))).sheets){
 for(const row of sheet.rows){
  const id=String(row.cells[0]??'').trim();
  if(!docs.has(id))continue;
  row.cells.forEach((v,col)=>{
   const key=sheet.name==='Sheet1'?sheet1Keys[col]:sheet2Keys[col];
   if(!key||!String(v??'').trim())return;
   const path=sheet.name==='Sheet1'&&!articleKeys.has(key)?'comparisons.0.'+key:key;
   const value=correction(v);
   if(!value)return;
   const prev=refs.get(id+'|'+path);
   if(prev&&text(prev.value)!==text(value))overrides.push({id,path,previous:prev.value,latest:value});
   put({id,path,value,label:defs.get(key)?.label??key,sheet:sheet.name,reviewed:true,source:freeName,sourceRow:row.r,previousValue:prev?.value});
  });
 }
}
const maps=new Map(), mapping=[];
const identity=s=>text(s).replace(/[^\p{L}\p{N}]/gu,'');
const valid=s=>s&&!/^(NR|NA|NE|未命名|（未命名）)$/i.test(s);
const locks={
 '2015-06':[0,1,2,3,4,5,null],
 '2016-01':[2,null,0,null,1,null,null,null],
 '2016-02':[0,1,2],
 '2016-03':[0,null,null,null,null,null,null],
 '2017-05':[null,0],
 '2017-12':[null,null,null,null,0,null,null,null,null,1],
 '2017-17':[0,1,2,3,4,5,6,7,8],
 '2018-02':[0,4,1,2,3,5,6,null,null],
 '2019-06':[0,1,1],
 '2019-07':[null,null,null,1,null],
 '2020-17':[0,1,2,3],
 '2024-12':[0,1,null,2,3],
 '2024-29':[0,3,4,1],
};
for(const id of index.scope){
 const refRows=[...declarations.values()].filter(x=>x.id===id).sort((a,b)=>a.n-b.n);
 const predictions=docs.get(id).outcomes;
 const selected=new Map(),used=new Set();
 const candidate=[];
 for(const ref of refRows){
  if(id==='2023-27')continue;
  if(locks[id]&&ref.n<locks[id].length){
   const pi=locks[id][ref.n];
   if(pi!=null&&predictions[pi]){selected.set(ref.n,pi);used.add(pi);}
   continue;
  }
  predictions.forEach((row,pi)=>{
   if(ref.study!==row.studyId)return;
   const name=row.outcome?.name?.raw??'', instrument=row.outcome?.instrument?.raw??'';
   let score=identity(ref.name??'')===identity(name)&&valid(name)?3:0;
   if(valid(ref.instrument)&&valid(instrument))score+=identity(ref.instrument)===identity(instrument)?2:2*dice(ref.instrument,instrument);
   score+=dice(ref.name??'',name);
   // Shared broad instruments cannot establish a match alone when a specific subdomain differs.
   candidate.push({ref,pi,score});
  });
 }
 candidate.sort((a,b)=>b.score-a.score);
 for(const {ref,pi,score}of candidate){
  if(score<1.25||selected.has(ref.n)||used.has(pi))continue;
  selected.set(ref.n,pi);used.add(pi);
 }
 maps.set(id,selected);
 for(const r of refRows){
  const pi=selected.get(r.n),row=pi===undefined?null:predictions[pi];
  mapping.push({...r,predIndex:pi??null,predName:row?.outcome?.name?.raw??'',predInstrument:row?.outcome?.instrument?.raw??'',status:id==='2023-27'?'比较组分析口径待裁定':row?'已配对':'结局遗漏'});
 }
}
const get=(o,path)=>path.split('.').reduce((a,k)=>a?.[k],o);
const locate=ref=>{
 let parts=ref.path.split('.');
 if(parts[0]==='outcomes'){
  if(ref.id==='2023-27')return {unknown:true};
  const n=maps.get(ref.id).get(Number(parts[1]));
  if(n===undefined)return {missed:true};
  parts[1]=String(n);
 }
 const doc=docs.get(ref.id);
 const base=['outcomes','comparisons'].includes(parts[0])?doc:doc.article;
 return {field:get(base,parts.join('.')),mappedPath:parts.join('.'),base,parts};
};
const excludedKeys=new Set(['literatureNo','extractor','eligibilityCheck','literatureCode','armNumber','articleId','studyId']);
const strict=(a,b)=>{
 const x=text(a),y=text(b);
 if(!x||!y)return false;
 if(x===y)return true;
 if(number(x)!==undefined&&number(y)!==undefined)return number(x)===number(y);
 if(/^\d+(?:\s*[/;,、]\s*\d+)+$/.test(x)&&/^\d+(?:\s*[/;,、]\s*\d+)+$/.test(y))
  return x.split(/[/;,、]/).map(v=>v.trim()).sort().join('/')===y.split(/[/;,、]/).map(v=>v.trim()).sort().join('/');
 return false;
};
function compare(ref,located){
 const {field,parts,base}=located, pred=field?.raw??'';
 if(located.unknown)return {status:'unknown',reason:'比较组分析口径待裁定'};
 if(!located.missed&&!pred.trim()&&ref.path.endsWith('.ciUpper')&&ref.path.includes('.continuous.')){
  const old=oldDocs.get(ref.id);
  const referenceParts=ref.path.split('.');
  const oldBlock=get(old,referenceParts.slice(0,5).join('.'));
  const block=get(base,parts.slice(0,5).join('.'));
  const side=parts[5];
  if(equivalentDuplicateSD(ref.value,oldBlock,block,side))return {status:'correct',reason:'同一估计的重复 SD/SE 合并为单值'};
 }
 if(located.missed||!pred.trim())return {status:'missed',reason:'无对应结局行或字段'};
 if(strict(ref.value,pred))return {status:'correct',reason:'直接一致'};
 const leaf=ref.path.split('.').at(-1),g=ref.value;
 if(field?.code&&strict(g,field.code))return {status:'correct',reason:'编码一致'};
 if(leaf==='measurementUnit'&&normalizeUnit(g)&&normalizeUnit(g)===normalizeUnit(pred))return {status:'correct',reason:'单位等价'};
 if(leaf==='missingDataRatio'){
  const a=normalizeRatio(g),b=normalizeRatio(pred);
  if(a!==undefined&&a===b)return {status:'correct',reason:'比例格式等价'};
 }
 if(leaf==='sexDistribution'){
  const old=oldDocs.get(ref.id)?.comparisons?.[Number(parts[1])],now=base?.comparisons?.[Number(parts[1])];
  const result=compareLegacySexDistribution(g,old,now);
  if(result?.equal)return {status:'correct',reason:'同组性别人数一致'};
 }
 if(leaf==='ciUpper'&&ref.path.includes('.continuous.')){
  const block=get(base,parts.slice(0,5).join('.')),side=parts[5];
  const row=get(base,parts.slice(0,2).join('.'));
  if(['1','3'].includes(block?.varianceType?.code)&&!pred.trim())return {status:'missed',reason:'上限为空，须核对历史 SD 重复'};
 }
 if(leaf==='pValue'){
  const gP=normalizePValue(g),pP=normalizePValue(pred,field.evidence);
  if(gP&&pP&&gP.value===pP.value&&gP.operator!=='unspecified'&&gP.operator===pP.operator)return {status:'correct',reason:'P 值与关系符一致'};
 }
 if(/(?:frequency|course|maxFollowup|needleRetention)(?:Value|Desc)$/.test(leaf)&&quantityEqual(g,pred))return {status:'correct',reason:'同量单位换算'};
 const sentinel=s=>/^(?:nr|na|ne|n\/a)$/i.test(text(s));
 const numeric=s=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*%)?$/.test(text(s));
 const codeList=s=>/^\d+(?:\s*[/;,、]\s*\d+)*$/.test(text(s));
 if(sentinel(g)||sentinel(pred)||numeric(g)&&numeric(pred)||codeList(g)&&codeList(pred))return {status:'wrong',reason:'数值、编码或缺失语义不符'};
 if(ref.path.includes('.timepoints.')&&/(?:estimate|ciLower|ciUpper|events|N|n)$/i.test(leaf))return {status:'wrong',reason:'数值字段不符'};
 return {status:'pending',reason:'描述性字段待语义判定'};
}
const rows=[];
for(const ref of refs.values()){
 if(excludedKeys.has(ref.path.split('.').at(-1))){excluded.push({...ref,reason:'标识或人工流程字段'});continue;}
 const at=locate(ref),pred=at.field?.raw??'';
 const result=compare(ref,at);
 rows.push({...ref,pred,mappedPath:at.mappedPath??'',layer:ref.path.startsWith('comparisons.')?'比较组':ref.path.startsWith('outcomes.')?(ref.path.includes('.timepoints.')?'时点数值':'结局与随访'):'文章与结局分类',...result});
}
const write=(name,data)=>fs.writeFileSync(join(output,name),JSON.stringify(data,null,2)+'\n','utf8');
write('字段对照.json',rows);write('结局配对.json',mapping);write('参考值覆盖与排除.json',{excluded,overrides});
const pending=new Map();
for(const r of rows.filter(r=>r.status==='pending')){
 const fingerprint=createHash('sha256').update(JSON.stringify([r.path.replace(/\.\d+\./g,'.'),r.value,r.pred])).digest('hex');
 r.judgeKey=fingerprint;
 const item=pending.get(fingerprint)??{key:fingerprint,field:r.path.replace(/\.\d+\./g,'.'),gold:r.value,pred:r.pred};
 pending.set(fingerprint,item);
}
write('字段对照.json',rows);
write('语义判定请求.json',[...pending.values()]);
console.log(JSON.stringify({references:rows.length,reviewed:rows.filter(r=>r.reviewed).length,status:rows.reduce((o,r)=>(o[r.status]=(o[r.status]??0)+1,o),{}),semanticUnique:pending.size,mapped:mapping.filter(r=>r.predIndex!==null).length,outcomeGoldRows:mapping.length,overrides:overrides.length,excluded:excluded.length}));

if(process.argv.includes('--judge')){
 const cfg=loadLlmConfig(root);
 const cacheFile=join(output,'语义判定缓存.json');
 const cache=fs.existsSync(cacheFile)?read(cacheFile):{};
 const tasks=[...pending.values()].filter(p=>!cache[p.key]||cache[p.key].verdict==='unknown');
 const groups=[];
 const batchSize=process.argv.includes('--small')?6:16;
 for(let i=0;i<tasks.length;i+=batchSize)groups.push(tasks.slice(i,i+batchSize));
 let cursor=0,finished=0;
 const system='你是系统评价字段核对员。逐组比较人工参考值和抽取值。只判信息是否等价。数值、组别、时间和范围必须一致。返回 results 数组，每项含 i、verdict、reason。verdict 取 identical、same_meaning、contains_correct、has_error、completely_different、unknown。contains_correct 只用于已有正确信息但有遗漏或多述且无实质错误，拿不准用 unknown。NR、NA、NE 含义不同。缩写与全称可等价。每组必须单独判定。';
 const smaller=process.argv.includes('--small');
 const llm=createDeepSeekLlm({...cfg,model:cfg.reviewModel??cfg.model,reasoningEffort:cfg.reviewReasoningEffort,maxTokens:smaller?2200:5000,timeoutMs:smaller?65000:100000,retries:smaller?0:1});
 async function worker(){
  while(cursor<groups.length){
   const group=groups[cursor++]; const batchIndex=cursor;
   try{
    const response=await llm.invoke({system,user:JSON.stringify(group.map((r,i)=>({i:i+1,field:r.field,gold:r.gold,pred:r.pred}))),temperature:0,tag:'all-fields-review:'+batchIndex});
    const out=response.json?.results;
    if(!Array.isArray(out))throw Error('缺少 results');
    for(const [i,r] of group.entries()){
     const hit=out.find(x=>Number(x.i)===i+1);
     cache[r.key]={verdict:['identical','same_meaning','contains_correct','has_error','completely_different'].includes(hit?.verdict)?hit.verdict:'unknown',reason:hit?.reason??'未返回该项'};
    }
   }catch(error){for(const r of group)cache[r.key]={verdict:'unknown',reason:error.message};}
   fs.writeFileSync(cacheFile,JSON.stringify(cache,null,2),'utf8');
   console.log('语义判定',++finished,'/',groups.length,'批完成');
  }
 }
 await Promise.all(Array.from({length:4},worker));
 write(smaller?'语义补判调用.json':'语义判定调用.json',llm.calls.map(({tag,ok,ms,usage,error})=>({tag,ok,ms,usage,error})));
}
