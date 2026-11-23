/**
 * 设置对话框（右上角菜单）
 *
 * 需求：在界面上配置 API 信息。
 *
 * 两条硬约束：
 *   1. **密钥永不回显明文**——服务端只返回掩码（`sk-****…32ec`），输入框留空即"不修改"；
 *   2. **不能泄露到日志/错误里**——连通性测试的报错在服务端过 `redact()`（网关常把
 *      Authorization 原样回显）。
 *
 * 配置写入 `runtime/llm.local.json`（本机私有，不随产物外发）。环境变量
 * `AA_LLM_API_KEY` / `AA_LLM_MODEL` 可覆盖文件配置。
 */

import { useEffect, useState } from 'react';
import {
  T, R, SH, tint, ghostBtn, primaryBtn, input as inputS,
  FONT_SCALES, FONT_LABEL, FONT_ZOOM, type FontScale,
} from './theme.ts';
import type { ReasoningStage, ReasoningStages, SettingsInfo } from './types.ts';

interface Props {
  onClose(): void;
  onSaved?: (s: Partial<SettingsInfo>) => void;
  /** 当前界面字体档位（存在 App，写 localStorage）。 */
  fontScale: FontScale;
  onFontScale(v: FontScale): void;
}

const inp: React.CSSProperties = inputS({ width: '100%', fontSize: 12 });

const label: React.CSSProperties = {
  color: T.muted, fontSize: 11, marginTop: 12, marginBottom: 4, display: 'block', fontWeight: 600,
};

const reasoningLabels: Record<ReasoningStage, string> = {
  basic: '基础信息',
  candidates: '结局候选',
  summary: '常规结局汇总',
  difficult: '疑难字段复核',
  review: '最终复核',
};
const defaultReasoning: ReasoningStages = {
  basic: 'medium', candidates: 'high', summary: 'medium', difficult: 'high', review: 'high',
};

export function SettingsPanel({ onClose, onSaved, fontScale, onFontScale }: Props) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [form, setForm] = useState({
    baseUrl: '', model: '', apiKey: '', crossrefMailto: '', temperature: '0', maxTokens: '8000', reasoningStages: defaultReasoning,
  });
  const [status, setStatus] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: SettingsInfo) => {
        setInfo(d);
        setForm({
          baseUrl: d.baseUrl, model: d.model, apiKey: '', crossrefMailto: d.crossrefMailto ?? '',
          temperature: String(d.temperature ?? 0), maxTokens: String(d.maxTokens ?? 8000),
          reasoningStages: d.reasoningStages ?? defaultReasoning,
        });
      })
      .catch((e) => setStatus(`读取失败：${e.message}`));
  }, []);

  const save = async () => {
    setBusy(true); setStatus('保存中…');
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: form.baseUrl, model: form.model, crossrefMailto: form.crossrefMailto,
          temperature: Number(form.temperature), maxTokens: Number(form.maxTokens),
          ...(info?.wireApi === 'responses' ? { reasoningStages: form.reasoningStages } : {}),
          // 留空 = 不修改密钥（避免"只改模型"把 key 抹掉）
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? '保存失败');
      setStatus('已保存');
      onSaved?.(d);
      setForm((f) => ({ ...f, apiKey: '' }));
      if (info) setInfo({ ...info, ...d });
    } catch (e) {
      setStatus(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true); setTest(null); setStatus('测试中…');
    try {
      const r = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: form.baseUrl, model: form.model,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        }),
      });
      const d = await r.json();
      if (d.ok) {
        setTest({
          ok: true,
          text: `连接成功（${d.via}, ${d.ms}ms）` +
            (d.models?.length ? `；可用模型：${d.models.join(', ')}` : '') +
            (d.modelInList === false ? `　⚠️ 当前模型「${form.model}」不在该列表里（若抽取能跑通可忽略）` : ''),
        });
      } else {
        setTest({ ok: false, text: `连接失败：HTTP ${d.status ?? '-'} ${d.error ?? ''}` });
      }
      setStatus('');
    } catch (e) {
      setTest({ ok: false, text: `连接失败：${(e as Error).message}` });
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(27,33,43,.28)', display: 'grid', placeItems: 'center', zIndex: 50 }}
      onClick={onClose}
    >
      <div
        data-testid="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto',
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: R.card,
          boxShadow: SH.pop, padding: '16px 18px', color: T.text,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b style={{ fontSize: 14, color: T.ink }}>设置</b>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >✕</button>
        </div>

        {/* ---------------- 界面 ---------------- */}
        <label style={label}>界面字体</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} data-testid="font-scale">
          {FONT_SCALES.map((s) => (
            <button
              key={s}
              onClick={() => onFontScale(s)}
              data-testid={`font-${s}`}
              title={`界面缩放 ${Math.round(FONT_ZOOM[s] * 100)}%`}
              style={{
                ...(fontScale === s ? primaryBtn(T.amber) : ghostBtn()),
                minWidth: 44, fontSize: 12,
              }}
            >{FONT_LABEL[s]}</button>
          ))}
          <span style={{ fontSize: 11, color: T.faint, marginLeft: 4 }}>
            当前 {Math.round(FONT_ZOOM[fontScale] * 100)}% ｜ 立即生效，本机记住
          </span>
        </div>
        <div style={{ fontSize: 10.5, color: T.faint, marginTop: 5, lineHeight: 1.6 }}>
          放大的是整套界面（含 PDF 阅读区），行距与面板宽度一起变；
          PDF 自身还有独立的缩放滑块。这是本机偏好，与服务端配置无关。
        </div>

        <div style={{
          margin: '16px 0 2px', paddingTop: 12, borderTop: `1px solid ${T.border}`,
          fontSize: 12, fontWeight: 600, color: T.muted,
        }}>API 配置</div>

        <label style={label}>Base URL</label>
        <input style={inp} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />

        <label style={label}>模型</label>
        <input style={inp} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" />

        {info?.wireApi === 'responses' && (
          <>
            <fieldset style={{ margin: '12px 0 0', padding: '0 10px 10px', border: '1px solid ' + T.border, borderRadius: R.btn }}>
              <legend style={{ color: T.muted, fontSize: 11 }}>各阶段的思考强度</legend>
              {(Object.keys(reasoningLabels) as ReasoningStage[]).map(stage => (
                <div key={stage}>
                  <label htmlFor={'reasoning-' + stage} style={label}>{reasoningLabels[stage]}</label>
                  <select
                    id={'reasoning-' + stage}
                    style={inp}
                    value={form.reasoningStages[stage] ?? ''}
                    onChange={e => {
                      const effort = e.target.value || null;
                      setForm(f => ({ ...f, reasoningStages: { ...f.reasoningStages, [stage]: effort } }));
                    }}
                  >
                    <option value="">自动（服务端默认）</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">极高</option>
                  </select>
                </div>
              ))}
            </fieldset>
          </>
        )}

        <label style={label}>
          API Key
          {info?.hasKey && (
            <span style={{ color: T.faint, marginLeft: 6, fontWeight: 400 }}>
              当前：{info.apiKeyMasked}{info.keyFromEnv ? '（当前使用环境变量中的密钥）' : ''}
            </span>
          )}
        </label>
        <input
          style={inp} type="password" autoComplete="off"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          placeholder={info?.hasKey ? '留空 = 不修改' : 'sk-…'}
        />

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>temperature</label>
            <input style={inp} value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>maxTokens</label>
            <input
              style={inp} value={form.maxTokens}
              data-testid="max-tokens"
              onChange={(e) => setForm({ ...form, maxTokens: e.target.value })}
            />
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: T.faint, marginTop: 5, lineHeight: 1.6 }}>
          maxTokens 填 <b>0</b> = <b>不限制</b>：客户端会整个省略这个参数，交给服务端用它自己的上限。
          长输出的模型（实测 gpt-6-sol 的 outcome-values / audit）会顶到 8000 被截断，
          回来的是<b>不完整 JSON</b>、整段字段白丢 —— 拿不准就填 0。
        </div>

        <label style={label}>Crossref mailto（用于联网核验 meta，Crossref 要求带邮箱）</label>
        <input style={inp} value={form.crossrefMailto} onChange={(e) => setForm({ ...form, crossrefMailto: e.target.value })} placeholder="you@example.org" />

        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={save} disabled={busy} style={primaryBtn(T.emerald)}>保存</button>
          <button onClick={runTest} disabled={busy} style={ghostBtn(T.blue)}>测试连接</button>
          {status && <span style={{ color: T.faint, fontSize: 11 }}>{status}</span>}
        </div>

        {test && (
          <div
            data-testid="settings-test-result"
            style={{
              marginTop: 10, fontSize: 11, lineHeight: 1.6, padding: '8px 10px',
              borderRadius: R.btn,
              background: test.ok ? tint(T.emerald, '14') : tint(T.red, '10'),
              border: `1px solid ${test.ok ? tint(T.emerald, '40') : tint(T.red, '33')}`,
              color: test.ok ? '#05674a' : '#a12a1e',
            }}
          >{test.text}</div>
        )}

        <div style={{ marginTop: 14, color: T.faint, fontSize: 10, lineHeight: 1.7 }}>
          配置写入 <code>{info?.configPath ?? 'runtime/llm.local.json'}</code>（本机私有，不随产物外发）；
          密钥只以掩码回显，保存后不会再次显示明文。
        </div>
      </div>
    </div>
  );
}
