import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXED_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const REASONING_SETTINGS = Object.freeze(['adaptive', ...FIXED_EFFORTS]);
export const DEFAULT_REASONING_STAGES = Object.freeze({
  basic: 'medium', candidates: 'high', summary: 'medium', difficult: 'high', review: 'high',
});

export function validReasoningStages(stages) {
  return Boolean(stages && typeof stages === 'object' && !Array.isArray(stages)
    && Object.entries(stages).every(([key, value]) => Object.hasOwn(DEFAULT_REASONING_STAGES, key)
      && (value === null || FIXED_EFFORTS.includes(value))));
}

export function llmConfigPath(root) {
  return process.env.AA_LLM_CONFIG ?? join(root, 'runtime', 'llm.local.json');
}

export function loadLlmConfig(root, { path = llmConfigPath(root), optional = false } = {}) {
  let file = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error();
    } catch {
      if (!optional) throw new Error('无法读取模型配置，请检查 runtime/llm.local.json 的 JSON 格式');
      file = {};
    }
  }
  const wireApi = file.wireApi ?? 'chat_completions';
  if (wireApi !== 'chat_completions' && wireApi !== 'responses') {
    throw new Error('模型配置的 wireApi 必须是 chat_completions 或 responses');
  }
  const reasoningSetting = wireApi === 'responses' ? file.reasoningEffort ?? undefined : undefined;
  if (reasoningSetting !== undefined && !REASONING_SETTINGS.includes(reasoningSetting)) {
    throw new Error('思考强度必须为 adaptive、low、medium、high 或 xhigh');
  }
  const configuredStages = wireApi === 'responses' ? file.reasoningStages : undefined;
  if (configuredStages !== undefined && !validReasoningStages(configuredStages)) {
    throw new Error('各阶段思考强度需从自动、低、中、高或极高选择');
  }
  const adaptiveReasoning = reasoningSetting === 'adaptive' || configuredStages !== undefined;
  const legacyDefaults = Object.fromEntries(Object.keys(DEFAULT_REASONING_STAGES).map(stage => [stage, reasoningSetting ?? null]));
  const reasoningStages = adaptiveReasoning
    ? { ...DEFAULT_REASONING_STAGES, ...configuredStages }
    : legacyDefaults;
  const reasoningEffort = reasoningStages.basic ?? undefined;
  const envKey = process.env.AA_LLM_API_KEY ?? (wireApi === 'chat_completions' ? process.env.DEEPSEEK_API_KEY : undefined);
  const apiKey = envKey ?? file.apiKey ?? '';
  if (!apiKey && !optional) throw new Error('缺少 API Key，请填写 runtime/llm.local.json 的 apiKey');

  const model = process.env.AA_LLM_MODEL ?? file.model ?? 'deepseek-chat';
  return {
    apiKey,
    keyFromEnv: envKey !== undefined,
    baseUrl: process.env.AA_LLM_BASE_URL ?? file.baseUrl ?? 'https://api.deepseek.com',
    model,
    reviewModel: process.env.AA_JUDGE_MODEL ?? file.reviewModel ?? model,
    provider: file.provider ?? 'deepseek',
    wireApi,
    reasoningEffort,
    reasoningStages,
    reviewReasoningEffort: reasoningStages.review ?? undefined,
    adaptiveReasoning,
    reasoningSetting,
    httpHeaders: file.httpHeaders ?? {},
    temperature: file.temperature ?? 0,
    maxTokens: file.maxTokens ?? 8000,
    crossrefMailto: process.env.AA_CROSSREF_MAILTO ?? file.crossrefMailto,
    configPath: path,
  };
}

/** 兼容旧 Chat Completions 缓存，Responses 使用独立缓存。 */
export function llmCacheSuffix({ wireApi, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat', reasoningEffort }) {
  if (wireApi !== 'responses') return '';
  const requestSettings = [baseUrl.replace(/\/+$/, ''), model];
  if (reasoningEffort) requestSettings.push(reasoningEffort);
  const id = createHash('sha256').update(JSON.stringify(requestSettings)).digest('hex').slice(0, 12);
  return '-responses-' + id;
}
