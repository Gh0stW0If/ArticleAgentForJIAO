/**
 * 人工核对工具面板：**导回** 与 **两组结果对比**
 *
 * 两件事放在同一个对话框里，因为它们是一条流水线上的相邻步骤：
 *   批量导出 → 医生在 Excel 里改 → **导回** → 需要知道「这次改了什么」→ **对比**。
 *
 * 两条硬约束：
 *   1. **导回是两段式**。先「预览差异」，看清楚要改哪些字段、从什么改成什么，
 *      再点「确认写入」。服务端默认也是 dry-run，`apply=1` 才落盘——
 *      能覆盖人工成果的动作，默认值必须是"不发生"。
 *   2. **对比里「没表态」不等于「一致」**。某一组没有的字段单独计为
 *      「仅 A 有 / 仅 B 有」，不混进一致率的分母。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { T, R, SH, tint, ghostBtn, primaryBtn, input as inputS } from './theme.ts';

/* ------------------------------ 类型 ------------------------------ */

interface ReviewSet { id: string; label: string; kind: string; count: number | null }

interface Signature {
  v: number; signer: string; at: string; scope: string; label: string;
  studies: number; rows: number; reviewers: string[]; cols: number; sum: string;
}
interface ImportChange {
  line: number; year: string; study: string; fieldPath: string;
  raw: string; action: string; before: string | null; note?: string;
}
interface ImportPlan {
  dryRun: true; kind: string; reviewer: string;
  stats: { rows: number; changes: number; unchanged: number; cleared: number; errors: number };
  changes: ImportChange[];
  cleared: { line: number; fieldPath: string; before: string | null }[];
  errors: { line: number; reason: string; fieldPath?: string }[];
  truncated?: boolean;
  signature: Signature | null;
  signatureOk: boolean;
  signerMatches: boolean;
  /** 改动实际会记到谁名下（署名可信时 = 署名里的导出人）。 */
  effectiveReviewer: string;
  warning: string;
}
interface CompareRow {
  fieldPath: string; label: string; a: string | null; b: string | null;
  status: 'same' | 'diff' | 'only-a' | 'only-b';
}
interface CompareResult {
  a: string; b: string;
  stats: { total: number; same: number; diff: number; onlyA: number; onlyB: number; rate: number | null };
  rows: CompareRow[];
  sets: ReviewSet[];
}

interface Props {
  year: string;
  study: string;
  reviewer: string;
  tab: 'import' | 'compare';
  onTab(t: 'import' | 'compare'): void;
  onClose(): void;
  /** 导回落盘成功后调用（让主界面重新拉字段视图与核对汇总）。 */
  onChanged(): void;
  notify(msg: string): void;
}

/* ------------------------------ 样式 ------------------------------ */

const lbl: React.CSSProperties = { color: T.muted, fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 };
const inp = inputS({ fontSize: 12 });
const box: React.CSSProperties = {
  border: `1px solid ${T.border}`, borderRadius: R.btn, background: T.panel, padding: '7px 9px',
  fontSize: 11, color: T.muted, lineHeight: 1.7,
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '4px 6px', borderBottom: `1px solid ${T.borderStrong}`,
  color: T.faint, fontWeight: 600, whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '4px 6px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top',
  wordBreak: 'break-word',
};

const ACTION_ZH: Record<string, string> = { confirm: '确认', override: '修改', add: '补录' };
const STATUS_STYLE: Record<CompareRow['status'], { zh: string; color: string }> = {
  same: { zh: '一致', color: T.emerald },
  diff: { zh: '不同', color: T.amber },
  'only-a': { zh: '仅 A 有', color: T.blue },
  'only-b': { zh: '仅 B 有', color: T.indigo },
};

/** 单元格里显示的值（空、超长都要看得懂）。 */
const show = (v: string | null) => (v === null ? '—' : (v === '' ? '（空）' : v));
const clip = (v: string, n = 90) => (v.length > n ? `${v.slice(0, n)}…` : v);

/* ------------------------------ 组件 ------------------------------ */

export function ReviewToolsPanel({ year, study, reviewer, tab, onTab, onClose, onChanged, notify }: Props) {
  const [sets, setSets] = useState<ReviewSet[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [retract, setRetract] = useState(false);
  const [allowMismatch, setAllowMismatch] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const [aId, setAId] = useState('machine');
  const [bId, setBId] = useState('');
  const [cmp, setCmp] = useState<CompareResult | null>(null);

  const loadSets = useCallback(async () => {
    try {
      const d = await (await fetch(`/api/review-sets?year=${year}&study=${encodeURIComponent(study)}`)).json();
      const list: ReviewSet[] = d.sets ?? [];
      setSets(list);
      /*
       * B 组默认选谁：**优先当前核对人**（他多半就是刚导回的那位），
       * 其次第一位非 legacy 的核对人，最后才轮到 legacy（那是历史遗留件）。
       * 直接取 list[0] 会落到 legacy 上——实测踩到，默认值选错人很迷惑。
       */
      setBId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        return list.find((s) => s.id === `reviewer:${reviewer}`)?.id
          ?? list.find((s) => s.kind === 'reviewer' && s.id !== 'reviewer:legacy')?.id
          ?? list.find((s) => s.kind === 'reviewer')?.id
          ?? '';
      });
    } catch { /* 汇总拉不到不影响主界面 */ }
  }, [year, study]);

  useEffect(() => { void loadSets(); }, [loadSets]);
  useEffect(() => { setPlan(null); setFile(null); }, [study, reviewer]);

  /* ---- 导回 ---- */

  const runImport = async (apply: boolean) => {
    if (!file) { setStatus('请先选择要导回的文件'); return; }
    if (!reviewer) { setStatus('请先在主界面填写「核对人」'); return; }
    setBusy(true);
    setStatus(apply ? '写入中…' : '解析中…');
    try {
      const q = `year=${year}&study=${encodeURIComponent(study)}&reviewer=${encodeURIComponent(reviewer)}`
        + (apply ? '&apply=1' : '')
        + (retract ? '&retractCleared=1' : '')
        + (allowMismatch ? '&allowMismatch=1' : '');
      const r = await fetch(`/api/import-review?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const d = await r.json();
      if (!r.ok) { setStatus(`失败：${d.error}`); return; }

      if (!apply) {
        setPlan(d as ImportPlan);
        setStatus(`预览完成：${d.stats.changes} 处变更，${d.stats.unchanged} 处无变化，${d.stats.errors} 处有问题`);
        return;
      }
      setPlan(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setStatus(`已写入 ${d.applied} 处${d.retracted ? `，撤回 ${d.retracted} 处` : ''}（批次 ${d.batchId ?? '—'}）`);
      notify(`导回完成：写入 ${d.applied} 处，撤回 ${d.retracted} 处`);
      onChanged();
      void loadSets();
    } catch (e) {
      setStatus(`失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /* ---- 对比 ---- */

  const runCompare = async () => {
    if (!bId) { setStatus('请选择要比对的第二组结果'); return; }
    setBusy(true);
    setStatus('对比中…');
    try {
      const d = await (await fetch(
        `/api/compare?year=${year}&study=${encodeURIComponent(study)}&a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`,
      )).json();
      if (d.error) { setStatus(`失败：${d.error}`); return; }
      setCmp(d as CompareResult);
      setSets(d.sets ?? sets);
      setStatus('');
    } catch (e) {
      setStatus(`失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const changedOnly = cmp ? cmp.rows.filter((r) => r.status !== 'same') : [];

  return (
    <div
      data-testid="review-tools"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(27,33,43,.34)', zIndex: 60,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '6vh',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto',
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: R.card,
          boxShadow: SH.pop, padding: '16px 18px', color: T.text,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b style={{ fontSize: 14, color: T.ink }}>
            人工核对工具 · {year} / {study}
          </b>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>

        {/* 选项卡 */}
        <div style={{ display: 'flex', gap: 6, margin: '12px 0' }}>
          <button
            onClick={() => onTab('import')}
            data-testid="tab-import"
            style={tab === 'import' ? primaryBtn(T.indigo) : ghostBtn(T.indigo)}
          >导回修改</button>
          <button
            onClick={() => onTab('compare')}
            data-testid="tab-compare"
            style={tab === 'compare' ? primaryBtn(T.cyan) : ghostBtn(T.cyan)}
          >两组结果对比</button>
        </div>

        {/* ---------------- 导回 ---------------- */}
        {tab === 'import' && (
          <div>
            <div style={box}>
              流程：**批量导出** → 在 Excel 里核对/修改 → 把文件选回来 → **先预览差异** → 确认写入。
              <br />
              以核对人「<b style={{ color: T.ink }}>{reviewer || '（未填写）'}</b>」的列作为修改来源；
              他列的内容一律不动。
              <br />
              导出的文件带**署名**（导出人 / 时间 / 范围），导回时会校验署名与当前核对人是否一致——
              署名对不上就不写，避免把改动记到别人名下。
            </div>

            <label style={{ ...lbl, marginTop: 12 }}>导回的表格（导出时生成的 xlsx / csv）</label>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              data-testid="import-file"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); }}
              style={{ ...inp, width: '100%', padding: '5px 8px' }}
            />

            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 11, color: T.muted }}>
              <input
                type="checkbox" checked={retract} onChange={(e) => setRetract(e.target.checked)}
                data-testid="import-retract" style={{ accentColor: T.amber }}
              />
              把「被清空的格子」当作撤回（默认关闭：清空有歧义，可能只是没填）
            </label>

            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 11, color: T.muted }}>
              <input
                type="checkbox" checked={allowMismatch} onChange={(e) => setAllowMismatch(e.target.checked)}
                data-testid="import-allow-mismatch" style={{ accentColor: T.red }}
              />
              忽略署名异常（文件署名与当前核对人不同，或署名块已损坏）
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => void runImport(false)} disabled={busy || !file} style={ghostBtn(T.blue)} data-testid="import-preview">
                预览差异
              </button>
              <button
                onClick={() => void runImport(true)}
                disabled={busy || !plan || (!plan.stats.changes && !plan.stats.cleared)}
                style={primaryBtn(T.emerald)}
                data-testid="import-apply"
                title={plan ? '' : '请先预览差异'}
              >
                确认写入 {plan ? `（${plan.stats.changes + plan.stats.cleared} 处）` : ''}
              </button>
            </div>

            {plan && (
              <div style={{ marginTop: 12 }}>
                {plan.signature && (
                  <div
                    data-testid="import-signature"
                    style={{
                      ...box, color: T.text, marginBottom: 8,
                      borderColor: plan.signatureOk ? tint(T.emerald, '55') : tint(T.red, '55'),
                      background: plan.signatureOk ? tint(T.emerald, '10') : tint(T.red, '10'),
                    }}
                  >
                    <b>文件署名</b>：{plan.signature.signer} ｜
                    导出 {String(plan.signature.at).slice(0, 19).replace('T', ' ')} ｜
                    范围 {plan.signature.label} ｜ {plan.signature.studies} 篇 / {plan.signature.rows} 行
                    {plan.signatureOk
                      ? <span style={{ color: T.emerald }}> ｜ 校验和 {plan.signature.sum}（签名块完好）</span>
                      : <span style={{ color: T.red }}> ｜ 校验和不符</span>}
                  </div>
                )}
                {plan.warning && (
                  <div
                    data-testid="import-signature-warning"
                    style={{ ...box, marginBottom: 8, color: '#a12a1e', background: tint(T.red, '10'), borderColor: tint(T.red, '33') }}
                  >
                    ⚠️ {plan.warning}
                  </div>
                )}
                <div style={{ ...box, color: T.text }}>
                  读到 <b>{plan.stats.rows}</b> 行 ｜ 变更 <b style={{ color: T.amber }}>{plan.stats.changes}</b> ｜
                  无变化 {plan.stats.unchanged} ｜ 撤回 {plan.stats.cleared} ｜
                  问题 <b style={{ color: plan.stats.errors ? T.red : T.faint }}>{plan.stats.errors}</b>
                </div>

                {plan.changes.length > 0 && (
                  <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead><tr>
                        <th style={th}>字段</th><th style={th}>动作</th><th style={th}>改前</th><th style={th}>改后</th><th style={th}>备注</th>
                      </tr></thead>
                      <tbody>
                        {plan.changes.map((c, i) => (
                          <tr key={`${c.fieldPath}-${i}`}>
                            <td style={td}><code style={{ fontSize: 10.5 }}>{c.fieldPath}</code></td>
                            <td style={{ ...td, color: T.amber, whiteSpace: 'nowrap' }}>{ACTION_ZH[c.action] ?? c.action}</td>
                            <td style={{ ...td, color: T.faint }}>{show(c.before)}</td>
                            <td style={{ ...td, color: T.ink }}>{clip(c.raw)}</td>
                            <td style={{ ...td, color: T.faint }}>{c.note ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {plan.errors.length > 0 && (
                  <div style={{ ...box, marginTop: 8, color: '#a12a1e', background: tint(T.red, '10'), borderColor: tint(T.red, '33') }}>
                    <b>未处理的行（{plan.stats.errors}）</b>
                    {plan.errors.slice(0, 12).map((e, i) => (
                      <div key={i}>第 {e.line} 行{e.fieldPath ? ` · ${e.fieldPath}` : ''}：{e.reason}</div>
                    ))}
                    {plan.errors.length > 12 && <div>…其余 {plan.errors.length - 12} 条同理</div>}
                  </div>
                )}
                {plan.truncated && <div style={{ color: T.faint, fontSize: 10.5, marginTop: 6 }}>（列表已截断，写入时仍按全量执行）</div>}
              </div>
            )}
          </div>
        )}

        {/* ---------------- 对比 ---------------- */}
        {tab === 'compare' && (
          <div>
            <div style={box}>
              比两组结果。某一组没有的字段<b>不算「一致」</b>，单独计为「仅 A 有 / 仅 B 有」——
              「没表态」和「表态说一样」是两件事。
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              {([['A', aId, setAId, 'compare-a'], ['B', bId, setBId, 'compare-b']] as const).map(([tag, val, set, tid]) => (
                <div key={tag}>
                  <label style={lbl}>{tag} 组</label>
                  <select
                    value={val} onChange={(e) => set(e.target.value)} data-testid={tid}
                    style={{ ...inp, minWidth: 220, padding: '5px 8px' }}
                  >
                    <option value="">（请选择）</option>
                    {sets.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}{s.count !== null ? `（${s.count}）` : ''}</option>
                    ))}
                  </select>
                </div>
              ))}
              <button onClick={() => void runCompare()} disabled={busy || !bId} style={primaryBtn(T.cyan)} data-testid="compare-run">
                对比
              </button>
            </div>

            {cmp && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...box, color: T.text }}>
                  共 <b>{cmp.stats.total}</b> 个字段 ｜
                  <span style={{ color: T.emerald }}> 一致 {cmp.stats.same}</span> ｜
                  <span style={{ color: T.amber }}> 不同 {cmp.stats.diff}</span> ｜
                  <span style={{ color: T.blue }}> 仅 A 有 {cmp.stats.onlyA}</span> ｜
                  <span style={{ color: T.indigo }}> 仅 B 有 {cmp.stats.onlyB}</span>
                  {cmp.stats.rate !== null && <> ｜ <b>一致率 {(cmp.stats.rate * 100).toFixed(1)}%</b>
                    <span style={{ color: T.faint }}>（只在两组都表过态的 {cmp.stats.same + cmp.stats.diff} 个字段上算）</span></>}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0 4px' }}>
                  <span style={{ fontSize: 11, color: T.faint }}>
                    下表默认只列<b>不一致</b>的 {changedOnly.length} 行
                  </span>
                </div>

                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead><tr>
                      <th style={th}>状态</th><th style={th}>字段</th><th style={th}>A</th><th style={th}>B</th>
                    </tr></thead>
                    <tbody>
                      {changedOnly.map((r) => (
                        <tr key={r.fieldPath}>
                          <td style={{ ...td, color: STATUS_STYLE[r.status].color, whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {STATUS_STYLE[r.status].zh}
                          </td>
                          <td style={td}>
                            <div>{r.label}</div>
                            <code style={{ fontSize: 10, color: T.faint }}>{r.fieldPath}</code>
                          </td>
                          <td style={{ ...td, color: T.muted }}>{clip(show(r.a))}</td>
                          <td style={{ ...td, color: T.ink }}>{clip(show(r.b))}</td>
                        </tr>
                      ))}
                      {changedOnly.length === 0 && (
                        <tr><td style={{ ...td, color: T.faint }} colSpan={4}>两组在这篇研究上完全一致（或都没有记录）</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {status && (
          <div style={{ marginTop: 12, fontSize: 11, color: T.muted }} data-testid="tools-status">{status}</div>
        )}
      </div>
    </div>
  );
}
