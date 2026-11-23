import fs from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {text,normalizeUnit,normalizeRatio} from './lib/review-format.mjs';
const dir='build/upgrade-accuracy/2026-11-22';
const baseline='build/report/26篇全部字段复评_2026-11-21';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const rows=read(join(baseline,'字段对照.json'));
const semantic=read(join(baseline,'语义判定缓存.json'));
const manifest=read(join(dir,'manifest.json'));
const count=selection=>{
 const s={total:selection.length,correct:0,wrong:0,missed:0,partial:0,unknown:0};
 for(const row of selection)s[row.status]++;
 s.decided=s.total-s.unknown;
 s.accuracy=s.correct/s.decided;
 s.confirmedOverAll=s.correct/s.total;
 return s;
};
function originalStatus(row){
 if(row.status!=='pending')return row.status;
 const v=semantic[row.judgeKey]?.verdict;
 return ['identical','same_meaning'].includes(v)?'correct':v==='contains_correct'?'partial':
  ['has_error','completely_different'].includes(v)?'wrong':'unknown';
}
export function precisionEqual(reference,prediction){
 const r=normalizeRatio(reference),p=normalizeRatio(prediction);
 if(r===undefined||p===undefined)return false;
 if(r===p)return true;
 // Zero and 100% describe endpoints, not a half-unit tolerance around them.
 if(r===0||r===1)return false;
 const raw=text(reference),percent=raw.endsWith('%');
 const places=/\.(\d+)\s*%?$/.exec(raw)?.[1].length??0;
 if(!percent&&!places)return false;
 return normalizeRatio((p*(percent?100:1)).toFixed(places)+(percent?'%':''))===r;
}
assert(precisionEqual('0.94%','0.0094339623'));
assert(precisionEqual('0.07','0.0697674419'));
assert(!precisionEqual('0','0.166667'));
assert(!precisionEqual('0%','0.004'));
assert(!precisionEqual('0.036','0.0305555556'));
assert(!precisionEqual('NR','0'));
assert.equal(rows.filter(r=>/\.(?:measurementUnit|missingDataRatio)$/.test(r.path)).length,170);
assert.equal(manifest.tasks.length,105);
const results=new Map(),missing=[];
for(const t of manifest.tasks){
 const file=join(dir,'tasks',t.key+'.json');
 const result=fs.existsSync(file)?read(file):null;
 if(!result?.ok){missing.push(t.key);continue;}
 for(const path of t.cells){
  assert(!results.has(t.id+'|'+path),'Duplicate target mapping');
  results.set(t.id+'|'+path,{field:result.field,task:t,result});
 }
}
const targeted=row=>/\.(?:measurementUnit|missingDataRatio)$/.test(row.path);
const group=row=>row.path.endsWith('.measurementUnit')?'measurementUnit':'missingDataRatio';
const old=rows.map(r=>({...r,status:originalStatus(r)}));
assert.equal(count(old).correct,4623);
assert.equal(count(old).decided,7358);
function judge(row,pred,precision=false){
 if(row.status==='unknown')return 'unknown';
 if(!text(pred))return 'missed';
 if(text(pred)===text(row.value))return 'correct';
 if(group(row)==='measurementUnit'){
  const r=normalizeUnit(row.value),p=normalizeUnit(pred);
  if(r&&p&&r===p)return 'correct';
 }else{
  const r=normalizeRatio(row.value),p=normalizeRatio(pred);
  if(r!==undefined&&p!==undefined&&(r===p||(precision&&precisionEqual(row.value,pred))))return 'correct';
 }
 // Preserve completed semantic adjudication for unchanged old text.
 if(text(pred)===text(row.pred))return row.status;
 return 'wrong';
}
let before=old.map(r=>targeted(r)?{...r,status:judge(r,r.pred)}:r);
assert.deepEqual(count(before),count(old),'Before scorer must reproduce frozen historical scores');
const detail=old.filter(targeted).map(r=>{
 const result=results.get(r.id+'|'+r.path);
 const pred=result?.field?.raw??(result?'':r.pred);
 const status=result?judge(r,pred):r.status;
 const precisionBefore=judge(r,r.pred,true),precisionAfter=judge(r,pred,true);
 return {...r,oldPred:r.pred,newPred:pred,before:r.status,after:status,precisionBefore,precisionAfter,
  normalized:result?.field?.normalized,unitStatus:result?.field?.unitStatus,
  task:result?.task.key??null,replayed:Boolean(result),
  predictionChanged:text(r.pred)!==text(pred),
  transition:r.status+'->'+status,field:result?.field??null,
  missingData:result?.result.comparison?.missingData??null};
});
const detailMap=new Map(detail.map(r=>[r.id+'|'+r.path,r]));
const after=old.map(r=>targeted(r)?{...r,status:detailMap.get(r.id+'|'+r.path).after}:r);
const precisionBefore=old.map(r=>targeted(r)?{...r,status:detailMap.get(r.id+'|'+r.path).precisionBefore}:r);
const precisionAfter=old.map(r=>targeted(r)?{...r,status:detailMap.get(r.id+'|'+r.path).precisionAfter}:r);
const stats=(b,a)=>({before:count(b),after:count(a),deltaPercentagePoints:100*(count(a).accuracy-count(b).accuracy),
 netCorrect:count(a).correct-count(b).correct});
const subsetStats=(selection,precision=false)=>{
 const b=selection.map(r=>({...r,status:precision?r.precisionBefore:r.before}));
 const a=selection.map(r=>({...r,status:precision?r.precisionAfter:r.after}));
 return {...stats(b,a),fixed:selection.filter(r=>r.before!=='correct'&&r.after==='correct').length,
  regressed:selection.filter(r=>r.before==='correct'&&r.after!=='correct').length,
  changedPredictions:selection.filter(r=>r.predictionChanged).length};
};
const result={at:new Date().toISOString(),complete:missing.length===0,unfinishedTasks:missing,
 method:manifest.method,scope:manifest.scope,
 overall:stats(old,after),precisionAwareOverall:stats(precisionBefore,precisionAfter),
 targets:subsetStats(detail),precisionAwareTargets:subsetStats(detail,true),
 byField:Object.fromEntries(['measurementUnit','missingDataRatio'].map(key=>[key,subsetStats(detail.filter(r=>group(r)===key))])),
 precisionAwareByField:Object.fromEntries(['measurementUnit','missingDataRatio'].map(key=>[key,subsetStats(detail.filter(r=>group(r)===key),true)])),
 byStudy:Object.fromEntries(manifest.scope.map(id=>[id,stats(old.filter(r=>r.id===id),after.filter(r=>r.id===id))])),
 humanReviewed:stats(old.filter(r=>r.reviewed),after.filter(r=>r.reviewed)),
 fixedNonTargets:old.filter(r=>!targeted(r)).length,
 warning:'November reference consistency, not independently verified clinical accuracy. Only target stages rerun; other scores and missed outcomes are frozen. NA/NR/NE are not interchangeable.'};
const dump=(name,value)=>fs.writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n','utf8');
dump('评分汇总.json',result);dump('170格升级对照.json',detail);
const csvValue=value=>'"'+String(value??'').replaceAll('"','""')+'"';
const csv=(name,table)=>fs.writeFileSync(join(dir,name),'\uFEFF'+table.map(row=>row.map(csvValue).join(',')).join('\r\n')+'\r\n','utf8');
csv('170格升级对照.csv',[
 ['研究','字段','参考值','升级前','升级后','升级前判分','升级后判分','按参考精度_前','按参考精度_后','复跑任务','标准单位','单位状态','参考来源','参考行','人工修改记录'],
 ...detail.map(r=>[r.id,r.path,r.value,r.oldPred,r.newPred,r.before,r.after,r.precisionBefore,r.precisionAfter,r.task,r.normalized,r.unitStatus,r.source,r.sourceRow,r.reviewed])
]);
csv('全字段固定口径对照.csv',[
 ['研究','字段','中文字段','11月参考','升级前','升级后','前判分','后判分','本次实际重跑','结局对应路径'],
 ...old.map(r=>{const d=detailMap.get(r.id+'|'+r.path);return [r.id,r.path,r.label,r.value,r.pred,d?.newPred??r.pred,r.status,d?.after??r.status,d?.replayed??false,r.mappedPath];})
]);
const pct=n=>(n*100).toFixed(2)+'%';
const delta=n=>(n>0?'+':'')+n.toFixed(3)+' 个百分点';
const reportRow=(name,s)=>'| '+[name,s.before.correct+'/'+s.before.decided,pct(s.before.accuracy),
 s.after.correct+'/'+s.after.decided,pct(s.after.accuracy),delta(s.deltaPercentagePoints)].join(' | ')+' |';
const changeRows=detail.filter(r=>r.before!==r.after);
const lines=[
 '# 26篇：测量单位与缺失数据升级的整体影响','',
 '评估日期：2026-11-22。'+(result.complete?'全部105个提取任务完成。':'尚有'+missing.length+'个任务未完成，以下为临时结果，不可作最终结论。'),'',
 '使用11月参考、原有26篇结果索引、原有比较组和结局配对。总计7673格，其中315格原有待裁定，主统计固定7358格；正确严格计1，部分正确计0。实际复跑69个已配对结局身份的单位元数据、36个比较组的缺失数据提取，覆盖170个目标参考格中的128格（92格单位、36格缺失比例）。32个未配对单位格和10个单位待裁定固定不变；另1格已配对但原单位为空的项目参与复跑。其余7503格沿用原评分。此为两项升级对历史全字段成绩的控制变量回放，不是四步客户端全流程重新提取的完整验证。','',
 '| 范围 | 升级前正确/已判 | 升级前 | 升级后正确/已判 | 升级后 | 差值 |',
 '|---|---:|---:|---:|---:|---:|',
 reportRow('全部字段（其他字段固定）',result.overall),
 reportRow('测量单位',result.byField.measurementUnit),
 reportRow('缺失数据比例',result.byField.missingDataRatio),
 reportRow('两项合计',result.targets),
 reportRow('有人工核对记录的字段',result.humanReviewed),'',
 '确认一致占全部7673格的比例为 '+pct(result.overall.before.confirmedOverAll)+' → '+pct(result.overall.after.confirmedOverAll)+'；这项覆盖比例将待裁定保留在分母，不等于已判字段准确率。','',
 '总体净变化：'+result.overall.netCorrect+'格；两项中原错误改正确'+result.targets.fixed+'格，原正确改为不一致/漏提'+result.targets.regressed+'格。','',
 '## 比例四舍五入的独立影响','',
 '主表保持旧评估的精确数值一致规则。补充规则将新旧比例均按参考值的报告小数位数四舍五入，百分比与0—1比例统一；0和100%仍须精确相等，NR/NA/NE不互换。补充结果只衡量数值报告精度一致，不能证明组别、结局、时点或人群范围正确。','',
 '| 范围 | 升级前正确/已判 | 升级前 | 升级后正确/已判 | 升级后 | 差值 |',
 '|---|---:|---:|---:|---:|---:|',
 reportRow('全部字段（参考精度规则）',result.precisionAwareOverall),
 reportRow('缺失数据比例（参考精度规则）',result.precisionAwareByField.missingDataRatio),'',
 '补充口径相对主表增加的一致格，分别为升级前'+(result.precisionAwareOverall.before.correct-result.overall.before.correct)+'、升级后'+(result.precisionAwareOverall.after.correct-result.overall.after.correct)+'；它们属于判分精度变化，不能全部计入提取升级收益。','',
 '## 判分变化逐格明细','',
 '| 论文 | 字段 | 11月参考 | 前 → 后 | 判分变化 |',
 '|---|---|---|---|---|',
 ...changeRows.map(r=>'| '+[r.id,r.path,r.value,String(r.oldPred)+' → '+String(r.newPred),r.before+' → '+r.after].map(x=>String(x).replaceAll('|','/')).join(' | ')+' |'),'',
 '## 解释限制','',
 '11月参考有沿用旧提取值，医生未逐项校对SD、CI。本次单位字段中大量参考为NA，而新版要求有证据的points、次数或物理单位，并区分NR与NA；不修改参考时，这些新输出仍按不一致计分。不能将参考一致率直接称为经独立原文核验的真实准确率。','',
 '缺失比例必须区分原文直接报告、同范围人数计算、脱落、插补和纳入分析人数。得到NR可能是证据不足，也可能是新版证据要求过严；应结合170格明细中的missingData.frames和原文证据审核。已填数字不能仅因格式合法而算提取正确。','',
 '所有成功任务均已保存，API响应按请求内容建立缓存。报告未覆盖四步流程中每条长表记录的unit字段；历史参考没有对应的长表金标准。未修改正式提取、人工参考和原评分文件。本次使用已有历史结果作为升级前基线，未同时重跑旧版本；差值包括模型重复提取波动，不能解读为纯代码因果效应。',''
];
fs.writeFileSync(join(dir,'整体准确率提升报告.md'),lines.join('\n'),'utf8');
console.log(JSON.stringify({complete:result.complete,finished:manifest.tasks.length-missing.length,
 overall:result.overall,byField:result.byField,precisionAwareOverall:result.precisionAwareOverall,targets:result.targets},null,2));
