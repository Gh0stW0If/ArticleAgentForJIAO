import fs from 'node:fs';
import {join} from 'node:path';
const directory='build/report/26篇全部字段复评_2026-11-21';
const read=file=>JSON.parse(fs.readFileSync(join(directory,file),'utf8'));
const rows=read('字段对照.json');
const semantic=fs.existsSync(join(directory,'语义判定缓存.json'))?read('语义判定缓存.json'):{};
const mappings=read('结局配对.json');
const coverage=read('参考值覆盖与排除.json');
for(const row of rows){
 if(row.status!=='pending')continue;
 const result=semantic[row.judgeKey];
 if(['identical','same_meaning'].includes(result?.verdict))row.status='correct';
 else if(result?.verdict==='contains_correct')row.status='partial';
 else if(['has_error','completely_different'].includes(result?.verdict))row.status='wrong';
 else row.status='unknown';
 row.reason=result?.reason??'语义核对尚无结论';
 row.semanticVerdict=result?.verdict??'unknown';
}
const count=selection=>{
 const result={total:selection.length,correct:0,wrong:0,missed:0,partial:0,unknown:0};
 for(const row of selection)result[row.status]++;
 result.decided=result.total-result.unknown;
 result.accuracy=result.decided?result.correct/result.decided:null;
 result.confirmedOverAll=result.total?result.correct/result.total:null;
 result.weighted=result.decided?(result.correct+result.partial*.5)/result.decided:null;
 result.humanReviewed=selection.filter(r=>r.reviewed).length;
 return result;
};
const group=(key,selection=rows)=>Object.fromEntries([...new Set(selection.map(key))].map(value=>[value,count(selection.filter(row=>key(row)===value))]));
const fieldGroup=path=>path.replace(/outcomes\.\d+\./,'outcomes.').replace(/comparisons\.\d+\./,'comparisons.');
const perLayer=group(row=>row.layer),perStudy=group(row=>row.id),perField=group(row=>fieldGroup(row.path));
const all=count(rows),reviewed=count(rows.filter(r=>r.reviewed)),retained=count(rows.filter(r=>!r.reviewed));
const concrete=count(rows.filter(r=>! /^(?:NR|NA|NE|N\/A)$/i.test(r.value.trim())));
const sentinel=count(rows.filter(r=>/^(?:NR|NA|NE|N\/A)$/i.test(r.value.trim())));
if(all.total!==7673||reviewed.total!==3497||new Set(rows.map(r=>r.id)).size!==26)throw Error('字段覆盖或参考来源发生变化，需要复查');
if(['correct','wrong','missed','partial','unknown'].reduce((sum,k)=>sum+all[k],0)!==all.total)throw Error('统计分母不一致');
const dump=(name,value)=>fs.writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n','utf8');
dump('全字段评分.json',{total:all,humanReviewed:reviewed,inheritedValues:retained,concreteReferences:concrete,sentinelReferences:sentinel,byLayer:perLayer,byStudy:perStudy,byField:perField,
 outcomeCoverage:{references:mappings.length,matched:mappings.filter(row=>row.predIndex!==null).length,missed:mappings.filter(row=>row.status==='结局遗漏').length,unresolved:mappings.filter(row=>row.status==='比较组分析口径待裁定').length},
 sources:{humanWorkbook:'人工核对_全部年份_2026-11-03.xlsx',laterWorkbook:'2020-2025 sheet1 核对.xlsx',laterOverrides:coverage.overrides.length,excluded:coverage.excluded.length}});
const encode=x=>'"'+String(x??'').replaceAll('"','""')+'"';
const csv=(name,header,records)=>fs.writeFileSync(join(directory,name),'\uFEFF'+[header,...records].map(row=>row.map(encode).join(',')).join('\r\n')+'\r\n','utf8');
const headings=['研究','层级','原表','字段','中文字段','参考来源','参考文件行号','有人工核对记录','11月参考值','最新复跑值','配对路径','评分','依据'];
const labels={correct:'正确或含义一致',wrong:'不一致',missed:'漏提',partial:'部分正确',unknown:'待裁定'};
csv('全字段评分明细.csv',headings,rows.map(r=>[r.id,r.layer,r.sheet,r.path,r.label,r.source,r.sourceRow,r.reviewed?'是':'沿用历史值',r.value,r.pred,r.mappedPath,labels[r.status],r.reason]));
csv('逐篇统计.csv',['论文','分母','正确','不一致','漏提','部分正确','待裁定','已判字段严格一致率','正确占全体比例'],
 Object.entries(perStudy).sort().map(([id,s])=>[id,s.total,s.correct,s.wrong,s.missed,s.partial,s.unknown,s.accuracy,s.confirmedOverAll]));
csv('逐字段统计.csv',['字段','分母','正确','不一致','漏提','部分正确','待裁定','已判字段严格一致率'],
 Object.entries(perField).sort((a,b)=>a[1].accuracy-b[1].accuracy||b[1].total-a[1].total).map(([field,s])=>[field,s.total,s.correct,s.wrong,s.missed,s.partial,s.unknown,s.accuracy]));
csv('结局配对明细.csv',['论文','人工表结局行','人工表比较组','参考结局名','参考工具','复跑结果行','复跑结局名','复跑工具','状态'],
 mappings.map(m=>[m.id,m.n+1,m.study,m.name,m.instrument,m.predIndex===null?'':m.predIndex+1,m.predName,m.predInstrument,m.status]));
const index=JSON.parse(fs.readFileSync('build/extraction-pilot/november-remaining-16-2026-11-20/26篇结果索引.json','utf8'));
const extra=[];
for(const id of index.scope){
 const doc=JSON.parse(fs.readFileSync(index.results[id].result,'utf8'));
 const covered=new Set(rows.filter(r=>r.id===id&&r.mappedPath).map(r=>r.mappedPath));
 function walk(node,path){
  if(!node||typeof node!=='object')return;
  if(typeof node.raw==='string'){
   if(node.raw.trim()&&!covered.has(path)&&!/(?:literatureCode|armNumber)$/.test(path))extra.push({id,path,value:node.raw,reason:'参考表无可评分的对应字段或行尚待裁定'});
   return;
  }
  for(const [k,v]of Object.entries(node))walk(v,path?path+'.'+k:k);
 }
 walk(doc.article,'');
 walk(doc.comparisons,'comparisons');
 doc.outcomes.forEach((row,n)=>{for(const key of ['outcome','followUp','timepoints'])walk(row[key],'outcomes.'+n+'.'+key);});
}
csv('无参考对应的提取值.csv',['研究','提取路径','提取值','状态'],extra.map(r=>[r.id,r.path,r.value,r.reason]));
dump('无参考对应的提取值.json',extra);
const pct=ratio=>ratio===null?'—':(100*ratio).toFixed(1)+'%';
const tableRow=(name,s)=>'| '+[name,s.total,s.correct,s.wrong,s.missed,s.partial,s.unknown,pct(s.accuracy)].join(' | ')+' |';
const lines=[
 '# 26 篇论文全部字段复评','',
 '2026 年 11 月 21 日。逐篇使用三批定向复跑结果索引中的最新 JSON，参考值来自 11 月人工核对表。补充核对工作簿的已填写内容及明确修改优先。字段逐项计数，描述性差异使用当前项目模型进行语义核对。','',
 '参考字段共 '+all.total+' 个，其中 '+reviewed.total+' 个有人工确认、修改或补充表核对记录，'+retained.total+' 个沿用核对表中的历史提取值。另有 '+coverage.excluded.length+' 个参考为空或属于标识、人工流程的格子，记录在参考值覆盖与排除文件。','',
 '| 范围 | 全部分母 | 正确 | 不一致 | 漏提 | 部分正确 | 待裁定 | 已判字段严格一致率 |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
 tableRow('全部有参考值字段',all),tableRow('人工已核对字段',reviewed),tableRow('表中沿用历史值',retained),
 tableRow('参考为具体内容',concrete),tableRow('参考为 NR/NA/NE',sentinel),
 ...Object.entries(perLayer).map(([name,s])=>tableRow(name,s)),'',
 '已判字段严格一致率为“正确／（全部分母−待裁定）”。部分正确在严格一致率中计 0 分。正确占全部参考字段的比例为 '+pct(all.confirmedOverAll)+'，把部分正确按 0.5 分计算的已判字段加权一致率为 '+pct(all.weighted)+'。','',
 '## 逐篇结果','',
 '| 论文 | 全部分母 | 正确 | 不一致 | 漏提 | 部分正确 | 待裁定 | 已判字段严格一致率 |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
 ...Object.entries(perStudy).sort().map(([id,s])=>tableRow(id,s)),'',
 '## 判定和覆盖范围','',
 '- 数值、编码、比例和可换算单位采用确定性规则。SD/SE 历史重复存两栏时，仅在估计值、例数、估计类型和离散度全部相符时兼容为同一单值。',
 '- 结局按比较组、名称与量表配对，保留已核查的行对应表，其他行采用文本匹配。匹配不使用待评分的结果数值。未配到的参考结局，其已有参考字段均计漏提。',
 '- 2023-27 的结局比较组分析口径仍待裁定，该篇相关字段列为待裁定。语义评审无法明确判定的项目也保留该状态。',
 '- 医生曾说明 SD 和 CI 未完整人工矫正。统计覆盖核对表中的可评分值，原文核验中的修正结果另见既有报告。本表衡量与 11 月留存参考值的全字段一致程度。',
 '- '+mappings.filter(r=>r.predIndex!==null).length+'/'+mappings.length+' 条参考结局行已配对，'+mappings.filter(r=>r.status==='结局遗漏').length+' 条缺少对应行，'+mappings.filter(r=>r.status==='比较组分析口径待裁定').length+' 条待裁定。人工表未列出的真实结局遗漏需要完整结局清单才能另计。',
 '- 另有 '+extra.length+' 个已提取字段无可评分的参考对应，明细中保留，供核查是否属于新增正确提取或参考缺项。',
 '- 本轮包含未报告、不适用等哨兵值，它们在全部字段中各计一次。自然语言语义相同计 1 分，信息部分正确单列。','',
 '[全字段明细](全字段评分明细.csv) · [逐字段统计](逐字段统计.csv) · [逐篇统计](逐篇统计.csv) · [结局配对](结局配对明细.csv) · [机器可读汇总](全字段评分.json)',
];
fs.writeFileSync(join(directory,'全字段准确率报告.md'),lines.join('\n')+'\n','utf8');
console.log(JSON.stringify({all,reviewed,retained,perLayer,outcomeCoverage:{total:mappings.length,matched:mappings.filter(m=>m.predIndex!==null).length},extras:extra.length}));
