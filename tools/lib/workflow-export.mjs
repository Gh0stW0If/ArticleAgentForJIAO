import { effectiveRecords } from './workflow-store.mjs';

export function workflowExportSheets(state) {
  const basic = [['字段', '取值', '核对人', '证据', '规范值', '来源类型或计算依据']];
  for (const field of state.basic?.fields ?? []) {
    const edit = state.edits['basic:' + field.path];
    basic.push([field.path, edit?.raw ?? field.raw, edit?.reviewer ?? state.confirmations?.['basic:' + field.path]?.reviewer ?? '', (field.evidence ?? []).map(e => 'p' + e.page + ' ' + e.quote).join('\n'), edit ? '' : field.normalized ?? '', edit ? '人工修改' : field.provenance === 'deterministic' ? field.legend ?? '程序推导或规范化' : '原文提取']);
  }
  for (const [i,comparison] of (state.basic?.comparisons ?? []).entries()) {
    for (const [j,frame] of (comparison.missingData?.frames ?? []).entries()) {
      const scope = [frame.group?.raw, frame.outcome?.raw, frame.time?.raw, frame.population?.raw].filter(Boolean).join(' · ');
      for (const [name,field] of Object.entries({ ...frame.counts, reportedRatio: frame.reportedRatio, derivedRatio: frame.derivedRatio })) {
        if (!field) continue;
        basic.push(['比较'+(i+1)+' 缺失口径'+(j+1)+' '+name,field.raw,'',
          (field.evidence??[]).map(e=>'p'+e.page+' '+e.quote).join('\n'),field.normalized??'',scope+'；'+(field.legend??'原文报告')]);
      }
    }
  }
  const candidates = [['候选ID', '结局', '量表', '分域', '已选择', '选择人', '来源']];
  for (const c of state.candidates) candidates.push([
    c.id, c.name, c.instrument, c.domain, state.selection.candidateIds.includes(c.id) ? '是' : '否',
    state.selection.reviewer, c.evidence.map(e => e.documentId + ' p' + e.page + ' ' + e.quote).join('\n'),
  ]);
  const long = [['记录ID', '结局', '量表', '分域', '组别', '比较', '报告时点', '统计口径', '统计量',
    '估计值', 'SD', 'SE', 'CI下限', 'CI上限', 'IQR下限', 'IQR上限', '事件数', '分母', '状态', '证据', '人工确认', '运行时间', '人工修改记录', '测量单位(规范)', '原文单位', '单位状态', '单位来源']];
  for (const r of effectiveRecords(state)) long.push([
    r.id, r.outcome, r.instrument, r.domain, r.group, r.comparison, r.time, r.estimand, r.statistic,
    ...['estimate', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper', 'events', 'n'].map(k => r.values[k] ?? ''),
    state.stages.summary.status === 'stale' ? '选择已更新，旧运行结果' : r.status,
    Object.entries(r.evidence).map(([k,e]) => k + ': ' + e.documentId + ' p' + e.page + ' ' + e.quote).join('\n'),
    r.confirmed?.reviewer ?? '', state.result?.at ?? '',
    (r.humanEdits ?? []).map(e => e.field + '=' + e.raw + ' [' + e.reviewer + ' ' + e.at + ']').join('\n'),
    r.unit?.canonical ?? '',r.unit?.raw ?? '',r.unit?.status ?? 'not_reported',
    r.unit?.source ? r.unit.source.documentId+' p'+r.unit.source.page+' '+r.unit.source.quote : '',
  ]);
  const issues = [['候选ID', '结局', '状态', '缺口或说明']];
  for (const r of state.result?.outcomes ?? []) issues.push([
    r.candidateId, state.candidates.find(c => c.id === r.candidateId)?.name ?? '', r.status,
    [...r.errors, ...r.unreported.map(v => typeof v === 'string' ? v : JSON.stringify(v)),
      ...r.rejected.map(v => v.rejected)].join('\n'),
  ]);
  return [
    { name: '基础字段', rows: basic }, { name: '结局选择', rows: candidates },
    { name: '结局全部时点', rows: long }, { name: '缺口及待核对', rows: issues },
  ];
}
export function workflowCsv(state) {
  const encode = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + workflowExportSheets(state)[2].rows.map(row => row.map(encode).join(',')).join('\r\n');
}
