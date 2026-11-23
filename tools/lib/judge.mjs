/**
 * LLM 语义判定：用于 **Sheet2 / Sheet3 这类无法标准化的自然语言结局信息**。
 *
 * 需求：不用严格字符匹配判对错，改由 LLM 判断属于
 *   完全一致 / 含义一致 / 包含正确信息 / 存在错误 / 完全不一致
 *
 * 设计要点：
 *  1. **批量**：一次调用判定多组（默认 8 组），把调用数压到 ~1/8；
 *  2. **缓存**：判定结果按 (field, gold, pred) 指纹存 `build/judge-cache.json`，
 *     重复评分不再付费（判定与提示词无关，因此缓存跨轮有效）；
 *  3. **失败降级**：调用/解析失败 → `unknown`，评分时单列"未判定"，不计入对错；
 *  4. 只比较语义，不看字段名（字段名仅作上下文），避免"同类字段互相打分"的偏差。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeepSeekLlm } from '../../packages/skills/dist/index.js';
import { llmCacheSuffix } from './llm-config.mjs';

const ROOT = process.env.AA_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function judgeCachePath(root, opts) {
  const reasoningEffort = Object.hasOwn(opts, 'reviewReasoningEffort') ? opts.reviewReasoningEffort : opts.reasoningEffort;
  return join(root, 'build', `judge-cache${llmCacheSuffix({ ...opts, reasoningEffort })}.json`);
}

/** 判定类别 → 中文标签。 */
export const VERDICT_LABEL = {
  identical: '完全一致',
  same_meaning: '含义一致',
  contains_correct: '包含正确信息',
  has_error: '存在错误',
  completely_different: '完全不一致',
  unknown: '未判定',
};

/** 判定 → 得分权重（透明、可审计）。 */
export const VERDICT_WEIGHT = {
  identical: 1,
  same_meaning: 1,
  contains_correct: 0.5,
  has_error: 0,
  completely_different: 0,
  unknown: 0,
};

const VALID = new Set(Object.keys(VERDICT_LABEL));

const SYSTEM = `你是系统评价数据抽取的**评审核对员**。

给你若干组「人工标注（金标准）」与「系统抽取」的文本，判断每一组的关系属于哪一类：

- \`identical\`：完全一致（除空白/标点/大小写外基本相同）
- \`same_meaning\`：含义一致（措辞、语序、缩写与全称不同，但表达的信息相同）
- \`contains_correct\`：抽取值**包含**金标准的正确信息，但有遗漏或多述（信息不完全等价，但无误）
- \`has_error\`：抽取值里既有正确信息、也有**错误**信息（如数值错、把别的指标混进来）
- \`completely_different\`：完全不一致 / 无关 / 答非所问

判定原则：
1. 只比较**语义**；不要因为字符串不同就判不同，也不要因为出现相同关键词就判一致。
2. 数值必须实质相同（\`0-100 mm\` 与 \`0–100mm\` 一致；\`16.2\` 与 \`18\` 不一致）。
3. 缩写与全称算一致（\`HDRS\` 与 \`Hamilton Depression Rating Scale\`）。
4. 若金标准是 \`NR\`（未报告），抽取值也必须表达"未报告"才算一致。
5. 拿不准时倾向 \`contains_correct\`，并在 reason 里说明。

只输出 JSON，不要任何解释文字，格式：
{"results":[{"i":1,"verdict":"same_meaning","reason":"缩写与全称"}]}`;

const fingerprint = (p) => `${p.field}\u0000${p.gold}\u0000${p.pred}`;

function loadCache(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
function saveCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * 批量判定。
 *
 * @param {Array<{key:string, field:string, gold:string, pred:string}>} pairs
 * @param {{apiKey:string, baseUrl?:string, model?:string, wireApi?:string, reasoningEffort?:'low'|'medium'|'high'|'xhigh', httpHeaders?:Record<string,string>, batchSize?:number, noCache?:boolean, onProgress?:(m:string)=>void}} opts
 * @returns {Promise<Array<{key:string, field:string, gold:string, pred:string, verdict:string, reason?:string}>>}
 */
export async function judgePairs(pairs, opts) {
  const cachePath = judgeCachePath(ROOT, opts);
  const cache = opts.noCache ? {} : loadCache(cachePath);
  const results = [];
  const todo = [];

  for (const p of pairs) {
    const hit = cache[fingerprint(p)];
    if (hit) results.push({ ...p, verdict: hit.verdict, ...(hit.reason ? { reason: hit.reason } : {}) });
    else todo.push(p);
  }

  if (!todo.length) return results;

  const llm = createDeepSeekLlm({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    wireApi: opts.wireApi,
    reasoningEffort: Object.hasOwn(opts, 'reviewReasoningEffort') ? opts.reviewReasoningEffort : opts.reasoningEffort,
    httpHeaders: opts.httpHeaders,
    temperature: 0,
    maxTokens: 4000,
  });

  const batchSize = opts.batchSize ?? 8;
  for (let start = 0; start < todo.length; start += batchSize) {
    const batch = todo.slice(start, start + batchSize);
    const lines = batch.map((p, i) =>
      `【第 ${i + 1} 组】\n金标准：${p.gold}\n系统抽取：${p.pred}`).join('\n\n');
    const user = `请判定下面 ${batch.length} 组的关系（字段上下文：${batch[0].field}）：\n\n${lines}`;

    try {
      const res = await llm.invoke({ system: SYSTEM, user, temperature: 0, tag: `judge:${batch[0].field}` });
      const arr = res.json?.results;
      if (!Array.isArray(arr)) throw new Error('返回结构不含 results 数组');
      const byIndex = new Map();
      for (const r of arr) {
        const i = Number(r?.i);
        const v = String(r?.verdict ?? '');
        if (Number.isFinite(i)) byIndex.set(i, VALID.has(v) ? v : 'unknown');
        const reason = typeof r?.reason === 'string' ? r.reason : '';
        if (Number.isFinite(i) && reason) byIndex.set(`${i}#reason`, reason);
      }
      for (const [i, p] of batch.entries()) {
        const verdict = byIndex.get(i + 1) ?? 'unknown';
        const reason = byIndex.get(`${i + 1}#reason`) ?? '';
        const rec = { ...p, verdict, ...(reason ? { reason } : {}) };
        results.push(rec);
        if (!opts.noCache && verdict !== 'unknown') cache[fingerprint(p)] = { verdict, ...(reason ? { reason } : {}) };
      }
    } catch (e) {
      opts.onProgress?.(`  判定失败（${batch.length} 组降级为未判定）：${e.message}`);
      for (const p of batch) results.push({ ...p, verdict: 'unknown' });
    }
  }

  if (!opts.noCache) saveCache(cachePath, cache);
  return results;
}
