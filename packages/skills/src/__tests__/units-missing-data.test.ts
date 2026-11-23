import {describe,it,expect} from 'vitest';
import {COMPARISON_TASK} from '../prompts.generated.ts';
import {normalizeMeasurementUnit,type FieldValue,type MissingDataFrame,type MiniDoc,type ComparisonLevel} from '@aa/core';
import {assessMissingDataFrames,missingProportion,applyMissingDataAssessment,reviewMissingDataScope} from '../missing-data.ts';
import {normalizeOutcomeMeasurementUnit} from '../measurement-units.ts';

const field=(raw:string,quote=raw):FieldValue=>({raw,evidence:[{kind:'text',page:1,bbox:null,blockId:'b1',quote}],provenance:'model',confidence:.9});
const frame=(role:MissingDataFrame['role']='overall',n=100,observed=90):MissingDataFrame=>({
 role,group:field(role),outcome:field('MRS total change'),time:field('week 8'),population:field('randomized cohort'),
 primary:field('1','The primary outcome was MRS total change at week 8'),
 counts:{randomized:field(String(n)),observed:field(String(observed)),analyzed:field(String(n))},
 status:'insufficient',issues:[],
});
describe('measurement unit spelling and missing semantics',()=>{
 it('keeps physical magnitudes distinct while unifying unit spelling',()=>{
  expect(normalizeMeasurementUnit('minutes').canonical).toBe('min');
  expect(normalizeMeasurementUnit('毫升').canonical).toBe('mL');
  expect(normalizeMeasurementUnit('VMS / day').canonical).toBe('VMS/day');
  expect(normalizeMeasurementUnit('VMS per day').canonical).toBe('VMS/day');
  expect(normalizeMeasurementUnit('次/日').canonical).toBe('event/day');
  expect(normalizeMeasurementUnit('cm').canonical).not.toBe(normalizeMeasurementUnit('mm').canonical);
  expect(normalizeMeasurementUnit('mM').canonical).not.toBe(normalizeMeasurementUnit('mm').canonical);
 });
 it('never equates NR, NA, NE and explicitly dimensionless',()=>{
  expect(['NR','NA','NE','unitless'].map(s=>normalizeMeasurementUnit(s).status))
   .toEqual(['not_reported','not_applicable','not_extractable','dimensionless']);
  expect(normalizeMeasurementUnit('unknown-unit').status).toBe('unrecognized');
 });
 it('recovers an explicit row/name unit and retains evidence, without inventing a VAS millimeter unit',()=>{
  const rec:any={studyId:'paper',outcome:{name:field('Residual volume (mL)'),measurementUnit:field('NA','Residual volume (mL)')}};
  normalizeOutcomeMeasurementUnit(rec,'outcomes.0',[]);
  expect(rec.outcome.measurementUnit.normalized).toBe('mL');
  const vas:any={studyId:'paper',outcome:{name:field('VAS'),measurementRange:field('0-100'),measurementUnit:field('NR','VAS 0-100')}};
  normalizeOutcomeMeasurementUnit(vas,'outcomes.0',[]);
  expect(vas.outcome.measurementUnit.raw).toBe('NR');
 });
 it('standardizes score units as NA and retains their source evidence', () => {
  const rec: OutcomeLevel = {studyId:'p', outcome:{measurementUnit:field('points', 'A 3-point change in score')}};
  normalizeOutcomeMeasurementUnit(rec, 'outcomes.0', []);
  expect(rec.outcome?.measurementUnit).toMatchObject({
   raw:'points', normalized:'NA', unitStatus:'not_applicable',
   evidence:[{quote:'A 3-point change in score'}],
  });
 });
 it('preserves the original unit rather than changing an associated estimate',()=>{
  const rec:any={studyId:'p',outcome:{name:field('surgery duration'),measurementUnit:field('minutes')}};
  normalizeOutcomeMeasurementUnit(rec,'outcomes.0',[]);
  expect(rec.outcome.measurementUnit.raw).toBe('minutes');
  expect(rec.outcome.measurementUnit.normalized).toBe('min');
 });
});
describe('missing outcome data calculation',()=>{
 it('asks for scoped participant counts in the actual per-comparison task',()=>{
  expect(COMPARISON_TASK).toContain('"missingDataEvidence": []');
 });

 it('ITT analyzed n equal to randomized n does not erase missing observations',()=>{
  const result=assessMissingDataFrames([frame()]);
  expect(result.derivedRatio?.raw).toBe('0.1');
  expect(result.frames[0]?.counts.analyzed?.raw).toBe('100');
 });
 it('does not derive from analyzed or dropout counts without observed/missing counts',()=>{
  const f=frame();delete f.counts.observed;f.counts.dropout=field('5');f.counts.imputed=field('10');
  expect(assessMissingDataFrames([f]).derivedRatio).toBeUndefined();
 });
 it('keeps dropout separate from outcome missingness',()=>{
  const f=frame('overall',100,98);f.counts.dropout=field('5');
  expect(assessMissingDataFrames([f]).derivedRatio?.raw).toBe('0.02');
 });
 it('combines two arms using sums rather than averaging percentages',()=>{
  const a=frame('experimental',10,8),b=frame('control',90,81);
  expect(assessMissingDataFrames([a,b]).derivedRatio?.raw).toBe('0.11');
 });
 it('does not combine different times, populations or duplicate arm entries',()=>{
  const a=frame('experimental'),b=frame('control');b.time=field('week 32');
  expect(assessMissingDataFrames([a,b]).derivedRatio).toBeUndefined();
  b.time=field('week 8');b.population=field('per-protocol cohort');
  expect(assessMissingDataFrames([a,b]).derivedRatio).toBeUndefined();
  expect(assessMissingDataFrames([a,structuredClone(a)]) .derivedRatio).toBeUndefined();
 });
 it('does not promote a scope without explicit primary outcome evidence',()=>{
  const f=frame();delete f.primary;
  const result=assessMissingDataFrames([f]);
  expect(result.frames[0]?.derivedRatio?.raw).toBe('0.1');
  expect(result.derivedRatio).toBeUndefined();
 });
 it('keeps original reported percentages and separately normalizes their value',()=>{
  const f=field('3.6%','Missing outcome data affected 3.6% of participants');
  const result=assessMissingDataFrames([],f);
  expect(result.reportedRatio?.raw).toBe('3.6%');
  expect(result.reportedRatio?.normalized).toBe('0.036');
  expect(missingProportion('3.6')).toBeUndefined();
  expect(missingProportion('NR')).toBeUndefined();
 });
 it('flags inconsistent counts and a reported zero that conflicts with observed data',()=>{
  const f=frame();f.counts.missing=field('7');
  expect(assessMissingDataFrames([f]).derivedRatio).toBeUndefined();
  const g=frame();g.reportedRatio=field('0','There were 0 missing outcomes');
  expect(assessMissingDataFrames([g]).frames[0]?.issues.join('')).toContain('冲突');
  expect(assessMissingDataFrames([frame()],field('20%','There were 20% missing outcomes')).issues.join('')).toContain('比例不同');

 });
 it('rejects counts not supported by their cited source',()=>{
  const text='The primary outcome was MRS total change at week 8 in the randomized cohort. The trial group had 100 randomized and 90 observed participants.';
  const doc:MiniDoc={articleId:'p',year:'2026',sourcePdf:'p.pdf',mineruDir:'',schemaVersion:'AA_MINIDOC/1.0',
   blocks:[{index:1,type:'text',section:'results',page:1,bbox:null,text}],pages:[],stats:{totalBlocks:1,pagesCovered:1,tables:0,figures:0,equations:0,droppedNoise:0},warnings:[]};
  const claim=(value:string)=>({value,quote:text,source:{block:1}});
  const c:ComparisonLevel={studyId:'p',missingDataRatio:field('NR',text)};
  const raw=[{role:'overall',group:claim('trial group'),outcome:claim('MRS total change'),time:claim('week 8'),
   population:claim('randomized cohort'),primary:claim('1'),randomized:claim('100'),observed:claim('70')}];
  applyMissingDataAssessment(doc,c,raw,'comparisons.0',[]);
  expect(c.missingData?.derivedRatio).toBeUndefined();
  expect(c.missingDataRatio?.raw).toBe('NR');
  raw[0]!.observed=claim('90');
  applyMissingDataAssessment(doc,c,raw,'comparisons.0',[]);
  expect(c.missingDataRatio?.raw).toBe('0.1');
  expect(c.missingDataRatio?.provenance).toBe('deterministic');

 });
});


it('reviews only the unresolved missing-data population and rejects changed observed counts', async () => {
 const text='The primary outcome was MRS total change at week 8 in the randomized cohort. Alpha had 70 randomized and 60 observed participants. Beta had 80 randomized and 75 observed participants. A separate visit recorded 58 participants.';
 const doc:MiniDoc={articleId:'p',year:'2026',sourcePdf:'p.pdf',mineruDir:'',schemaVersion:'AA_MINIDOC/1.0',
  blocks:[{index:1,type:'text',section:'results',page:1,bbox:null,text}],pages:[],stats:{totalBlocks:1,pagesCovered:1,tables:0,figures:0,equations:0,droppedNoise:0},warnings:[]};
 const claim=(value:string)=>({value,quote:text,source:{block:1}});
 const common={primary:claim('1'),outcome:claim('MRS total change'),time:claim('week 8')};
 const initial=[
  {...common,role:'experimental',group:claim('Alpha'),randomized:claim('70'),observed:claim('60')},
  {...common,role:'control',group:claim('Beta'),randomized:claim('80'),observed:claim('75')},
 ];
 const review=initial.map(item=>({...item,population:claim('randomized cohort')}));
 const c:ComparisonLevel={studyId:'p',missingDataRatio:field('NR',text)};
 const issues:import('@aa/core').Issue[]=[];
 applyMissingDataAssessment(doc,c,initial,'comparisons.0',issues);
 expect(c.missingDataRatio?.raw).toBe('NR');
 await reviewMissingDataScope(doc,c,{invoke:async req=>{
  expect(req.reasoningEffort).toBe('high');
  expect(req.tag).toContain('missing-data-review');
  return {model:'test',text:'',json:{missingDataEvidence:[{...review[0],observed:claim('58')},review[1]]}};
 }},'comparisons.0',issues);
 expect(c.missingDataRatio?.raw).toBe('NR');
 await reviewMissingDataScope(doc,c,{invoke:async()=>({model:'test',text:'',json:{missingDataEvidence:review}})},'comparisons.0',issues);
 expect(c.missingDataRatio?.raw).toBe('0.1');
 expect(c.missingData?.frames[0]?.counts.observed?.raw).toBe('60');
 expect(c.missingData?.frames[0]?.population?.raw).toBe('randomized cohort');
});
