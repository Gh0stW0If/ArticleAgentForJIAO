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
 * `DEEPSEEK_API_KEY` / `AA_LLM_MODEL` 优先于文件，界面会明确提示。
 */

import { useEffect, useState } from 'react';
import { T, R, SH, tint, ghostBtn, primaryBtn, input as inputS } from './theme.ts';
import type { SettingsInfo } from './types.ts';

interface Props {
  onClose(): void;
  onSaved?: (s: Partial<SettingsInfo>) => void;
}

const inp: React.CSSProperties = inputS({ width: '100%', fontSize: 12 });

const label: React.CSSProperties = {
  color: T.muted, fontSize: 11, marginTop: 12, marginBottom: 4, display: 'block', fontWeight: 600,
};

export function SettingsPanel({ onClose, onSaved }: Props) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [form, setForm] = useState({
    baseUrl: '', model: '', apiKey: '', crossrefMailto: '', temperature: '0', maxTokens: '8000',
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
          <b style={{ fontSize: 14, color: T.ink }}>设置 · API 配置</b>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >✕</button>
        </div>

        <label style={label}>Base URL</label>
        <input style={inp} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />

        <label style={label}>模型</label>
        <input style={inp} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" />

        <label style={label}>
          API Key
          {info?.hasKey && (
            <span style={{ color: T.faint, marginLeft: 6, fontWeight: 400 }}>
              当前：{info.apiKeyMasked}{info.keyFromEnv ? '（来自环境变量 DEEPSEEK_API_KEY，改这里不生效）' : ''}
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
            <input style={inp} value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
          </div>
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
