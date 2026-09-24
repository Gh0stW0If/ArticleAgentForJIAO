/**
 * 字段键名跨接：camelCase（流水线 / 规范清单） ↔ snake_case（金标准 JSON）
 *
 * 为什么单独成文件：评测（tools/llm_eval.mjs）与覆盖审计（tools/field_coverage.mjs）
 * 必须用**同一套**规则，否则一边算对一边算错，问题会很难定位。
 * 实测踩过的坑：只写 `([a-z0-9])([A-Z])` 时，遇到连续大写就断不开——
 *   randomizedNExperimental → randomized_nexperimental（错）
 * 正确结果应为 randomized_n_experimental，因此还要处理 `([A-Z]+)([A-Z][a-z])`。
 */

/** camelCase / PascalCase → snake_case，数字前也加下划线（funding1 → funding_1）。 */
export const camelToSnake = (k) =>
  String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([A-Za-z])(\d)/g, '$1_$2')
    .toLowerCase();

/** snake_case → camelCase（反向；用于由金标准键推规范键）。 */
export const snakeToCamel = (k) =>
  String(k).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
