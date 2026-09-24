/**
 * 抽取结果面板 —— 三张选项卡（Sheet1 / Sheet2 / Sheet3），字段按**原始表格列序**排布。
 *
 * 视觉对齐设计参考图：白色字段卡片（圆角 12 + 极浅阴影 + 左侧来源色条）、
 * 浅底同色描边的动作按钮（编辑/定位/框选/确认…），选项卡用"深墨色药丸"表示激活。
 *
 * 交互：
 *   · 点字段值 → 在左侧 PDF 上定位其证据（右侧**不显示证据原文**，见下）
 *   · 「编辑」   → 就地改值（记录 override）
 *   · 「框选证据」→ 进入标注模式，在 PDF 上拖框 → 写入该字段的证据（page+bbox+quote）
 *   · 「确认」   → 记录 confirm（不改值，用于统计 LLM 正确率）
 *   · 「回滚」   → 删除该字段的人工标注，回到流水线原值
 *   · 「＋新增字段」→ 人工补录流水线漏掉的字段（记录 add）
 *   · 「纳入抽取」→ 把「待人工确认纳入」的候选结局提升为正式的 Sheet3 行
 *
 * ⚠️ 右侧不显示证据原文：需求明确"原文证据只需要在左侧 PDF 能显示定位就行"。
 * 证据仍然留在数据里（框选/回滚都依赖它），只是不再用文字占版面。
 */

import { useMemo, useState } from 'react';
import type { Bbox } from './geometry.ts';
import { T, R, SH, tint, badge, ghostBtn, primaryBtn, input as inputS, PROVENANCE } from './theme.ts';
import type { FieldGroup, FieldView, SheetsPayload, SheetOrder } from './types.ts';

export type { FieldView, FieldGroup };

interface Props {
  sheets: SheetsPayload;
  markingFieldPath: string | null;
  hasSelection: boolean;
  busy: boolean;
  onFocusEvidence(page: number, bbox: Bbox): void;
  onEdit(fieldPath: string, raw: string, note?: string): void;
  onConfirm(fieldPath: string): void;
  onRevert(fieldPath: string): void;
  onStartMark(fieldPath: string): void;
  onAttachEvidence(fieldPath: string): void;
  onAdd(fieldPath: string, raw: string): void;
  onLocate(fieldPath: string, raw: string): void;
  onInclude(field: FieldView): void;
}

/** 小块白卡（页脚、空态提示用）。 */
const cardPlain = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: T.bg,
  border: `1px solid ${T.border}`,
  borderRadius: R.card,
  boxShadow: SH.card,
  padding: '9px 11px',
  ...extra,
});

/**
 * 按「原始表格列序」排序。
 * 不在布局里的键（人工新增、或原表没有的流水线字段）**保持原顺序排到最后**，
 * 既不会丢字段，也不会打乱真实列序。
 */
function orderFields(
  fields: FieldView[],
  order: string[] | undefined,
  headerOf?: Record<string, string>,
): (FieldView & { header?: string })[] {
  const pos = new Map((order ?? []).map((k, i) => [k, i]));
  return [...fields]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const pa = pos.get(a.f.key ?? '');
      const pb = pos.get(b.f.key ?? '');
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.i - b.i;
    })
    .map(({ f }) => {
      const hdr = headerOf?.[f.key ?? ''];
      // 原始表头与我们的标签不同时，作为副标题显示（便于与 xlsx 对照）
      return hdr && hdr !== f.label ? { ...f, header: hdr } : f;
    });
}

function FieldRow({
  f, isMarking, hasSelQuote, onFocusEvidence, onEdit, onConfirm, onRevert, onStartMark, onAttachEvidence, onLocate,
}: {
  f: FieldView & { header?: string };
  isMarking: boolean;
  hasSelQuote: boolean;
} & Pick<Props, 'onFocusEvidence' | 'onEdit' | 'onConfirm' | 'onRevert' | 'onStartMark' | 'onAttachEvidence' | 'onLocate'>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.raw);
  const [note, setNote] = useState(f.note ?? '');
  const ev = f.evidence?.[0];
  const canFocus = Boolean(ev?.bbox);
  const prov = PROVENANCE[f.decidedBy] ?? PROVENANCE.model!;

  const commit = () => {
    if (draft !== f.raw || note !== (f.note ?? '')) onEdit(f.fieldPath, draft, note || undefined);
    setEditing(false);
  };

  return (
    <div
      data-field={f.fieldPath}
      style={{
        background: isMarking ? T.amberSoft : T.bg,
        border: `1px solid ${isMarking ? tint(T.amber, '55') : T.border}`,
        borderLeft: `3px solid ${isMarking ? T.amber : prov.color}`,
        borderRadius: R.card,
        boxShadow: SH.card,
        padding: '8px 11px',
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3, flexWrap: 'wrap' }}>
        <span style={{ color: T.ink, fontSize: 12, fontWeight: 600 }}>{f.label}</span>
        {f.header && <span style={{ color: T.faint, fontSize: 10 }}>原表头：{f.header}</span>}
        {f.decidedBy === 'human' && <span style={badge(T.amber)}>{f.overridden ? '人工修改' : '已确认'}</span>}
        {f.decidedBy === 'deterministic' && <span style={badge(T.cyan)}>编码推导</span>}
        {f.decidedBy === 'external' && <span style={badge(T.indigo)}>Crossref</span>}
        {f.missing && (
          <span style={badge(T.faint)}>
            {f.missing === 'not_reported' ? 'NR' : f.missing === 'not_applicable' ? 'NA' : '空'}
          </span>
        )}
        {f.confidence !== undefined && f.decidedBy === 'model' && (
          <span style={{ color: T.faint, fontSize: 10 }}>conf {f.confidence.toFixed(2)}</span>
        )}
      </div>

      {!editing ? (
        <div
          data-value="1"
          onClick={canFocus ? () => onFocusEvidence(ev!.page, ev!.bbox!) : undefined}
          style={{
            cursor: canFocus ? 'pointer' : 'default',
            color: f.raw ? T.text : T.faint,
            wordBreak: 'break-word',
            lineHeight: 1.5,
            fontSize: 13,
          }}
          title={canFocus ? `点击在左侧 PDF（p${ev!.page}）定位证据` : '暂无证据坐标'}
        >
          {f.raw || '（空）'}
          {f.code !== undefined && f.code !== f.raw && (
            <span style={{ color: T.cyan, marginLeft: 6, fontSize: 11 }}>[{f.code}]</span>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(6, Math.max(1, Math.ceil(draft.length / 60)))}
            style={inputS({ width: '100%', resize: 'vertical', fontSize: 12, lineHeight: 1.5 })}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="修改理由（可选，便于复核）"
            style={inputS({ width: '100%', fontSize: 11, color: T.muted })}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={commit} style={primaryBtn(T.emerald)}>保存</button>
            <button
              onClick={() => { setDraft(f.raw); setNote(f.note ?? ''); setEditing(false); }}
              style={ghostBtn(T.muted)}
            >取消</button>
          </div>
        </div>
      )}

      {f.legend && <div style={{ color: T.faint, fontSize: 11, marginTop: 2 }}>{f.legend}</div>}
      {f.llmRaw !== undefined && f.llmRaw !== f.raw && (
        <div style={{ color: T.amber, fontSize: 11, marginTop: 2 }}>LLM 原值：{f.llmRaw}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
        {!editing && <button onClick={() => setEditing(true)} style={ghostBtn(T.blue)}>编辑</button>}
        {ev?.bbox
          ? <button onClick={() => onFocusEvidence(ev.page, ev.bbox!)} style={ghostBtn(T.amberBright)}>定位证据</button>
          : f.raw.trim().length >= 2 && (
            <button
              onClick={() => onLocate(f.fieldPath, f.raw)}
              style={ghostBtn(T.amberBright)}
              title="该字段还没有证据坐标：在解析文本里搜索这个值并定位（只读，不写盘）"
            >定位证据</button>
          )}
        <button onClick={() => onStartMark(f.fieldPath)} style={ghostBtn(T.indigo)}>
          {isMarking ? '在 PDF 上拖框…' : '框选证据'}
        </button>
        {hasSelQuote && !isMarking && (
          <button onClick={() => onAttachEvidence(f.fieldPath)} style={ghostBtn(T.cyan)}>用当前框选作证据</button>
        )}
        {f.decidedBy === 'model' && <button onClick={() => onConfirm(f.fieldPath)} style={ghostBtn(T.emerald)}>确认无误</button>}
        {f.decidedBy === 'human' && <button onClick={() => onRevert(f.fieldPath)} style={ghostBtn(T.red)}>回滚</button>}
      </div>
    </div>
  );
}

/** 可折叠分组（标题条 + 内容）。 */
function Section({
  group, collapsed, onToggle, children, tone = 'plain',
}: {
  group: { id: string; title: string; fields?: FieldView[]; collapsible?: boolean };
  collapsed: boolean;
  onToggle(): void;
  children: React.ReactNode;
  tone?: 'plain' | 'candidate' | 'included';
}) {
  const humanCount = group.fields?.filter((f) => f.decidedBy === 'human').length ?? 0;
  const accent = tone === 'candidate' ? T.amber : tone === 'included' ? T.emerald : T.borderFaint;
  return (
    <section style={{ marginBottom: 10 }}>
      <div
        onClick={group.collapsible ? onToggle : undefined}
        style={{
          padding: '7px 11px',
          background: T.bg,
          border: `1px solid ${T.border}`,
          borderLeft: `3px solid ${accent}`,
          borderRadius: R.card,
          boxShadow: SH.card,
          cursor: group.collapsible ? 'pointer' : 'default',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginBottom: collapsed ? 0 : 8,
        }}
      >
        <span style={{ color: T.ink, fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.collapsible && <span style={{ color: T.faint, marginRight: 4 }}>{collapsed ? '▸' : '▾'}</span>}
          {group.title}
        </span>
        <span style={{ color: T.faint, fontWeight: 400, fontSize: 11, whiteSpace: 'nowrap', display: 'flex', gap: 6, alignItems: 'center' }}>
          {humanCount > 0 && <span style={badge(T.amber)}>人工 {humanCount}</span>}
          {group.fields ? <span>{group.fields.length}</span> : null}
        </span>
      </div>
      {!collapsed && <div style={{ padding: '0 1px' }}>{children}</div>}
    </section>
  );
}

export function ExtractionPanel(props: Props) {
  const { sheets, markingFieldPath, busy } = props;
  const [tab, setTab] = useState<'sheet1' | 'sheet2' | 'sheet3'>('sheet1');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const order: SheetOrder = sheets.order;

  /** Sheet3 的行内字段：先按"结局自身字段"列序，再按各时点的列序分组。 */
  const splitRowFields = (fields: FieldView[]) => {
    const top: FieldView[] = [];
    const tp: Record<string, FieldView[]> = { baseline: [], endOfTreatment: [], followUpEnd: [] };
    const other: FieldView[] = [];
    for (const f of fields) {
      const m = /^outcomes\.\d+\.timepoints\.(baseline|endOfTreatment|followUpEnd)\./.exec(f.fieldPath);
      if (m) { (tp[m[1]!] ??= []).push(f); continue; }
      if (/^outcomes\.\d+\.(outcome|followUp)\./.test(f.fieldPath) || /^outcomes\.\d+\.(armNumber|literatureCode)$/.test(f.fieldPath)) {
        top.push(f); continue;
      }
      other.push(f);
    }
    return { top: [...other, ...top], tp };
  };

  const rowRenderer = (row: { id: string; title: string; fields: FieldView[]; included?: boolean }, orderKeys: string[]) => {
    const { top, tp } = splitRowFields(row.fields);
    const TP_LABEL: Record<string, string> = { baseline: '基线期', endOfTreatment: '疗程结束时', followUpEnd: '随访结束时' };
    const render = (f: FieldView & { header?: string }) => (
      <FieldRow
        key={f.fieldPath} f={f} isMarking={markingFieldPath === f.fieldPath} hasSelQuote={props.hasSelection}
        onFocusEvidence={props.onFocusEvidence} onEdit={props.onEdit} onConfirm={props.onConfirm}
        onRevert={props.onRevert} onStartMark={props.onStartMark} onAttachEvidence={props.onAttachEvidence}
        onLocate={props.onLocate}
      />
    );
    return (
      <>
        {orderFields(top, orderKeys, sheets.headerOf).map(render)}
        {(['baseline', 'endOfTreatment', 'followUpEnd'] as const).map((k) => {
          const list = tp[k] ?? [];
          if (!list.length) return null;
          return (
            <div key={k}>
              <div style={{ color: T.amber, fontSize: 11, fontWeight: 600, padding: '2px 2px 6px' }}>
                {TP_LABEL[k]}
              </div>
              {orderFields(list, orderKeys, sheets.headerOf).map(render)}
            </div>
          );
        })}
      </>
    );
  };

  const counts = useMemo(() => ({
    sheet1: sheets.sheet1.article.length
      + sheets.sheet1.comparisons.reduce((a, g) => a + g.fields.length, 0)
      + sheets.sheet1.external.length,
    sheet2: sheets.sheet2.fields.length,
    sheet3: sheets.sheet3.rows.reduce((a, r) => a + r.fields.length, 0),
  }), [sheets]);

  const tabBtn = (id: 'sheet1' | 'sheet2' | 'sheet3', label: string, n: number) => {
    const active = tab === id;
    return (
      <button
        key={id}
        data-tab={id}
        onClick={() => setTab(id)}
        style={{
          fontSize: 12, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
          borderRadius: R.pill,
          background: active ? T.ink : 'transparent',
          color: active ? '#fff' : T.muted,
          border: 'none', fontWeight: active ? 600 : 400,
        }}
      >
        {label} <span style={{ opacity: .7, fontSize: 10 }}>{n}</span>
      </button>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.panel }}>
      {markingFieldPath && (
        <div style={{
          padding: '7px 12px', background: T.amberTint, borderBottom: `1px solid ${tint(T.amber, '40')}`,
          color: '#8a5a1c', fontSize: 12,
        }}>
          标注模式：在左侧 PDF 上拖拽框选，将作为 <b>{markingFieldPath}</b> 的证据
          {busy && '（保存中…）'}
        </div>
      )}

      {/* 选项卡：药丸组，激活态为深墨色（与参考图的筛选 chip 一致） */}
      <div style={{ display: 'flex', gap: 4, padding: '9px 10px', borderBottom: `1px solid ${T.border}` }}>
        {tabBtn('sheet1', 'Sheet1', counts.sheet1)}
        {tabBtn('sheet2', 'Sheet2', counts.sheet2)}
        {tabBtn('sheet3', 'Sheet3', counts.sheet3)}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {tab === 'sheet1' && (
          <>
            <Section
              group={{ id: 's1-article', title: '文章级字段（按原表列序）', fields: sheets.sheet1.article }}
              collapsed={false} onToggle={() => {}}
            >
              {orderFields(sheets.sheet1.article, order.sheet1.article, sheets.headerOf).map((f) => (
                <FieldRow
                  key={f.fieldPath} f={f} isMarking={markingFieldPath === f.fieldPath} hasSelQuote={props.hasSelection}
                  onFocusEvidence={props.onFocusEvidence} onEdit={props.onEdit} onConfirm={props.onConfirm}
                  onRevert={props.onRevert} onStartMark={props.onStartMark} onAttachEvidence={props.onAttachEvidence}
                  onLocate={props.onLocate}
                />
              ))}
            </Section>

            {sheets.sheet1.external.length > 0 && (
              <Section
                group={{ id: 's1-ext', title: 'Crossref 核验（外部值，无页面坐标）', collapsible: true, fields: sheets.sheet1.external }}
                collapsed={collapsed['s1-ext'] ?? false} onToggle={() => toggle('s1-ext')}
              >
                {sheets.sheet1.external.map((f) => (
                  <FieldRow
                    key={f.fieldPath} f={f} isMarking={markingFieldPath === f.fieldPath} hasSelQuote={props.hasSelection}
                    onFocusEvidence={props.onFocusEvidence} onEdit={props.onEdit} onConfirm={props.onConfirm}
                    onRevert={props.onRevert} onStartMark={props.onStartMark} onAttachEvidence={props.onAttachEvidence}
                    onLocate={props.onLocate}
                  />
                ))}
              </Section>
            )}

            {sheets.sheet1.comparisons.map((g) => (
              <Section key={g.id} group={{ ...g, collapsible: true }} collapsed={collapsed[g.id] ?? false} onToggle={() => toggle(g.id)}>
                {orderFields(g.fields, order.sheet1.comparison, sheets.headerOf).map((f) => (
                  <FieldRow
                    key={f.fieldPath} f={f} isMarking={markingFieldPath === f.fieldPath} hasSelQuote={props.hasSelection}
                    onFocusEvidence={props.onFocusEvidence} onEdit={props.onEdit} onConfirm={props.onConfirm}
                    onRevert={props.onRevert} onStartMark={props.onStartMark} onAttachEvidence={props.onAttachEvidence}
                    onLocate={props.onLocate}
                  />
                ))}
              </Section>
            ))}
          </>
        )}

        {tab === 'sheet2' && (
          <Section group={{ id: 's2', title: '结局分类（按原表列序）', fields: sheets.sheet2.fields }} collapsed={false} onToggle={() => {}}>
            {orderFields(sheets.sheet2.fields, order.sheet2, sheets.headerOf).map((f) => (
              <FieldRow
                key={f.fieldPath} f={f} isMarking={markingFieldPath === f.fieldPath} hasSelQuote={props.hasSelection}
                onFocusEvidence={props.onFocusEvidence} onEdit={props.onEdit} onConfirm={props.onConfirm}
                onRevert={props.onRevert} onStartMark={props.onStartMark} onAttachEvidence={props.onAttachEvidence}
                onLocate={props.onLocate}
              />
            ))}
          </Section>
        )}

        {tab === 'sheet3' && (
          <>
            {sheets.sheet3.candidates.length > 0 && (
              <Section
                group={{ id: 's3-cand', title: `待人工确认纳入（${sheets.sheet3.candidates.length} 条）`, collapsible: true, fields: sheets.sheet3.candidates }}
                collapsed={collapsed['s3-cand'] ?? false} onToggle={() => toggle('s3-cand')} tone="candidate"
              >
                {sheets.sheet3.candidates.map((f) => (
                  <div
                    key={f.fieldPath}
                    style={{
                      background: T.amberSoft, border: `1px solid ${tint(T.amber, '3a')}`,
                      borderLeft: `3px solid ${T.amber}`, borderRadius: R.card, boxShadow: SH.card,
                      padding: '8px 11px', marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: T.ink, fontSize: 12, fontWeight: 600 }}>{f.label}</span>
                      <button
                        data-action="include"
                        data-candidate={f.fieldPath}
                        onClick={() => props.onInclude(f)}
                        style={primaryBtn(T.emerald)}
                        title="把该候选结局提升为正式的 Sheet3 行（写入人工覆盖层）"
                      >纳入抽取</button>
                    </div>
                    <div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>
                      {f.raw}{f.candidate?.outcomeClass ? `（模型归类：${f.candidate.outcomeClass}）` : ''}
                    </div>
                    {f.evidence?.[0]?.bbox && (
                      <button
                        onClick={() => props.onFocusEvidence(f.evidence![0]!.page, f.evidence![0]!.bbox!)}
                        style={{ ...ghostBtn(T.amberBright), marginTop: 6 }}
                      >定位证据</button>
                    )}
                  </div>
                ))}
              </Section>
            )}

            {sheets.sheet3.rows.map((row) => (
              <Section
                key={row.id}
                group={{ ...row, collapsible: true }}
                collapsed={collapsed[row.id] ?? false}
                onToggle={() => toggle(row.id)}
                tone={row.included ? 'included' : 'plain'}
              >
                {rowRenderer(row, order.sheet3.top)}
              </Section>
            ))}
            {sheets.sheet3.rows.length === 0 && (
              <div style={{ ...cardPlain(), color: T.muted, fontSize: 12 }}>
                还没有结局行：先跑抽取，或从上方的候选里「纳入抽取」
              </div>
            )}
          </>
        )}

        <div style={cardPlain({ marginTop: 4 })}>
          <AddFieldRow onAdd={props.onAdd} />
          <div style={{ color: T.faint, fontSize: 10, marginTop: 7, lineHeight: 1.6 }}>
            布局来源：{sheets.layoutSource ?? '（未找到图例）'}；
            未在原始表格里出现的字段排在各自分组末尾。
          </div>
        </div>
      </div>
    </div>
  );
}

/** 「＋新增字段」：人工补录流水线漏掉的字段。 */
function AddFieldRow({ onAdd }: { onAdd: Props['onAdd'] }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [raw, setRaw] = useState('');
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {!open ? (
        <>
          <button onClick={() => setOpen(true)} style={ghostBtn(T.emerald)}>＋ 新增字段</button>          <span style={{ fontSize: 10, color: T.faint }}>
            字段路径示例：<code>trialRegistration</code>、<code>outcomes.7.outcome.name</code>
          </span>
        </>
      ) : (
        <>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="字段路径" style={inputS({ flex: 1, minWidth: 120 })} />
          <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="值" style={inputS({ flex: 1, minWidth: 100 })} />
          <button
            onClick={() => {
              if (!path.trim()) return;
              onAdd(path.trim(), raw);
              setPath(''); setRaw(''); setOpen(false);
            }}
            style={primaryBtn(T.emerald)}
          >保存</button>
          <button onClick={() => setOpen(false)} style={ghostBtn(T.muted)}>取消</button>
        </>
      )}
    </div>
  );
}
