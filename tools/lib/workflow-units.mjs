import {normalizeMeasurementUnit,normalizeOutcomeUnit} from '../../packages/core/dist/index.js';
import {groundSource} from './workflow-materials.mjs';
export function unitEvidenceMatches(value,quote){
 const unit=normalizeMeasurementUnit(value);
 if(!unit.canonical)return false;
 const tokens=String(quote??'').match(/[A-Za-zµμ%]+(?:\s*\/\s*[A-Za-zµμ0-9²]+)?|毫升|毫米|厘米|分钟|小时|百分比|分数|千克|微克|毫克|周|天|次\/日|次\/天|次\/周|分|例|人/g)??[];
 return tokens.some(token=>normalizeMeasurementUnit(token).canonical===unit.canonical)
   ||String(quote??'').toLowerCase().includes(String(value).toLowerCase())&&unit.status==='unrecognized';
}
export function resolveWorkflowUnit(materials,candidate,item,pointSource,scope,issues=[]){
 const raw=String(item.unit?.value??'NR').trim();
 const normalized=normalizeMeasurementUnit(raw);
 const source=groundSource(materials,item.unit?.source);
 if(source&&normalized.status==='dimensionless'&&/unitless|dimensionless|无单位|无量纲/i.test(source.quote))
  return {...normalized,source,origin:'model'};
 if(source&&normalized.status==='not_applicable'&&/not applicable|不适用|无单位|无量纲/i.test(source.quote))
  return {...normalizeOutcomeUnit(raw),source,origin:'model'};
 if(source&&normalized.status==='reported'&&unitEvidenceMatches(raw,source.quote)){
  if(normalized.canonical==='count'&&/^(mean|median)$/i.test(item.statistic)
    &&!/\b(?:number|counts?)\b|人数|次数/.test(candidate.name)){
   issues.push('样本量 n 不能直接当作该均值的测量单位');
  }else return {...normalizeOutcomeUnit(raw),source,origin:'model'};
 }
 if(item.unit&&normalized.status==='reported')issues.push('测量单位缺少与原文一致的单位证据');
 if(source&&normalized.status==='unrecognized'){
  issues.push('测量单位尚未收录，保留原文待核对');
  return {...normalized,source,origin:'model'};
 }
 // Physical units may be explicitly attached to the result's own row label.
 const block=materials.blocks.find(block=>block.id===pointSource?.blockId);
 const rowLabel=block?.grid?.[pointSource?.row-1]?.[0];
 const labels=[{text:rowLabel,source:rowLabel?groundSource(materials,{block:block.id,quote:rowLabel}):null,origin:'row_header'},
   {text:candidate.name,source:candidate.evidence?.find(e=>e.quote),origin:'candidate_name'}];
 for(const label of labels){
  if(!label.source)continue;
  const parts=[...String(label.text??'').matchAll(/[\[(]([^\])]+)[\])]/g)].map(m=>m[1]);
  for(const part of parts){
   const unit=normalizeMeasurementUnit(part);
   if(unit.status==='reported'&&unitEvidenceMatches(part,label.source.quote))return {...normalizeOutcomeUnit(part),source:label.source,origin:label.origin};
  }
 }
 if(/^(OR|RR|HR)$/i.test(item.statistic)&&/\b(?:OR|RR|HR)\b/.test(scope.quote))
  return {raw:'dimensionless',canonical:'1',status:'dimensionless',source:scope,origin:'statistic'};
 return {raw:normalized.status==='not_extractable'?'NE':'NR',status:normalized.status==='not_extractable'?'not_extractable':'not_reported'};
}
