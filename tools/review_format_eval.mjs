
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  text as norm, number, sexCounts, compareLegacySexDistribution, normalizeUnit,
  normalizeRatio, ratioAtReportedPrecision, normalizePValue, normalizeDispersion,
  equivalentDuplicateSD,
} from './lib/review-format.mjs';

// Fixed cohort and reviewed row correspondences from the first November comparison.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
import {readReviewTables} from './import_review.mjs';
import {readWorkbook} from './lib/xlsx.mjs';
const folder=fs.readdirSync('Datas/design').find(d=>d.startsWith('2026-11'));
const d='Datas/design/'+folder, names=fs.readdirSync(d);
const dirs=['build/reextract-backups/20261116-192556-234','build/extraction'];
const maps={'2015-06':[0,1,2,3,4,5,null],'2016-01':[null,null,0,null,1,null,null,null],'2016-02':[0,1,2],'2016-03':[0,null,null,null,null,null,null],'2017-05':[null,0],'2017-12':[null,null,null,null,0,null,null,null,null,1],'2017-17':[0,1,2,3,4,5,6,7,8],'2018-02':[0,4,1,2,3,5,6,null,null],'2019-06':[0,1,1],'2019-07':[null,null,null,1,null],'2020-17':[0,1,2,3]};
const ids=Object.keys(maps);
const docs=new Map(ids.map(id=>[id,dirs.map(a=>JSON.parse(fs.readFileSync(a+'/'+id.slice(0,4)+'/'+id+'.json','utf8')))]));
const numeric=/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*%)?$/, codes=/^\d+(?:\s*[/;,]\s*\d+)+$/, sent=/^(nr|na|n\/a|ne)$/;
const week=/^(?:wks?|weeks?)\.?\s*(\d+)$|^(\d+)\s*(?:wks?|weeks?)$/;
function equals(a,b){
  let x=norm(a),y=norm(b);
  if(!x||!y)return false;
  if(x===y)return true;
  if(numeric.test(x)&&numeric.test(y))return x.endsWith('%')===y.endsWith('%')&&Number(x.replace('%',''))===Number(y.replace('%',''));
  if(codes.test(x)&&codes.test(y))return x.replace(/\s+/g,'')===y.replace(/\s+/g,'');
  if(week.test(x)&&week.test(y))return x.match(week).slice(1).find(Boolean)===y.match(week).slice(1).find(Boolean);
  return x.replace(/^n\/a$/,'na')===y.replace(/^n\/a$/,'na');
}
const source=new Map();
for(const t of readReviewTables(fs.readFileSync(d+'/'+names.find(x=>x.endsWith('2026-11-03.xlsx'))),'xlsx')){
  for(const r of t.rows){
    const id=r[2]?.replace(/^-+/,'');
    if(docs.has(id)&&r[10]&&norm(r[13]))source.set(id+'|'+r[6],{id,f:r[6],reviewed:r[13],tab:t.tag});
  }
}
const free=readWorkbook(fs.readFileSync(d+'/'+names.find(x=>x.startsWith('2020-2025'))));
const f1={10:'authorContact',16:'acuteOrSurgery',23:'comparisons.0.controlTypeConverted',29:'comparisons.0.stratificationBlocking',33:'comparisons.0.practitionerCommunication',40:'comparisons.0.pointLocationClass'};
const f2={2:'title',3:'studyOutcomes.primaryOutcome',4:'studyOutcomes.pain',5:'studyOutcomes.nonPain',6:'studyOutcomes.function',7:'studyOutcomes.qualityOfLife',8:'studyOutcomes.importantEvents',9:'studyOutcomes.mortality',10:'studyOutcomes.remarks'};
for(const sh of free.sheets)for(const r of sh.rows) {
  const id=String(r.cells[0]??'').trim();
  if(!docs.has(id))continue;
  for(const [i,v] of r.cells.entries()){
    const m=/(?:\u5e94(?:\u8be5)?\s*(?:\u6539\u4e3a|\u4e3a)|\u6539\u4e3a)\s*[:\uff1a]?\s*([\s\S]+)/.exec(v??'');
    const f=(sh.name==='Sheet1'?f1:f2)[i];
    if(m&&f)source.set(id+'|'+f,{id,f,reviewed:m[1].trim().replace(/\uff09$/,''),tab:sh.name});
  }
}

function fieldAt(doc, id, path, side) {
  const parts = path.split('.');
  if (parts[0] === 'outcomes') {
    const index = Number(parts[1]);
    parts[1] = side === 0
      ? (id === '2019-06' && index === 2 ? 1 : index)
      : maps[id][index];
    if (parts[1] == null) return {};
  }
  const root = ['outcomes', 'comparisons'].includes(parts[0]) ? doc : doc.article;
  const get = keys => keys.reduce((v, key) => v?.[key], root);
  return {
    field: get(parts),
    comparison: parts[0] === 'comparisons' ? get(parts.slice(0, 2)) : undefined,
    block: parts[2] === 'timepoints' && parts[4] === 'continuous' ? get(parts.slice(0, 5)) : undefined,
    group: parts[5],
  };
}

function sameRatioContext(oldRow, newRow, reference) {
  if (!equals(oldRow.field?.raw, reference)) return undefined;
  const counts = row => ['dropoutTotal', 'randomizedN'].map(key => number(row.comparison?.[key]?.raw));
  const [n, d] = counts(oldRow);
  const [newN, newD] = counts(newRow);
  if (n === newN && d === newD && ratioAtReportedPrecision(reference, n, d) &&
      ratioAtReportedPrecision(newRow.field?.raw, n, d)) return { numerator: n, denominator: d, ratio: n / d };
  return undefined;
}

function compare(row, oldRow, newRow) {
  const reference = row.reviewed;
  const current = newRow.field?.raw;
  const legacyMatch = equals(reference, current);
  const key = row.f.split('.').at(-1);
  const result = (rule, ref, pred, equal = legacyMatch) => ({ rule, ref, pred, equal });

  if (key === 'sexDistribution') {
    const scoped = compareLegacySexDistribution(reference, oldRow.comparison, newRow.comparison);
    if (scoped) return result('按组或合计对齐性别', scoped.reference, scoped.current, scoped.equal);
  }
  if (key === 'sexExperimental' || key === 'sexControl') {
    const ref = sexCounts(reference);
    const pred = sexCounts(current);
    if (ref && pred) return result('男女人数', ref, pred, ref.male === pred.male && ref.female === pred.female);
  }
  if (key === 'measurementUnit') {
    const ref = normalizeUnit(reference);
    const pred = normalizeUnit(current);
    return result('单位代码', ref ?? reference, pred ?? current, ref && pred ? ref === pred : legacyMatch);
  }
  if (key === 'missingDataRatio') {
    const ref = normalizeRatio(reference);
    const pred = normalizeRatio(current);
    if (ref !== undefined && pred !== undefined) {
      if (ref === pred) return result('比例', ref, pred, true);
      const context = sameRatioContext(oldRow, newRow, reference);
      return context
        ? result('同分子分母的精度差', context, context, true)
        : result('比例', ref, pred, false);
    }
  }
  if (key === 'pValue') {
    const ev = equals(reference, oldRow.field?.raw) ? oldRow.field?.evidence : [];
    const ref = normalizePValue(reference, ev);
    const pred = normalizePValue(current, newRow.field?.evidence);
    if (ref && pred) {
      const explicit = ref.operator !== 'unspecified' && pred.operator !== 'unspecified';
      return result('P 值保留关系符', ref, pred,
        explicit ? ref.operator === pred.operator && ref.value === pred.value : legacyMatch);
    }
    return result('P 值保留关系符', ref ?? reference, pred ?? current);
  }
  if (newRow.group && ['ciLower', 'ciUpper'].includes(key) && row.f.includes('.continuous.')) {
    const one = normalizeDispersion(oldRow.block, newRow.group);
    const two = normalizeDispersion(newRow.block, newRow.group);
    if (key === 'ciUpper' && equivalentDuplicateSD(reference, oldRow.block, newRow.block, newRow.group)) {
      return result('重复 SD／SE 合并为一个值', one, two, true);
    }
  }

  return result('原字段比较', reference, current);
}

const rows = [];
for (const row of source.values()) {
  const g = norm(row.reviewed);
  if (!numeric.test(g) && !codes.test(g) && !sent.test(g)) continue;
  const [oldDoc, newDoc] = docs.get(row.id);
  const oldRow = fieldAt(oldDoc, row.id, row.f, 0);
  const newRow = fieldAt(newDoc, row.id, row.f, 1);
  const strictOld = equals(row.reviewed, oldRow.field?.raw);
  const strictNew = equals(row.reviewed, newRow.field?.raw);
  const normalizedOld = compare(row, oldRow, oldRow).equal;
  const normalized = compare(row, oldRow, newRow);
  rows.push({ ...row, strictOld, strictNew, normalizedOld, oldValue: oldRow.field?.raw, newValue: newRow.field?.raw, normalized });
}

const summary = selected => ({
  total: selected.length,
  old: selected.filter(r => r.strictOld).length,
  normalizedOld: selected.filter(r => r.normalizedOld).length,
  raw: selected.filter(r => r.strictNew).length,
  normalized: selected.filter(r => r.normalized.equal).length,
  gains: selected.filter(r => !r.strictNew && r.normalized.equal).length,
  losses: selected.filter(r => r.strictNew && !r.normalized.equal).length,
});
const whole = summary(rows);
if (whole.total !== 1472 || whole.old !== 1465 || whole.raw !== 864) {
  throw Error('Cohort or raw baseline changed. Verify review values and outcome row correspondence before comparing.');
}
const relevant = [
  ['性别分布', r => r.f.endsWith('.sexDistribution')],
  ['测量单位', r => r.f.endsWith('.measurementUnit')],
  ['缺失数据比例', r => r.f.endsWith('.missingDataRatio')],
  ['P 值', r => r.f.endsWith('.pValue')],
  ['各组离散度字段', r => /\.continuous\.(?:experimental|control)\.ci(?:Lower|Upper)$/.test(r.f)],
];
const focus = relevant.map(([label, scope]) => [label, summary(rows.filter(scope))]);
const changed = rows.filter(r => r.strictNew !== r.normalized.equal);
const count = (n, d) => n + '/' + d + '（' + (100 * n / d).toFixed(1) + '%）';
const md = [
  '# 11 篇提取格式规范化复评',
  '',
  '沿用 11 月人工核对表和已配对的 11 篇。固定 1,472 个历史字段，新旧产物保留原值。该表衡量与人工核对表留存值的一致程度。旧版在同一规则下也做规范化复评。',
  '',
  '| 字段 | 旧版规范化后 | 新版未统一格式 | 新版统一格式后 | 新版恢复匹配 | 新版识别出原先漏判的差异 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...[['全部字段',whole],...focus].map(([label,w]) => '| '+[label,count(w.normalizedOld,w.total),count(w.raw,w.total),count(w.normalized,w.total),w.gains,w.losses].join(' | ')+' |'),
  '',
  '## 判分变化明细',
  '',
  '| 研究 | 历史字段 | 规则 | 11 月留存值 | 新版原值 | 复评 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...changed.map(r => '| '+[r.id,r.f,r.normalized.rule,r.reviewed,r.newValue ?? '空',r.normalized.equal?'恢复匹配':'仍有实质差异'].map(s=>String(s).replaceAll('|','\\|')).join(' | ')+' |'),
  '',
  '两组分别储存性别，三表展示也可按组或合计选择。单位别名可以统一，未报告和不适用各自保留。缺失比例只有在分子分母相同且两份原值均符合各自精度时才合并。单个 SD／SE 只有在估计类型、估计值、例数和离散度均对应时才兼容旧双栏。',
  '',
  '11 月表中的每个字段仍各计一次。历史上重复存入两列的 SD 会在对照明细显示为同一个规范值。完整性、组别归属、结局覆盖以原文复核为准。',
];
const encode = value => {
  const str = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return '"' + str.replaceAll('"','""') + '"';
};
const headers = ['研究','工作表','字段','11月留存值','旧版原值','新版原值','规范化参考','规范化新版','规则','旧版原值命中','新版原值命中','新版规范化命中','旧版规范化命中'];
const csv = [headers,...rows.map(r => [
  r.id,r.tab,r.f,r.reviewed,r.oldValue,r.newValue,r.normalized.ref,r.normalized.pred,r.normalized.rule,
  +r.strictOld,+r.strictNew,+r.normalized.equal,+r.normalizedOld,
])].map(line=>line.map(encode).join(',')).join('\r\n');
fs.mkdirSync('build/report', { recursive:true });
fs.writeFileSync('build/report/11篇格式规范化复评_2026-11-18.md',md.join('\n')+'\n');
fs.writeFileSync('build/report/11篇格式规范化复评明细_2026-11-18.csv','\uFEFF'+csv+'\r\n');
console.log(JSON.stringify({whole,focus,changes:changed.map(r=>[r.id,r.f,r.reviewed,r.newValue,r.normalized])}));
