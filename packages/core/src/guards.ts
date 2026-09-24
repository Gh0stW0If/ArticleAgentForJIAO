/**
 * @aa/core — 不变量守卫
 *
 * 【核心不变量】没有证据的字段不得进入结果。
 * 这里把它做成可执行的断言，而不是靠约定。
 */

import type { Evidence, FieldValue, MissingSemantics, ValueProvenance } from './contracts.js';

/** 金标准使用的缺失哨兵值（见 docs/02-gold-findings）。 */
const SENTINELS: Readonly<Record<string, MissingSemantics>> = {
  NR: 'not_reported',
  'NR ': 'not_reported',
  '未报告': 'not_reported',
  NA: 'not_applicable',
  'N/A': 'not_applicable',
  '不适用': 'not_applicable',
};

/** 判定一个原始值是否为缺失哨兵，并给出缺失语义。 */
export function missingSemanticsOf(raw: string): MissingSemantics | undefined {
  const t = raw.trim();
  if (t === '') return 'empty';
  return SENTINELS[t] ?? SENTINELS[t.toUpperCase()];
}

/** 复制为去首尾空白、压缩内部空白的文本（不改变语义，仅规范空白）。 */
export const normalizeWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class EvidenceRequiredError extends Error {
  constructor(public readonly fieldPath: string, public readonly raw: string) {
    super(
      `字段 ${fieldPath} 缺少证据。raw=${JSON.stringify(raw.slice(0, 60))}。` +
      `按不变量要求，无证据的字段必须进入 unresolved，不得进入 fields。`,
    );
    this.name = 'EvidenceRequiredError';
  }
}

export interface MakeFieldInput {
  raw: string;
  evidence: readonly Evidence[];
  provenance: ValueProvenance;
  confidence: number;
  code?: string;
  legend?: string;
  alternatives?: readonly { raw: string; confidence: number }[];
}

/**
 * 构造 FieldValue 的唯一入口。
 * 无证据直接抛错——这是刻意的：宁可让流水线失败，也不要产出无法复核的字段。
 */
export function makeField(fieldPath: string, input: MakeFieldInput): FieldValue {
  const raw = normalizeWhitespace(input.raw);
  if (!input.evidence || input.evidence.length === 0) {
    throw new EvidenceRequiredError(fieldPath, raw);
  }
  for (const e of input.evidence) {
    if (!e.quote || !e.quote.trim()) {
      throw new Error(`字段 ${fieldPath} 的证据缺少 quote（page=${e.page}, kind=${e.kind}）`);
    }
  }
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error(`字段 ${fieldPath} 的 confidence 越界：${input.confidence}`);
  }

  const missing = missingSemanticsOf(raw);
  const value: FieldValue = {
    raw,
    evidence: input.evidence,
    provenance: input.provenance,
    confidence: input.confidence,
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.legend !== undefined ? { legend: input.legend } : {}),
    ...(missing !== undefined ? { missing } : {}),
    ...(input.alternatives !== undefined ? { alternatives: input.alternatives } : {}),
  };
  return value;
}

/**
 * 安全版本：无证据时返回 undefined，由调用方决定是否记入 unresolved。
 * 适合"字段可选、抽不到就空着"的场景。
 */
export function tryMakeField(fieldPath: string, input: MakeFieldInput): FieldValue | undefined {
  try {
    return makeField(fieldPath, input);
  } catch (e) {
    if (e instanceof EvidenceRequiredError) return undefined;
    throw e;
  }
}

/** 合并多个 FieldValue 的证据（例如来自正文 + 表格两处佐证）。 */
export function mergeEvidence(...fields: readonly (FieldValue | undefined)[]): readonly Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f) continue;
    for (const e of f.evidence) {
      const key = `${e.kind}|${e.page}|${e.blockId ?? ''}|${e.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** 取置信度最低者作为合并后的置信度（保守）。 */
export const minConfidence = (...fields: readonly (FieldValue | undefined)[]): number => {
  const cs = fields.filter(Boolean).map((f) => (f as FieldValue).confidence);
  return cs.length ? Math.min(...cs) : 0;
};

/**
 * 校验整个对象里每个 FieldValue 都带证据。
 * 返回违规路径列表（空数组表示通过）。
 */
export function auditEvidence(node: unknown, path = '$', out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => auditEvidence(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node !== 'object') return out;

  const obj = node as Record<string, unknown>;
  // 判定"像不像 FieldValue"：同时含 raw 与 evidence
  if (typeof obj.raw === 'string' && 'evidence' in obj) {
    const ev = obj.evidence;
    if (!Array.isArray(ev) || ev.length === 0) out.push(path);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) auditEvidence(v, `${path}.${k}`, out);
  return out;
}
