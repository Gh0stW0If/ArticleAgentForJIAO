import { useCallback, useEffect, useRef, useState } from 'react';
import { T, R, SH, ghostBtn, primaryBtn, input as inputS } from './theme.ts';

export interface WorkflowEvidence {
  documentId?: string;
  page: number;
  bbox?: [number, number, number, number] | null;
  quote: string;
}
interface Candidate {
  id: string; name: string; instrument: string; domain: string; primary: boolean;
  evidence: WorkflowEvidence[]; origin: string; sourceStatus: string;
}
interface RecordRow {
  id: string; candidateId: string; outcome: string; instrument: string; domain: string;
  group: string; comparison: string; time: string; estimand: string; statistic: string;
  unit?: { raw: string; canonical?: string; status: string; source?: WorkflowEvidence; origin?: string };
  values: Record<string, string>; evidence: Record<string, WorkflowEvidence>; scopeSource: WorkflowEvidence;
  issues: string[]; status: string; humanEdits?: { field: string; reviewer: string }[]; confirmed?: { reviewer: string } | null;
}
interface Stage {
  status: string; message?: string; completed?: number; total?: number; errors?: string[];
}
interface Workflow {
  year: string; study: string; revision: number; candidates: Candidate[];
  sources?: { id: string; name: string; attachment: boolean; pages?: number }[];
  selection: { revision: number; candidateIds: string[]; reviewer: string };
  stages: Record<'basic' | 'candidates' | 'summary', Stage> & { review?: Stage };
  review?: {
    at: string; effort: string | null; checked: number; unchecked: number;
    findings: {recordId: string; field: string; reason: string; source: WorkflowEvidence}[];
  };
  reviewCurrent?: boolean;
  basic?: { fields: { path: string; label?: string; raw: string; normalized?: string; provenance?: string; legend?: string; evidence?: WorkflowEvidence[] }[]; comparisons?: { missingData?: { frames: MissingFrame[]; issues: string[] } }[]; at: string; status: string; issues?: { message: string; path?: string; evidence?: WorkflowEvidence[] }[] };
  edits: Record<string, { raw: string; reviewer: string }>;
  confirmations?: Record<string, { reviewer: string }>;
  effectiveRecords: RecordRow[];
  result?: { at: string; outcomes: { candidateId: string; status: string; rejected: { rejected: string }[]; errors: string[]; unreported: unknown[] }[] };
  warnings?: string[];
}
interface MissingScalar { raw: string; normalized?: string; legend?: string; evidence?: WorkflowEvidence[] }
interface MissingFrame {
  role: string; group?: MissingScalar; outcome?: MissingScalar; time?: MissingScalar; population?: MissingScalar;
  counts: Record<string, MissingScalar>; reportedRatio?: MissingScalar; derivedRatio?: MissingScalar; status: string; issues: string[];
}
interface Props {
  year: string; study: string; reviewer: string;
  onSource(source: WorkflowEvidence): void;
}
const box: React.CSSProperties = {
  background: T.bg, border: '1px solid ' + T.border, borderRadius: R.card, padding: 12, boxShadow: SH.card,
};
const titles = ['基础字段', '结局候选', '人工选择', '选中结局汇总'];
const states: Record<string, string> = {
  idle: '待开始', running: '运行中', done: '已完成', failed: '失败', partial: '部分完成',
  interrupted: '已中断', stale: '选择已更新', imported: '已有结果',
};
const fields: Record<string, string> = {
  estimate: '估计值', sd: 'SD', se: 'SE', ciLower: 'CI 下限', ciUpper: 'CI 上限',
  iqrLower: 'IQR 下限', iqrUpper: 'IQR 上限', events: '事件数', n: '例数',
};
export function WorkflowPanel({ year, study, reviewer, onSource }: Props) {
  const [data, setData] = useState<Workflow | null>(null);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingStage, setPendingStage] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualInstrument, setManualInstrument] = useState('');
  const [editing, setEditing] = useState<{ recordId?: string; path?: string; field?: string; candidateId?: string; instrument?: string; raw: string } | null>(null);
  const context = useRef('');
  const activeContext = year + '/' + study;
  context.current = activeContext;
  const api = '/api/workflow';
  const params = '?year=' + encodeURIComponent(year) + '&study=' + encodeURIComponent(study);
  const fetchState = useCallback(async (keepDraft = false) => {
    if (!study) return;
    const expected = year + '/' + study;
    try {
      const response = await fetch(api + params);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '读取失败');
      if (context.current !== expected) return;
      setData(value);
      if (!keepDraft) { setSelected(value.selection.candidateIds); setDirty(false); }
      if (Object.values(value.stages as Record<string, Stage>).some(s => s.status !== 'idle')) setPendingStage(false);
    } catch (error) {
      if (context.current === expected) setMessage((error as Error).message);
    }
  }, [params, study, year]);
  useEffect(() => {
    setData(null); setSelected([]); setDirty(false); setStep(0); setQuery(''); setMessage(''); setPendingStage(false);
    setEditing(null); setBusy(false);
    void fetchState();
  }, [fetchState]);
  const running = pendingStage || Boolean(data && Object.values(data.stages).some(s => s.status === 'running'));
  useEffect(() => {
    if (!study) return;
    const timer = setInterval(() => { void fetchState(dirty); }, 1800);
    return () => clearInterval(timer);
  }, [study, fetchState, dirty]);
  const post = async (path: string, body: unknown) => {
    const expected = activeContext;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(api + path + params, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '操作失败');
      if (context.current === expected) await fetchState(path === '/candidate' && dirty);
      return context.current === expected;
    } catch (error) {
      if (context.current === expected) setMessage((error as Error).message);
      return false;
    } finally { if (context.current === expected) setBusy(false); }
  };
  const run = async (stage: string) => {
    if ((stage === 'summary' || stage === 'review') && dirty) { setMessage('请先保存选择'); return; }
    setPendingStage(true);
    const ok = await post('/run', { stage, selectionRevision: data?.selection.revision });
    if (!ok) setPendingStage(false);
    else setMessage('任务已启动，可在此查看进度');
  };
  const saveSelection = async () => {
    const ok = await post('/select', { reviewer, candidateIds: selected, revision: data?.selection.revision });
    if (ok) { setDirty(false); setStep(3); setMessage('选择已保存，可以开始汇总'); }
  };
  const sourceButton = (evidence: WorkflowEvidence | undefined, text = '查看原文') => evidence ? (
    <button type="button" style={ghostBtn(T.blue)} onClick={() => onSource(evidence)}>{text + (data?.sources?.find(s => s.id === evidence.documentId)?.attachment ? ' · 附件' : '') + ' · p' + evidence.page}</button>
  ) : <span style={{ color: T.faint }}>待定位来源</span>;
  const editable = (target: { recordId?: string; path?: string; field?: string }, raw: string) => {
    setEditing({ ...target, raw });
  };
  const editForm = editing && (
    <form style={{ ...box, position: 'sticky', top: 0, zIndex: 2 }} onSubmit={event => {
      event.preventDefault();
      if (editing.candidateId) {
        void (async () => {
          const expected = activeContext;
          setBusy(true);
          try {
            const response = await fetch(api + '/candidate' + params, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: editing.candidateId, name: editing.raw, instrument: editing.instrument, reviewer }),
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? '修改失败');
            if (context.current !== expected) return;
            setEditing(null);
            await fetchState();
          } catch (error) { if (context.current === expected) setMessage((error as Error).message); }
          finally { if (context.current === expected) setBusy(false); }
        })();
      } else void post('/edit', { ...editing, reviewer, action: 'edit', revision: data?.selection.revision }).then(ok => { if (ok) setEditing(null); });
    }}>
      <label>修改字段值<input aria-label="修改字段值" value={editing.raw} onChange={e => setEditing({ ...editing, raw: e.target.value })} style={inputS({ width: '100%', marginTop: 6 })} /></label>
      {editing.candidateId && <label>量表或测量工具<input aria-label="修改候选量表" value={editing.instrument ?? ''} onChange={e => setEditing({ ...editing, instrument: e.target.value })} style={inputS({ width: '100%', marginTop: 6 })} /></label>}
      {editing.field === 'unit' && <p style={{ color: T.amber, fontSize: 12 }}>修改单位不会换算已有数值，请同时核对原文数值。</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" style={primaryBtn()} disabled={!reviewer || busy}>保存修改</button>
        <button type="button" style={ghostBtn()} onClick={() => setEditing(null)}>取消</button>
      </div>
    </form>
  );
  if (!data) return <div style={{ padding: 16, color: T.muted }}>{message || '加载工作流…'}</div>;
  const filtered = data.candidates.filter(c => (c.name + ' ' + c.instrument + ' ' + c.domain).toLowerCase().includes(query.toLowerCase()));
  return (
    <div data-testid="workflow-panel" style={{ height: '100%', overflow: 'auto', padding: 12, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <nav aria-label="提取步骤" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
        {titles.map((name, i) => <button type="button" key={name} onClick={() => setStep(i)}
          aria-current={step === i ? 'step' : undefined}
          style={{ ...ghostBtn(step === i ? T.amber : T.muted), background: step === i ? T.amberTint : T.bg, padding: '9px 4px' }}>{name}</button>)}
      </nav>
      {running && <div role="status" style={{ ...box, borderColor: T.amber }}>
        {Object.entries(data.stages).filter(([,s]) => s.status === 'running').map(([key,s]) => <div key={key}>
          <strong>{key === 'basic' ? '基础字段' : key === 'candidates' ? '识别候选结局' : '汇总结局'}</strong>
          <div>{s.message ?? '正在启动…'}{s.total ? '（' + (s.completed ?? 0) + '/' + s.total + '）' : ''}</div>
        </div>)}
        {pendingStage && '任务正在启动…'}
      </div>}
      {message && <div role="status" style={{ ...box, color: T.text }}>{message}</div>}
      {editForm}
      {step === 0 && <>
        <div style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <strong>文献与研究基础信息</strong>
            <span style={{ color: T.muted }}>{states[data.stages.basic.status]}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={primaryBtn()} onClick={() => void run('basic')} disabled={busy || running}>提取基础字段</button>
            <button style={ghostBtn()} onClick={() => setStep(1)} disabled={!data.basic}>查看结局候选</button>
          </div>
          {data.stages.basic.status === 'failed' && <p role="alert">{data.stages.basic.message}</p>}
          {!!data.basic?.issues?.length && <details style={{ marginTop: 10 }}>
            <summary style={{ color: T.amber }}>基础字段待核对（{data.basic.issues.length}）</summary>
            {data.basic.issues.map((issue,index) => <div key={index} style={{ marginTop: 8, fontSize: 12 }}>
              <p style={{ margin: '4px 0' }}>{issue.message}</p>{sourceButton(issue.evidence?.[0])}
            </div>)}
          </details>}
        </div>
        {(data.basic?.comparisons ?? []).map((comparison,index) => comparison.missingData && <details key={index} style={box}>
          <summary>比较 {index+1} · 缺失数据口径（{comparison.missingData.frames.length}）</summary>
          {!comparison.missingData.frames.length && <p style={{ color: T.muted, fontSize: 12 }}>尚无完整的人数口径证据，未根据分析人数自动推算。</p>}
          {comparison.missingData.frames.map((frame,j) => <article key={j} style={{ marginTop: 10, borderTop: '1px solid '+T.border, paddingTop: 8 }}>
            <strong>{frame.group?.raw ?? frame.role}</strong>
            <p style={{ fontSize: 12 }}>{[frame.outcome?.raw,frame.time?.raw,frame.population?.raw].filter(Boolean).join(' · ')}</p>
            <div style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(frame.counts).map(([key,field]) => <span key={key}>{{randomized:'随机',observed:'实际观测',analyzed:'分析',imputed:'插补',dropout:'退出或失访',missing:'缺失'}[key] ?? key}：{field.raw} 人 {sourceButton(field.evidence?.[0], '来源')}</span>)}
            </div>
            {frame.reportedRatio && <p style={{ fontSize: 12 }}>原文报告比例：{frame.reportedRatio.raw}{frame.reportedRatio.normalized ? '（规范比例 '+frame.reportedRatio.normalized+'）':''} {sourceButton(frame.reportedRatio.evidence?.[0])}</p>}
            {frame.derivedRatio && <p style={{ fontSize: 12, color: T.blue }}>程序计算比例：{(Number(frame.derivedRatio.raw)*100).toFixed(2)}% · {frame.derivedRatio.legend} {sourceButton(frame.derivedRatio.evidence?.[0])}</p>}
            {frame.issues.map((issue,k) => <p key={k} style={{ color: T.amber, fontSize: 12 }}>{issue}</p>)}
          </article>)}
          {comparison.missingData.issues.map((issue,j) => <p key={j} style={{ color: T.amber, fontSize: 12 }}>{issue}</p>)}
        </details>)}
        {(data.basic?.fields ?? []).map(field => {
          const edit = data.edits['basic:' + field.path];
          return <article key={field.path} style={box}>
            <div style={{ color: T.muted, fontSize: 11 }}>{/^comparisons\.\d+\./.test(field.path) ? '比较 ' + (Number(field.path.split('.')[1]) + 1) + ' · ' : ''}{field.label ?? field.path}</div>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0' }}>{edit?.raw ?? field.raw}</div>
            {!edit && field.normalized && field.normalized !== field.raw && <div style={{ fontSize: 11, color: T.muted }}>规范值：{field.normalized}</div>}
            {!edit && field.path.endsWith('.missingDataRatio') && field.provenance === 'deterministic' && <p style={{ fontSize: 11, color: T.blue }}>程序计算 · {field.legend}</p>}
            <div style={{ display: 'flex', gap: 6 }}>
              {sourceButton(field.evidence?.[0])}
              <button style={ghostBtn()} disabled={!reviewer || running} onClick={() => editable({ path: field.path }, edit?.raw ?? field.raw)}>修改</button>
              <button style={ghostBtn(T.emerald)} disabled={!reviewer || running} onClick={() => void post('/edit', { path: field.path, reviewer, action: 'confirm', revision: data.selection.revision })}>
                {data.confirmations?.['basic:' + field.path] ? '已确认' : '确认'}
              </button>
            </div>
          </article>;
        })}
      </>}
      {(step === 1 || step === 2) && <>
        <div style={box}>
          <strong>{step === 1 ? '识别原文中的全部结局候选' : '勾选需要汇总的结局名称'}</strong>
          <p style={{ color: T.muted, margin: '6px 0 10px', fontSize: 12 }}>包含量表分域及附件结局，比较组与报告时点会在汇总时自动识别。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button style={primaryBtn()} disabled={!data.basic || running || busy || dirty} onClick={() => void run('candidates')}>生成结局候选</button>
            <button style={ghostBtn(T.emerald)} disabled={!reviewer || running || busy} onClick={() => void saveSelection()}>保存选择（{selected.length}）</button>
          </div>
          {!reviewer && <p style={{ color: T.red }}>请在上方填写核对人后保存选择。</p>}
          {dirty && <div style={{ marginTop: 8, color: T.amber }}>选择有修改，尚未保存</div>}
          {['failed','partial'].includes(data.stages.candidates.status) && <p role="alert">{data.stages.candidates.message ?? '部分候选需要核对来源，可重试或手工补加。'}</p>}
          {(data.stages.candidates.errors?.length ?? 0) > 0 && <details style={{ marginTop: 8 }}><summary>候选识别待核对项（{data.stages.candidates.errors!.length}）</summary>
            {data.stages.candidates.errors!.map((error,index) => <p key={index} style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{error}</p>)}
          </details>}
        </div>
        <input aria-label="搜索结局" placeholder="搜索结局、量表或分域" value={query} onChange={e => setQuery(e.target.value)} style={inputS({ width: '100%', boxSizing: 'border-box' })} />
        {filtered.map(candidate => <article key={candidate.id} style={box}>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: running ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={selected.includes(candidate.id)} disabled={running || busy}
              onChange={e => { setSelected(e.target.checked ? [...selected, candidate.id] : selected.filter(id => id !== candidate.id)); setDirty(true); }} />
            <span style={{ flex: 1 }}><strong>{candidate.name}</strong>
              {candidate.domain && <span> — {candidate.domain}</span>}
              <span style={{ display: 'block', marginTop: 4, color: T.muted, fontSize: 12 }}>{candidate.instrument || '原文未指定量表'}</span>
              {candidate.primary && <span style={{ color: T.amber, fontSize: 11 }}>原文主要结局</span>}
            </span>
          </label>
          <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {candidate.evidence.slice(0, 3).map((e,i) => <span key={i}>{sourceButton(e)}</span>)}
            <button style={ghostBtn()} disabled={!reviewer || running || busy || dirty} onClick={() => setEditing({ candidateId: candidate.id, raw: candidate.name, instrument: candidate.instrument })}>修改名称</button>
            {candidate.origin === 'human' && <span style={{ color: T.muted }}>人工补加</span>}
          </div>
        </article>)}
        {!filtered.length && <div style={box}>{data.candidates.length ? '没有匹配的结局' : '候选尚未生成，也可手工补加。'}</div>}
        <form style={box} onSubmit={event => {
          event.preventDefault();
          void post('/candidate', { name: manualName, instrument: manualInstrument, reviewer }).then(ok => { if (ok) { setManualName(''); setManualInstrument(''); } });
        }}>
          <strong>补加遗漏结局</strong>
          <input aria-label="补加结局名称" placeholder="结局名称（可含量表分域）" value={manualName} onChange={e => setManualName(e.target.value)} style={inputS({ width: '100%', boxSizing: 'border-box', marginTop: 8 })} />
          <input aria-label="补加量表" placeholder="量表或测量工具（可选）" value={manualInstrument} onChange={e => setManualInstrument(e.target.value)} style={inputS({ width: '100%', boxSizing: 'border-box', marginTop: 6 })} />
          <button type="submit" style={{ ...ghostBtn(), marginTop: 8 }} disabled={!manualName.trim() || !reviewer || running || busy}>加入候选</button>
        </form>
      </>}
      {step === 3 && <>
        <div style={box}>
          <strong>选中结局的信息汇总</strong>
          <p style={{ color: T.muted, fontSize: 12 }}>已保存 {data.selection.candidateIds.length} 个结局 · {states[data.stages.summary.status]}</p>
          {data.result && <p style={{ color: T.muted, fontSize: 11 }}>本次结果时间 {new Date(data.result.at).toLocaleString()}</p>}
          {data.stages.summary.status === 'stale' && <p role="alert" style={{ color: T.amber }}>以下是上次选择的结果，请重新运行汇总。</p>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={primaryBtn()} disabled={running || busy || dirty || !data.selection.candidateIds.length} onClick={() => void run('summary')}>汇总所选结局／重试缺口</button>
            <button style={ghostBtn(T.blue)}
              disabled={running || busy || dirty || !data.effectiveRecords.length || !['done', 'partial'].includes(data.stages.summary.status)}
              onClick={() => void run('review')}>AI 最终复核</button>
            <a style={ghostBtn(T.blue)} href={api + '/export' + params + '&format=xlsx'}>导出 Excel</a>
            <a style={ghostBtn()} href={api + '/export' + params + '&format=csv'}>导出 CSV</a>
          </div>
          {data.stages.summary.status === 'failed' && <p role="alert">{data.stages.summary.message}</p>}
          {data.stages.review?.status === 'running' && <p>{data.stages.review.message || '正在进行最终复核'}</p>}
          {data.stages.review?.status === 'failed' && <p role="alert">{data.stages.review.message}</p>}
          {data.review && !data.reviewCurrent && <p style={{ color:T.amber }}>汇总结果曾更新，请重新运行最终复核。</p>}
          {data.reviewCurrent && data.review && <p data-testid="final-review-result" style={{ color:T.muted, fontSize:12 }}>
            最终复核 {data.review.checked} 条，提示 {data.review.findings.length} 处
            {data.review.unchecked > 0 && '，另有 ' + data.review.unchecked + ' 条未完成'}
            {data.review.effort && ' · ' + data.review.effort}
          </p>}
        </div>
        {(data.result?.outcomes ?? []).filter(o => o.status !== 'done').map(o => <article key={o.candidateId} style={{ ...box, borderColor: T.amber }}>
          <strong>{data.candidates.find(c => c.id === o.candidateId)?.name} · 待核对</strong>
          {[...o.errors, ...o.unreported.map(v => typeof v === 'string' ? v : JSON.stringify(v)),
            ...o.rejected.map(v => v.rejected)].map((text,i) => <p key={i} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{text}</p>)}
          {!o.errors.length && !o.unreported.length && !o.rejected.length && <p>尚无完整数值，请核对原文。</p>}
        </article>)}
        {data.effectiveRecords.map(record => <article key={record.id} style={box}>
          <strong>{record.outcome}{record.domain ? ' — ' + record.domain : ''}</strong>
          <p style={{ color: T.text, fontSize: 12 }}>{record.group} · {record.time}</p>
          <p style={{ color: T.muted, fontSize: 11 }}>{record.comparison} · {record.estimand} · {record.statistic}</p>
          <div style={{ padding: '7px 0', fontSize: 12 }}>
            单位：{record.unit?.canonical === '1' ? '无量纲' : record.unit?.canonical ?? record.unit?.raw ?? 'NR'}
            {record.unit?.raw && record.unit.raw !== record.unit.canonical && <span style={{ color: T.muted }}> · 原文 {record.unit.raw}</span>}
            {record.unit?.status === 'not_reported' && <span style={{ color: T.muted }}> · 未报告或待定位</span>}
            {record.unit?.origin === 'human' && <span style={{ color: T.amber }}> · 人工修改</span>}
            {sourceButton(record.unit?.source, '单位来源')}
            <button style={ghostBtn()} disabled={!reviewer || running} onClick={() => editable({ recordId: record.id, field: 'unit' }, record.unit?.raw ?? 'NR')}>修改单位</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 6 }}>
            {Object.entries(record.values).map(([field,value]) => <div key={field} style={{ padding: 7, background: T.panel, borderRadius: 6 }}>
              <div style={{ color: T.muted, fontSize: 11 }}>{fields[field] ?? field}</div>
              <div style={{ fontWeight: 600, margin: '3px 0' }}>{value}</div>
              {record.humanEdits?.some(edit => edit.field === field) && <span style={{ color: T.amber, fontSize: 11 }}>人工修改</span>}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {sourceButton(record.evidence[field], '来源')}
                <button style={ghostBtn()} disabled={!reviewer || running} onClick={() => editable({ recordId: record.id, field }, value)}>修改</button>
              </div>
            </div>)}
          </div>
          {data.reviewCurrent && data.review?.findings.filter(finding => finding.recordId === record.id).map((finding,i) => (
            <p key={i} style={{ color:T.amber, fontSize:12 }}>
              AI 复核 · {fields[finding.field] ?? finding.field}：{finding.reason} {sourceButton(finding.source, '复核原文')}
            </p>
          ))}
          {record.issues.map((issue,i) => <p key={i} style={{ color: T.amber, fontSize: 11 }}>{issue}</p>)}
          <div style={{ marginTop: 8 }}>{sourceButton(record.scopeSource)}
            <button style={{ ...ghostBtn(T.emerald), marginLeft: 6 }} disabled={!reviewer || running} onClick={() => void post('/edit', { recordId: record.id, reviewer, action: 'confirm', revision: data.selection.revision })}>
              {record.confirmed ? '已确认 · ' + record.confirmed.reviewer : '确认此条'}
            </button>
          </div>
        </article>)}
      </>}
      {(data.warnings ?? []).length > 0 && <details style={box}><summary>材料读取提示（{data.warnings!.length}）</summary>
        {data.warnings!.map((warning,i) => <p key={i} style={{ fontSize: 11 }}>{warning}</p>)}
      </details>}
    </div>
  );
}
