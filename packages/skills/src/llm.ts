/**
 * @aa/skills — LLM 调用接口【预留】
 *
 * 需求：给 LLM 的 API 接口留空。
 *
 * 因此这里只定义契约与一个显式失败的桩实现：
 *   - `LlmInvoker` 是接口（已在 @aa/core 定义），未来接任意模型只需实现它。
 *   - `createStubLlm()` 用于**离线跑通全链路**：它不会调用任何模型，
 *     而是抛出可识别的错误，让调用方明确知道"这一步需要接模型"。
 *
 * 为什么不用"假成功"的桩：那会让流水线在没接模型时产出看似正常的空结果，
 * 掩盖问题。宁可在需要模型的那一步显式失败。
 *
 * ===== 未来接入时的实现要求（写在这里作为交接契约）=====
 *
 *  1. **结构化输出**：请求会带 `schema`（JSON Schema）。实现应使用模型的
 *     结构化输出能力（如 JSON mode / tool calling），并把解析后的对象放进
 *     `LlmResponse.json`。不要把 JSON 塞在自由文本里让上层再去正则。
 *
 *  2. **禁止模型给出坐标**：SKILL 的 prompt 只要求模型回传 `quote`（原文片段）
 *     与值；坐标由本地 `locateEvidence()` 定位。这是硬约束——
 *     模型无法看到页面坐标，让它编坐标必然出错。
 *
 *  3. **必须回传 quote**：模型输出的每个字段都要带支撑原文片段。
 *     没有 quote 的字段会被 `makeField()` 拒绝（见 @aa/core 的核心不变量）。
 *
 *  4. **可复现**：实现应记录 `model` 标识与采样参数，并支持通过种子固定采样，
 *     以便同一份 PDF 多次运行结果可比（评估需要）。
 *
 *  5. **失败要抛错**，不要返回空结果。上层据此决定重试或降级。
 */

import type { LlmInvoker, LlmRequest, LlmResponse } from '@aa/core';

export class LlmNotConfiguredError extends Error {
  constructor(public readonly tag: string) {
    super(
      `LLM 未配置：SKILL "${tag}" 需要调用模型，但当前使用的是桩实现。\n` +
      `请提供一个 LlmInvoker 实现（见 packages/skills/src/llm.ts 的交接契约）。`,
    );
    this.name = 'LlmNotConfiguredError';
  }
}

/** 桩实现：任何调用都显式失败，防止"没接模型却产出看似正常的结果"。 */
export function createStubLlm(): LlmInvoker & { readonly kind: 'stub' } {
  return {
    kind: 'stub' as const,
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      throw new LlmNotConfiguredError(req.tag);
    },
  };
}

/**
 * 录制/回放实现：用于**离线测试与评估复现**。
 * 把真实模型的历史响应存成 JSON，测试时回放，从而无需网络与费用。
 */
export interface LlmRecorderEntry {
  /** 请求指纹（由 tag + user 内容哈希得到） */
  key: string;
  response: LlmResponse;
}

export interface LlmRecorder {
  readonly kind: 'recorder';
  readonly entries: LlmRecorderEntry[];
  invoke(req: LlmRequest): Promise<LlmResponse>;
}

/** 生成请求指纹，用于录制与回放对齐。 */
export function requestKey(req: LlmRequest): string {
  // 简单稳定哈希（FNV-1a 32bit），不引入依赖
  const s = `${req.tag}\u0000${req.system}\u0000${req.user}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function createLlmRecorder(entries: readonly LlmRecorderEntry[]): LlmRecorder {
  const map = new Map(entries.map((e) => [e.key, e.response]));
  return {
    kind: 'recorder' as const,
    entries: [...entries],
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const hit = map.get(requestKey(req));
      if (!hit) {
        throw new Error(
          `回放未命中：请求指纹 ${requestKey(req)}（tag=${req.tag}）。` +
          `请先用真实模型录制，或更新录制文件。`,
        );
      }
      return hit;
    },
  };
}
