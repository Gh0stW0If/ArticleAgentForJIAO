import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {groundSource,numericSourceTokens,readWorkflowMaterials} from './lib/workflow-materials.mjs';
const root=resolve('.');
const old=join(root,'build/report/26篇全部字段复评_2026-11-21');
const output=join(root,'build/report/逐字段准确率口径核查_2026-11-21');
fs.mkdirSync(output,{recursive:true});
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const scored=read(join(old,'全字段评分.json'));
const rows=read(join(old,'字段对照.json'));
const semantic=read(join(old,'语义判定缓存.json'));
const key=path=>path.replace(/outcomes\.\d+\./,'outcomes.').replace(/comparisons\.\d+\./,'comparisons.');
for(const row of rows){
 if(row.status!=='pending')continue;
 const verdict=semantic[row.judgeKey]?.verdict;
 row.status=['identical','same_meaning'].includes(verdict)?'correct':verdict==='contains_correct'?'partial':['has_error','completely_different'].includes(verdict)?'wrong':'unknown';
}
const pct=value=>value===null||value===undefined?'未评估':(value*100).toFixed(1)+'%';
const csv=(name,records)=>fs.writeFileSync(join(output,name),'\uFEFF'+records.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n');
const fields=Object.entries(scored.byField).map(([path,stats])=>{
 const same=rows.filter(row=>key(row.path)===path);
 const reviewed=same.filter(row=>row.reviewed);
 const known=reviewed.filter(row=>row.status!=='unknown');
 return {path,label:same[0]?.label??path,...stats,reviewedN:reviewed.length,reviewedDecided:known.length,reviewedCorrect:known.filter(row=>row.status==='correct').length,
   reviewedAccuracy:known.length?known.filter(row=>row.status==='correct').length/known.length:null,
   sentinel:same.filter(row=>/^(NR|NA|NE|N\/A)$/i.test(row.value.trim())).length};
});
if(fields.length!==204||rows.filter(row=>row.status==='correct').length!==scored.total.correct)throw new Error('历史统计复核不一致');
const head=['字段路径','原表中文字段','历史参考格数','已判格数','正确','不一致','漏提','部分正确','待裁定','历史严格一致率','人工确有核对记录格数','人工核对已判格数','人工核对正确格数','仅人工已核对一致率','NR/NA/NE参考格数','适用版本'];
csv('204类字段历史准确率_中文明细.csv',[head,...fields.map(f=>[f.path,f.label,f.total,f.decided,f.correct,f.wrong,f.missed,f.partial,f.unknown,pct(f.accuracy),f.reviewedN,f.reviewedDecided,f.reviewedCorrect,pct(f.reviewedAccuracy),f.sentinel,'此前三批定向复跑；不可当作四步版准确率'])]);
const labels={estimate:'估计值',sd:'SD',se:'SE',ciLower:'CI下限',ciUpper:'CI上限',iqrLower:'IQR下限',iqrUpper:'IQR上限',events:'事件数',n:'例数或分母'};
const workflow=join(root,'build/workflow-validation/2026-11-21');
process.env.AA_WORKFLOW_ROOT=workflow;
const scope=read(join(workflow,'_progress.json'));
const numeric=Object.fromEntries(Object.keys(labels).map(k=>[k,{total:0,located:0,native:0}]));
for(const id of Object.keys(scope.papers)){
 const state=read(join(workflow,id.slice(0,4),id,'workflow.json'));
 const materials=await readWorkflowMaterials(root,id.slice(0,4),id);
 for(const r of state.result?.records??[])for(const [field,value] of Object.entries(r.values)){
  const stats=numeric[field];if(!stats)continue;
  stats.total++;
  const evidence=r.evidence[field];
  if(evidence&&groundSource(materials,{...evidence,block:evidence.blockId},value))stats.located++;
  const native=materials.blocks.find(b=>b.type==='native'&&b.documentId===evidence?.documentId&&b.page===evidence?.page);
  if(native&&numericSourceTokens(native.text).includes(Number(value)))stats.native++;
 }
}
csv('四步版_逐数值字段来源验证.csv',[['字段','保留字段数','引句可定位数','引句可定位比例','同页原生文字出现数','同页数字出现比例','金标准准确率'],
 ...Object.entries(numeric).map(([field,s])=>[labels[field],s.total,s.located,pct(s.located/s.total),s.native,pct(s.native/s.total),'尚未完成逐字段金标准评分'])]);
const lines=[
 '# 逐字段准确率及版本口径','',
 '新 Electron 四步版的26篇验收是来源和流程验证，尚未完成按人工金标准逐字段评分。此前报告中的62.8%属于三批定向复跑结果，不能作为四步版准确率。','',
 '## 已有历史准确率','',
 '参考为11月核对表及补充核对工作簿。共7673个参考格，3497个确有人工核对记录，4176个沿用历史提取值。严格一致率＝正确÷（全部参考格−待裁定），漏提和部分正确均不计正确。自然语言差异包含模型语义评分。SD/CI未被医生完整校正，因此相应历史比例只能说明参考一致程度。','',
 '| 范围 | 正确/已判 | 严格一致率 |','| --- | ---: | ---: |',
 ...[['全部字段',scored.total],['人工已核对字段',scored.humanReviewed],...Object.entries(scored.byLayer)].map(([label,s])=>'| '+label+' | '+s.correct+'/'+s.decided+' | '+pct(s.accuracy)+' |'),'',
 '## 四步版当前数值验证','',
 '以下分母仅为已保留字段，不包含拒收、漏提或未报告字段。引句可定位和数字同页出现都不能证明结局、组别、时点及SD/SE类型正确，不能称为准确率。','',
 '| 字段 | 保留数 | 引句可定位 | 同页数字出现 | 金标准准确率 |','| --- | ---: | ---: | ---: | --- |',
 ...Object.entries(numeric).map(([field,s])=>'| '+labels[field]+' | '+s.total+' | '+s.located+'/'+s.total+' | '+s.native+'/'+s.total+' | 未评估 |'),'',
 '## 204类字段完整历史明细','',
 '以下按原表字段路径保留，不把所有时点、组别混成一项。小分母（尤其1—2项）的100%或0%不代表稳定表现。原表部分“变异值上下限”栏也用于历史SD/SE存储，不能直接将其理解为独立CI上下限。','',
 '| 原表字段 | 字段路径 | 正确/已判 | 历史一致率 | 仅人工已核对一致率 |','| --- | --- | ---: | ---: | ---: |',
 ...fields.map(f=>'| '+f.label.replaceAll('|','/')+' | '+f.path+' | '+f.correct+'/'+f.decided+' | '+pct(f.accuracy)+' | '+pct(f.reviewedAccuracy)+' |'),'',
 '## 新版准确率目前缺少什么','',
 '需要把医生实际选择的原文结局，与人工参考的比较组、报告时点及统计口径建立对应，再对估计值、SD、SE、CI、IQR、事件数和分母分别评分；缺失结果也应计入分母。SD和CI还需先补齐原文核实的金标准。不能用保留数字有出处的比例代替这些评价。','',
 '25篇的导入基础字段与此前评分输入完全相同；2023-27有基础取值或编码差异。因此本文不将整套历史基础字段结果直接冠以四步版准确率。','',
 '[完整中文CSV](204类字段历史准确率_中文明细.csv) · [新版来源验证CSV](四步版_逐数值字段来源验证.csv)'
];
fs.writeFileSync(join(output,'逐字段准确率说明与完整明细.md'),lines.join('\n')+'\n');
fs.writeFileSync(join(output,'汇总.json'),JSON.stringify({historical:scored.total,humanReviewed:scored.humanReviewed,fieldTypes:fields.length,currentNumericalSourceChecks:numeric},null,2));
console.log(JSON.stringify({fieldTypes:fields.length,numeric,output},null,2));
