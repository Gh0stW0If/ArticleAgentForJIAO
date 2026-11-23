import {normalizeMeasurementUnit,normalizeOutcomeUnit,type FieldValue,type OutcomeLevel,type Issue,warn} from '@aa/core';

export function normalizeOutcomeMeasurementUnit(rec:OutcomeLevel,path:string,issues:Issue[]):void {
 const outcome=rec.outcome;
 if(!outcome)return;
 const unit=outcome.measurementUnit;
 if(unit){
  const normalization=normalizeOutcomeUnit(unit.raw);
  outcome.measurementUnit={...unit,unitStatus:normalization.status,...(normalization.canonical?{normalized:normalization.canonical}:{})};
  if(normalization.status==='unrecognized')issues.push(warn('测量单位未识别，保留原文供核对','MEASUREMENT_UNIT_UNKNOWN',{path:path+'.outcome.measurementUnit',evidence:unit.evidence}));
 }
 if(unit&&!/^(NR|NA|NE|N\/A)$/i.test(unit.raw))return;
 // Recover only explicit unit labels in this outcome's name or measurement range.
 for(const field of [outcome.name,outcome.measurementRange]){
  if(!field?.evidence.length)continue;
  const raw=field.raw.normalize('NFKC');
  const candidates=[...raw.matchAll(/[\[(]([^\])]+)[\])]/g)].map(m=>m[1]!)
   .concat(raw.match(/(?:\d|\])\s*(mm|cm|mL|ml|min|minutes|hours|days|weeks|points?|scores?|分|%|VMS\/day)\s*$/i)?.[1]??[]);
  for(const candidate of candidates){
   const normalization=normalizeMeasurementUnit(candidate);
   if(normalization.status!=='reported'||!normalization.canonical)continue;
   if(!field.evidence.some(e=>e.quote.toLowerCase().includes(candidate.toLowerCase())))continue;
   const standardized=normalizeOutcomeUnit(candidate);
   outcome.measurementUnit={raw:candidate,normalized:standardized.canonical??normalization.canonical,unitStatus:standardized.status,evidence:field.evidence,provenance:'deterministic',confidence:field.confidence};
    issues.push(warn('从本结局名称或测量范围的明确单位补全测量单位','MEASUREMENT_UNIT_RECOVERED',{path:path+'.outcome.measurementUnit',evidence:field.evidence}));
   return;
  }
 }
}
