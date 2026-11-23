import fs from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir='build/upgrade-accuracy/2026-11-22';
const read=name=>JSON.parse(fs.readFileSync(join(dir,name),'utf8'));
const summary=read('评分汇总.json'),cells=read('170格升级对照.json'),manifest=read('manifest.json');
if(!summary.complete)throw Error('Wait until all extraction tasks and scoring have completed');
const unit=cells.filter(r=>r.path.endsWith('.measurementUnit'));
const missing=cells.filter(r=>r.path.endsWith('.missingDataRatio'));
const sentinel=value=>/^(NR|NA|NE|N\/A)$/i.test(String(value??'').trim());
const concrete=value=>String(value??'').trim()&&!sentinel(value);
const tally=values=>Object.fromEntries([...new Set(values)].map(x=>[x,values.filter(v=>v===x).length]));
const regressions=unit.filter(r=>r.before==='correct'&&r.after!=='correct').map(r=>({
 id:r.id,path:r.path,reference:r.value,before:r.oldPred,after:r.newPred,
 category:r.value==='NA'?'reference_NA_vs_new_policy':'concrete_unit_disagreement',
 evidence:r.field?.evidence??[]
}));
const accuracy=selection=>({total:selection.length,beforeCorrect:selection.filter(r=>r.before==='correct').length,afterCorrect:selection.filter(r=>r.after==='correct').length});
const concreteUnits=accuracy(unit.filter(r=>concrete(r.value)));
const concreteMissing=accuracy(missing.filter(r=>concrete(r.value)));
const missingStats={
 beforeNumeric:missing.filter(r=>concrete(r.oldPred)).length,
 afterNumeric:missing.filter(r=>concrete(r.newPred)).length,
 beforeNR:missing.filter(r=>r.oldPred==='NR').length,
 afterNR:missing.filter(r=>r.newPred==='NR').length,
 numericToSentinel:missing.filter(r=>concrete(r.oldPred)&&sentinel(r.newPred)).map(r=>({
  id:r.id,path:r.path,reference:r.value,before:r.oldPred,after:r.newPred,
  blockers:r.missingData?.issues??[],
  frames:(r.missingData?.frames??[]).map(f=>({
   role:f.role,status:f.status,issues:f.issues,
   missingScope:['group','outcome','time','population'].filter(k=>!f[k]?.raw||!f[k]?.evidence?.length),
   counts:Object.fromEntries(Object.entries(f.counts??{}).map(([k,v])=>[k,v.raw])),
   primary:f.primary?.raw
  }))
 }))
};
const tasks=manifest.tasks.map(t=>read('tasks/'+t.key+'.json'));
assert(tasks.every(t=>t.ok));
const allCalls=tasks.flatMap(t=>t.calls??[]);
const finiteMs=allCalls.map(c=>c.ms).filter(Number.isFinite).sort((a,b)=>a-b);
const audit={at:new Date().toISOString(),
 goldUnitValues:tally(unit.map(r=>r.value)),concreteUnits,concreteMissing,
 unitRegressions:regressions,unitRegressionCategories:tally(regressions.map(r=>r.category)),
 missingStats,
 calls:{count:allCalls.length,failed:allCalls.filter(c=>!c.ok).length,
  medianMs:finiteMs[Math.floor(finiteMs.length/2)],totalMs:finiteMs.reduce((a,b)=>a+b,0)},
 sourceExample:{
  id:'2018-02',field:'comparisons.0.missingDataRatio',
  sourceCounts:{experimentalRandomized:180,controlRandomized:180,experimentalMissing:6,controlMissing:5},
  calculableRatio:11/360,
  actualAfter:missing.find(r=>r.id==='2018-02')?.newPred,
  explanation:'两组缺失人数、随机人数、主要结局和week 8证据已进入frames，但population未落地；complete规则阻止派生比例。11月参考为0.036，与11/360不同；不修改参考或将此例强行判正确。',
  sourceBlocks:['b58','b62','b41']
 }};
fs.writeFileSync(join(dir,'变化原因审计.json'),JSON.stringify(audit,null,2)+'\n','utf8');
const report=join(dir,'整体准确率提升报告.md');
let text=fs.readFileSync(report,'utf8');
text+='\n## 本次结果的具体诊断\n\n';
text+='单位参考134格中，'+unit.filter(r=>r.value==='NA').length+'格为NA；单位判分退步'+regressions.length+'格，其中参考为NA的'+regressions.filter(r=>r.reference==='NA').length+'格。NA不应为提高分数而与NR、points或次数互换，需要医生统一定义后再建立独立参考。\n\n';
text+='参考中明确填写单位的'+concreteUnits.total+'格，升级前后正确数分别为'+concreteUnits.beforeCorrect+'和'+concreteUnits.afterCorrect+'；参考中填写数值或百分比的'+concreteMissing.total+'格缺失比例，升级前后正确数分别为'+concreteMissing.beforeCorrect+'和'+concreteMissing.afterCorrect+'（主表精确数值规则）。这些子集是预先固定参考按值类型的分层，不替代总体成绩。\n\n';
text+='缺失比例数值输出由'+missingStats.beforeNumeric+'/36格变为'+missingStats.afterNumeric+'/36格，NR由'+missingStats.beforeNR+'格变为'+missingStats.afterNR+'格。参考一致率升高如果主要来自改为NR，并不能单独证明数值抽取能力提高。\n\n';
text+='例如2018-02：原文已提供两组各180人、缺失6和5人（b58、b62），主要结局及week 8见b41；可计算11/360≈0.0305556。但本次population没有落地，完整范围检查阻止计算，输出'+audit.sourceExample.actualAfter+'。11月参考为0.036；旧值与新值均不得因此直接判为真实正确。此例显示需要补全证据关联，不能把全部失败归因于OCR。\n\n';
text+='本次只评估并保留结果，没有据此修改提取规则。下一步优先：核对单位字段NA/NR的定义及原文参考；对已有主要结局、时点和两臂人数的缺失数据补全人群证据关联；复核数值变为NR的'+missingStats.numericToSentinel.length+'格。保留直接报告与派生比例两个字段，避免用宽松默认值换取表面得分。\n';
fs.writeFileSync(report,text,'utf8');
console.log(JSON.stringify({unitRegressionCategories:audit.unitRegressionCategories,
 beforeNumeric:missingStats.beforeNumeric,afterNumeric:missingStats.afterNumeric,
 beforeNR:missingStats.beforeNR,afterNR:missingStats.afterNR,calls:audit.calls},null,2));
