import { type ComparisonLevel, type Evidence, type FieldValue, type Issue, type LlmInvoker, type LlmRequest, type MiniDoc,
  type MissingDataAssessment, type MissingDataFrame, warn } from '@aa/core';
import {groundField,numericTokens,type RawFieldClaim} from './grounding.ts';
import {collectMaterials} from './materials.ts';

const present=(field?:FieldValue)=>Boolean(field?.raw.trim()&&!/^(NR|NA|NE|N\/A)$/i.test(field.raw.trim()));
export function missingProportion(raw:unknown):number|undefined {
 const value=String(raw??'').normalize('NFKC').trim();
 const match=/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(%)?$/.exec(value);
 if(!match)return;
 const ratio=Number(match[1]+(match[2]?'e-2':''));
 return Number.isFinite(ratio)&&ratio>=0&&ratio<=1?ratio:undefined;
}
function ratioSupported(field?:FieldValue):boolean {
 const ratio=missingProportion(field?.raw);
 if(ratio===undefined)return false;
 return Boolean(field?.evidence.some(e=>{
  if(numericTokens(e.quote).includes(ratio))return true;
  return [...e.quote.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].some(m=>missingProportion(m[0])===ratio);
 }));
}
const evidenceOf=(fields:(FieldValue|undefined)[]):Evidence[]=>[...new Map(fields.flatMap(f=>f?.evidence??[])
 .map(e=>[e.blockId+':'+e.quote,e])).values()];
const numeric=(field?:FieldValue):number|undefined=>{
 if(!field||!/^\d+$/.test(field.raw.trim()))return;
 const value=Number(field.raw);
 return Number.isSafeInteger(value)&&value>=0?value:undefined;
};
const normalized=(field:FieldValue,ratio:number):FieldValue=>({...field,normalized:String(ratio)});
function derived(value:number,fields:(FieldValue|undefined)[],description:string):FieldValue {
 return {raw:String(Number(value.toFixed(10))),normalized:String(Number(value.toFixed(10))),
  provenance:'deterministic',legend:description,evidence:evidenceOf(fields),confidence:Math.min(...fields.map(f=>f?.confidence??0.8))};
}
export function assessMissingDataFrames(frames:MissingDataFrame[],reported?:FieldValue):MissingDataAssessment {
 const issues:string[]=[];
 for(const frame of frames){
  frame.issues=[...(frame.issues??[])];
  delete frame.derivedRatio;delete frame.basis;
  if(frame.reportedRatio){
   if(ratioSupported(frame.reportedRatio))frame.reportedRatio=normalized(frame.reportedRatio,missingProportion(frame.reportedRatio.raw)!);
   else frame.issues.push('原文缺失比例缺少有效的比例或百分比证据');
  }
  const complete=[frame.group,frame.outcome,frame.time,frame.population].every(f=>present(f)&&f!.evidence.length);
  const n=numeric(frame.counts.randomized),observed=numeric(frame.counts.observed),missing=numeric(frame.counts.missing);
  if(n!==undefined){
   if(n<=0)frame.issues.push('随机人数必须大于0');
   for(const [name,field]of Object.entries(frame.counts)){
    const count=numeric(field);
    if(count!==undefined&&count>n)frame.issues.push(name+'人数大于同口径随机人数');
   }
   if(observed!==undefined&&missing!==undefined&&observed+missing!==n)frame.issues.push('实际观测人数与缺失人数之和不等于随机人数');
  }
  if(!complete)frame.issues.push('缺失数据缺少完整的组别、结局、时点或人群口径');
  if(complete&&n!==undefined&&n>0&&!frame.issues.length){
   const m=missing??(observed!==undefined?n-observed:undefined);
   if(m!==undefined&&m>=0&&m<=n){
    frame.basis=missing!==undefined?'reported_missing_count':'randomized_minus_observed';
    frame.derivedRatio=derived(m/n,[frame.counts.randomized,missing!==undefined?frame.counts.missing:frame.counts.observed],
     '计算值：'+m+'/'+n+'；'+(missing!==undefined?'原文缺失人数/随机人数':'(随机人数－实际观测人数)/随机人数'));
    const r=frame.reportedRatio&&missingProportion(frame.reportedRatio.raw);
    // Reported percentages may have been rounded.
    const decimals=/\.(\d+)\s*%?$/.exec(frame.reportedRatio?.raw??'')?.[1]?.length??0;
    const tolerance=frame.reportedRatio?.raw.includes('%')?0.5*10**(-decimals)/100:decimals?0.5*10**(-decimals):1e-10;
    if(r!==undefined&&Math.abs(r-m/n)>Math.max(1e-10,tolerance))frame.issues.push('原文报告的缺失比例与同口径人数计算结果冲突');
   }
  }
  frame.status=frame.issues.length?'needs_review':frame.derivedRatio||frame.reportedRatio?'supported':'insufficient';
 }
 let reportedRatio:FieldValue|undefined;
 if(reported&&present(reported)){
  if(ratioSupported(reported))reportedRatio=normalized(reported,missingProportion(reported.raw)!);
  else issues.push('缺失比例原值无法按0—1比例或明确百分比确认');
 }
 const primary=frames.filter(f=>/^(1|yes|true)$/i.test(f.primary?.raw??'')&&f.primary!.evidence.some(e=>/primary (?:outcome|endpoint|end point)|主要结局|主要终点/i.test(e.quote)&&!/not (?:an? |the )?primary|非主要/i.test(e.quote)));
 const identity=(f:MissingDataFrame)=>[f.outcome?.raw,f.time?.raw,f.population?.raw].map(s=>String(s??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ')).join('|');
 const scopes=new Set(primary.map(identity));
 let derivedRatio:FieldValue|undefined;
 if(scopes.size===1){
  const valid=primary.filter(f=>f.status==='supported'&&f.derivedRatio);
  const overall=valid.filter(f=>f.role==='overall');
  const experimental=valid.filter(f=>f.role==='experimental'), control=valid.filter(f=>f.role==='control');
  if(overall.length===1)derivedRatio=overall[0]!.derivedRatio;
  else if(!overall.length&&experimental.length===1&&control.length===1){
   const a=experimental[0]!,b=control[0]!;
   const nA=numeric(a.counts.randomized)!,nB=numeric(b.counts.randomized)!;
   const mA=numeric(a.counts.missing)??nA-numeric(a.counts.observed)!;
   const mB=numeric(b.counts.missing)??nB-numeric(b.counts.observed)!;
   derivedRatio=derived((mA+mB)/(nA+nB),[a.derivedRatio,b.derivedRatio],
    '计算值：两臂缺失人数合计 '+(mA+mB)+' / 两臂随机人数合计 '+(nA+nB)+'；未使用分析人数或脱落人数替代观测人数');
  }
 }else if(scopes.size>1)issues.push('存在多个主要结局或时点口径，未自动合并缺失比例');
 if(reportedRatio&&derivedRatio){
  const decimals=/\.(\d+)\s*%?$/.exec(reportedRatio.raw)?.[1]?.length??0;
  const tolerance=reportedRatio.raw.includes('%')?0.5*10**(-decimals)/100:decimals?0.5*10**(-decimals):1e-10;
  if(Math.abs(missingProportion(reportedRatio.raw)!-Number(derivedRatio.raw))>Math.max(tolerance,1e-10))
   issues.push('原文直接报告比例与主要结局人数计算比例不同，请核对结局、时点和人群口径');
 }
 if(!derivedRatio&&frames.length)issues.push('未形成可用于主要结局缺失比例的完整同口径人数证据');
 return {frames,issues,...(reportedRatio?{reportedRatio}:{}),...(derivedRatio?{derivedRatio}:{})};
}
export function applyMissingDataAssessment(doc:MiniDoc,comparison:ComparisonLevel,raw:unknown,prefix:string,issues:Issue[]):void {
 const frames:MissingDataFrame[]=[];
 for(const [index,item]of (Array.isArray(raw)?raw:[]).slice(0,12).entries()){
  if(!item||typeof item!=='object'||!['experimental','control','overall'].includes(item.role))continue;
  const frame:MissingDataFrame={role:item.role,counts:{},issues:[],status:'insufficient'};
  const read=(key:string):FieldValue|undefined=>{
   const claim=item[key];if(!claim||typeof claim!=='object'||typeof claim.quote!=='string')return;
   return groundField(doc,prefix+'.missingData.frames.'+index+'.'+key,claim as RawFieldClaim,{kinds:['text','title','table','figure']}).field;
  };
  for(const key of ['group','outcome','time','population','primary'] as const){const f=read(key);if(f)frame[key]=f;}
  for(const key of ['randomized','observed','analyzed','imputed','dropout','missing'] as const){
   const f=read(key),count=numeric(f);
   const explicitZero=key==='missing'&&count===0&&f?.evidence.some(e=>/no missing (?:outcome )?data|无缺失数据|没有缺失数据/i.test(e.quote));
   if(f&&count!==undefined&&(explicitZero||f.evidence.some(e=>numericTokens(e.quote).includes(count))))frame.counts[key]=f;
   else if(f)frame.issues.push(key+'人数缺少同源数值证据');
  }
  const ratio=read('reportedRatio');if(ratio)frame.reportedRatio=ratio;
  frames.push(frame);
 }
 const result=assessMissingDataFrames(frames,comparison.missingDataRatio);
 if(comparison.missingDataRatio)result.originalRatio=comparison.missingDataRatio;
 comparison.missingData=result;
 if(result.reportedRatio)comparison.missingDataRatio=result.reportedRatio;
 else if(result.derivedRatio&&!present(comparison.missingDataRatio))comparison.missingDataRatio=result.derivedRatio;
 for(const message of [...result.issues,...result.frames.flatMap(f=>f.issues)]){
  issues.push(warn(message,'MISSING_DATA_SCOPE_REVIEW',{path:prefix+'.missingData',evidence:evidenceOf(result.frames.flatMap(f=>Object.values(f.counts)))}));
 }
}


export async function reviewMissingDataScope(
 doc:MiniDoc, comparison:ComparisonLevel, llm:LlmInvoker, prefix:string, issues:Issue[],
 reasoningEffort:NonNullable<LlmRequest['reasoningEffort']>|null='high',
):Promise<void> {
 const initial=comparison.missingData;
 if(!initial||initial.reportedRatio||initial.derivedRatio||missingProportion(comparison.missingDataRatio?.raw)!==undefined)return;
 const roles=['experimental','control'] as const;
 const scopeKeys=['group','outcome','time'] as const;
 const countKeys=['randomized','missing','observed'] as const;
 const usable=initial.frames.filter(f=>roles.some(role=>role===f.role)
  && /^(1|yes|true)$/i.test(f.primary?.raw??'')
  && scopeKeys.every(k=>present(f[k])&&f[k]!.evidence.length)
  && f.counts.randomized&&(f.counts.missing||f.counts.observed));
 if(usable.length!==2||!roles.every(role=>usable.some(f=>f.role===role)))return;

 const evidenceIds=new Set(evidenceOf(usable.flatMap(f=>[
  f.group,f.outcome,f.time,f.population,f.primary,...Object.values(f.counts),
 ])).map(e=>e.blockId));
 const scopeWords=/intention[- ]to[- ]treat|complet(?:e|ed) cases|analysis population|all randomly assigned|available (?:data|cases)|missing (?:outcome )?data|primary (?:outcome|endpoint)|随机入组|意向性分析|主要结局|缺失数据/i;
 const cited=doc.blocks.filter(b=>evidenceIds.has('b'+b.index));
 if(!cited.length)return;
 const scopeBlocks=doc.blocks.filter(b=>!cited.includes(b)&&!b.dropped
  && ['methods','results','abstract'].includes(b.section)&&scopeWords.test(b.text??'')).slice(0,10);
 const {text,blocks}=collectMaterials({...doc,blocks:[...cited,...scopeBlocks]},
  {tables:true,figures:true,numberTableCells:true,maxCharsPerBlock:6500,maxTotalChars:27000});
 const reviewDoc={...doc,blocks:doc.blocks.filter(b=>blocks.some(x=>x.index===b.index))};
 const locked=usable.map(f=>({role:f.role,...Object.fromEntries(scopeKeys.map(k=>[k,f[k]!.raw])),
  counts:Object.fromEntries(countKeys.filter(k=>f.counts[k]).map(k=>[k,f.counts[k]!.raw]))}));
 try{
  const response=await llm.invoke({
   system:'只复核主要结局缺失比例所需的人群和人数证据。根据给出的两组、结局及主要时点，补齐两组共享的人群口径。'
    +'组名填在 group，人群类型填在 population；同一人群使用相同写法，引用能确认口径的原文。保持已定位的数字和结局、组别、时点不变。'
    +'不能用 analyzed、imputed 或 dropout 代替 observed 或 missing，不自行算比例，不猜填。只返回 JSON {"missingDataEvidence":[{role,group,outcome,time,population,primary,randomized,observed,missing}]}。'
    +'role 为 experimental 或 control。其余每项形如 {"value":"原值","quote":"原文","source":{"block":24}}，block 取锚点编号。没有依据的键省略。',
   user:'沿用以下两臂及已核实的人数：'+JSON.stringify(locked)+'\n\n'+text,
   reasoningEffort,temperature:0,tag:'comparison-missing-data-review:'+doc.articleId+':'+prefix,
  });
  const raw=(response.json as {missingDataEvidence?:unknown}|undefined)?.missingDataEvidence;
  if(!Array.isArray(raw)||raw.length!==2)return;
  const trial={...comparison};
  const reviewIssues:Issue[]=[];
  applyMissingDataAssessment(reviewDoc,trial,raw,prefix,reviewIssues);
  const revised=trial.missingData;
  if(!revised?.derivedRatio||!trial.missingDataRatio||revised.frames.length!==2)return;
  const sameScope=(a?:FieldValue,b?:FieldValue)=>a?.raw.trim().toLowerCase()===b?.raw.trim().toLowerCase();
  const consistent=usable.every(old=>{
   const updated=revised.frames.find(f=>f.role===old.role);
   return updated&&scopeKeys.every(k=>sameScope(old[k],updated[k]))
    && countKeys.every(k=>old.counts[k]?numeric(old.counts[k])===numeric(updated.counts[k]):updated.counts[k]===undefined);
  });
  if(!consistent)return;
  const mergedFrames=initial.frames.map(f=>{
   if(!usable.includes(f))return structuredClone(f);
   const population=revised.frames.find(v=>v.role===f.role)!.population;
   return {...f,...(population?{population}:{}),issues:[]};
  });
  const final=assessMissingDataFrames(mergedFrames,initial.originalRatio);
  if(!final.derivedRatio)return;
  comparison.missingDataRatio=final.derivedRatio;
  comparison.missingData={...final,...(initial.originalRatio?{originalRatio:initial.originalRatio}:{})};
  for(let i=issues.length-1;i>=0;i--){
   if(issues[i]?.code==='MISSING_DATA_SCOPE_REVIEW'&&issues[i]?.path===prefix+'.missingData')issues.splice(i,1);
  }
  for(const note of [...final.issues,...final.frames.flatMap(frame=>frame.issues)]){
   issues.push(warn(note,'MISSING_DATA_SCOPE_REVIEW',{path:prefix+'.missingData'}));
  }
 }catch{
  issues.push(warn('缺失比例专项复核未完成，保留原有证据和待核对状态','MISSING_DATA_REVIEW_FAILED',{path:prefix+'.missingData'}));
 }
}
