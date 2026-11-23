import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {readWorkflowMaterials,groundSource,numericSourceTokens} from './lib/workflow-materials.mjs';
import {buildXlsx} from './lib/xlsxwrite.mjs';
import {atomicJson} from './lib/workflow-store.mjs';
const root=resolve('.');
const output=join(root,'build/workflow-validation/2026-11-21');
process.env.AA_WORKFLOW_ROOT=output;
const progress=JSON.parse(fs.readFileSync(join(output,'_progress.json'),'utf8'));
const rows=[['论文','批次状态','模型候选','参考名单数','自动名称对齐','测试补加数','结局记录数','SD字段','CI组数','SE字段','IQR组数','待核对记录','失败结局','拒收条目']];
const numeric=[['论文','结局','组别','时点','字段','值','文档','页','原文引句','本地来源复核','同页PDF原生数字核对']];
const failures=[['论文','结局','状态','说明']];
let completed=0,records=0,review=0,failedOutcomes=0,rejected=0,sd=0,ci=0,se=0,iqr=0,fields=0,grounded=0,nativeNumbers=0;
const reasons={};
const zeroRecordPapers=[];
let papersWithRecords=0;
const numberTokens=numericSourceTokens;
for(const [id,paper] of Object.entries(progress.papers)){
 const file=join(output,id.slice(0,4),id,'workflow.json');
 let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 if(paper.status==='completed')completed++;
 const local={records:0,review:0,failed:0,rejected:0,sd:0,ci:0,se:0,iqr:0};
 if(state?.result){
  const material=await readWorkflowMaterials(root,id.slice(0,4),id);
  for(const record of state.result.records){
   local.records++;if(record.status==='needs_review')local.review++;
   for(const type of ['sd','se'])if(record.values[type]!==undefined)local[type]++;
   if(record.values.ciLower!==undefined&&record.values.ciUpper!==undefined)local.ci++;
   if(record.values.iqrLower!==undefined&&record.values.iqrUpper!==undefined)local.iqr++;
   for(const [key,value] of Object.entries(record.values)){
    const evidence=record.evidence[key];fields++;
    const check=evidence&&groundSource(material,{...evidence,block:evidence.blockId},value);
    if(check)grounded++;
    const page=material.blocks.find(b=>b.type==='native'&&b.documentId===evidence?.documentId&&b.page===evidence?.page);
    const original=page?numberTokens(page.text).includes(Number(value)):false;
    if(original)nativeNumbers++;
    numeric.push([id,record.outcome,record.group,record.time,key,value,evidence?.documentId??'',evidence?.page??'',evidence?.quote??'',check?'可定位':'需核对',page?(original?'数字出现于同页':'未找到同页数字'):'无原生文字']);
   }
  }
  for(const outcome of state.result.outcomes){
   if(outcome.status==='failed')local.failed++;
   local.rejected+=outcome.rejected.length;
   const name=state.candidates.find(c=>c.id===outcome.candidateId)?.name??'';
   for(const reason of [...outcome.errors,...outcome.rejected.map(r=>r.rejected)]){
    reasons[reason]=(reasons[reason]??0)+1;
    failures.push([id,name,outcome.status,reason]);
   }
  }
 }
 if(local.records)papersWithRecords++;else zeroRecordPapers.push(id);
 rows.push([id,paper.status,paper.candidateCount??state?.candidates.filter(c=>c.origin==='model').length??'',paper.referenceSelections??'',paper.referenceFound??'',paper.manualTestAdditions??'',local.records,local.sd,local.ci,local.se,local.iqr,local.review,local.failed,local.rejected]);
 records+=local.records;review+=local.review;failedOutcomes+=local.failed;rejected+=local.rejected;sd+=local.sd;ci+=local.ci;se+=local.se;iqr+=local.iqr;
}
const metrics={papersWithRecords,zeroRecordPapers,at:new Date().toISOString(),completed,total:Object.keys(progress.papers).length,records,review,failedOutcomes,rejected,sd,ci,se,iqr,numericFields:fields,sourceGrounded:grounded,nativeNumericPresence:nativeNumbers,reasons};
atomicJson(join(output,'验收统计.json'),metrics);
fs.writeFileSync(join(output,'四步工作流验收.xlsx'),buildXlsx([{name:'逐篇运行',rows},{name:'数值来源核对',rows:numeric},{name:'失败与拒收',rows:failures}]));
const table=rows.map(row=>'| '+row.map(value=>String(value).replaceAll('|','/')).join(' | ')+' |');
table.splice(1,0,'|'+rows[0].map(()=>'---').join('|')+'|');
const report='# 四步提取客户端验收\n\n'+
 '生成时间 '+new Date().toLocaleString('zh-CN')+'。\n\n'+
 '实现流程为 AI 基础字段 → AI 结局候选 → 医生勾选名称 → AI 汇总所选结局。交付 Windows 便携版 0.2.0，保留原字段核对页面。\n\n'+
 '本次26篇批量验收已结束处理 '+completed+'/'+metrics.total+' 篇；可用数值记录 '+records+' 条，其中 '+review+' 条有待核对标记。失败结局 '+failedOutcomes+' 个，拒收数值记录 '+rejected+' 条。失败请求与拒收记录保留，没有当作准确结果。\n\n'+
 '保留字段中 SD '+sd+' 个、完整 CI '+ci+' 组、SE '+se+' 个、IQR '+iqr+' 组。'+fields+' 个数值字段中 '+grounded+' 个能重新定位到保存的来源引句；'+nativeNumbers+' 个数字也出现在对应 PDF 的同页原生文字中。数字在同页出现只用于排查 OCR 差异，不能证明结局、组别与时点归属正确，也不是临床准确率。\n\n'+
 '基础字段批量复用已有抽取；另以 2015-06 真实调用基础阶段，生成157个字段、两个比较组。该文章正文与表格存在人数冲突，界面会提示核对。结局候选及汇总使用本轮实际 API 响应与成功响应缓存。医生勾选步骤由11月人工参考名单模拟，选择和人工补加仅写入隔离验收目录，不修改金标准。\n\n'+
 '旧参考名单存在“quality of life”等宽泛名称，而原文使用具体量表或分域。自动名称对齐与未对齐补加数只能描述回归测试的匹配过程，不能用作候选召回率或字段准确率。最终临床表现仍需医生确认所选原文结局后评估。\n\n'+
 '已验证选择保存和重载、人工补加、结果修改和确认、Excel四表导出、真实附件文档切换、Electron启动、PDF显示及随包解析运行时。自动化测试包括错组取数、跨单元格SD、区间同源关系、均值与离散度顺序、分域冲突、时点缺失以及响应正文超时。\n\n'+
 '建议当前作为医生核对工具使用。候选名称需要浏览和筛选；缺失附件、源表口径冲突、API 超时以及未能确认的 SD/CI 仍需人工处理。Excel 包含逐篇状态、每个数字的来源，以及失败和拒收原因。\n\n'+table.join('\n')+'\n';
const demoPath=join(root,'build/workflow-selected-demo/checks.json');
let extra='\n## 当前可用程度\n\n四步操作、选择留痕、证据跳转、缓存复用和结果导出已经可用。26篇中 '+papersWithRecords+' 篇形成了可保留的数值记录；暂未形成数值记录的论文为 '+zeroRecordPapers.join('、')+'。这些情况包含原文未提供精确数值、名称/量表范围不一致、引用无法定位以及 API 失败。不能据此宣称已实现无人复核的完整抽取。\n\n';
if(fs.existsSync(demoPath)){
 const demo=JSON.parse(fs.readFileSync(demoPath,'utf8'));
 extra+='原文候选示例另保存在 build/workflow-selected-demo。2017-05 按原文候选选择呕吐发生率后，形成'+demo.records+'条去重记录，覆盖两组、六个报告时点；MDASI 仅有文字比较描述，未生成均值或 SD。该示例不计入26篇参考名单回归的汇总数字。\n\n';
}
extra+='交付检查包括44项针对性自动化测试（29项 API 客户端测试、15项工作流测试），以及真实界面的选择保存、重载、补加、修改、确认、Excel导出与附件显示。Windows程序已实际启动测试，最终交付包还会校验源码一致性、随包运行依赖及私有配置未被打包。\n';
fs.writeFileSync(join(output,'验收报告.md'),report+extra);
console.log(JSON.stringify(metrics,null,2));
