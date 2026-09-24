/**
 * 把 Sheet1 低准确率字段"追到 SKILL 和提示词"。
 *
 * 三件事一次做完，避免人工在几千行提示词里翻：
 *   ① 字段 → SKILL（查 packages/skills/src/*.ts 的 FIELD_MAP）；
 *   ② 字段 → 提示词里的**渲染块**（`- **key（标签）**：说明` + 依据/填写要求/允许取值）；
 *   ③ 字段 → 它所在的**提示词章节**（最近的上层 `##` / `###` 标题），便于定位上下文。
 *
 * 用法：node tools/field_prompt_trace.mjs --fields author_contact,condition,... [--full]
 *       不带 --fields 则使用内置的"Sheet1 描述类最低 12 个"。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFieldLabels } from './lib/field_labels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const FULL = argv.includes('--full');

/** Sheet1 描述类准确率最低的一组（`node tools/sheet1_fields.mjs --kind 描述类 --top 12` 的产物）。 */
const DEFAULT_FIELDS = [
  'article.author_contact',
  'comparison.max_followup_desc',
  'comparison.sex_experimental',
  'comparison.sex_control',
  'comparison.frequency_desc',
  'comparison.needle_retention_desc',
  'comparison.course_desc',
  'comparison.insertion_depth_text',
  'comparison.control',
  'comparison.intervention',
  'comparison.randomization_method',
  'comparison.allocation_concealment',
];
const FIELDS = arg('fields', null)
  ? String(arg('fields', '')).split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_FIELDS;

const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/* ---------- ① 字段 → SKILL（从各 SKILL 的 FIELD_MAP 里找 camelCase 键） ---------- */
const SKILL_FILES = [
  ['article-meta', 'packages/skills/src/article-meta.ts'],
  ['comparison', 'packages/skills/src/comparison.ts'],
  ['outcome', 'packages/skills/src/outcome.ts'],
  ['outcome-values', 'packages/skills/src/outcome-values.ts'],
  ['study-plan', 'packages/skills/src/study-plan.ts'],
  ['outcome-plan', 'packages/skills/src/outcome-plan.ts'],
  ['outcome-audit', 'packages/skills/src/outcome-audit.ts'],
];
const sources = SKILL_FILES
  .map(([skill, rel]) => {
    const p = join(ROOT, rel);
    return existsSync(p) ? { skill, src: readFileSync(p, 'utf8') } : null;
  })
  .filter(Boolean);

function skillOf(field) {
  /* ⚠️ 只对**字段名**做驼峰化：`camel('article.author_contact')` 会把点号留下变成
     `article.authorContact`，永远匹配不到任何 FIELD_MAP（这个坑踩过一次）。 */
  const bare = field.includes('.') ? field.split('.').slice(1).join('.') : field;
  const c = camel(bare);
  const hits = sources.filter(({ src }) => new RegExp(`(^|[\\s{,])${c}\\s*:`).test(src)).map((s) => s.skill);
  return hits.length ? hits : ['（未在任何 FIELD_MAP 里 → 可能由代码推导）'];
}

/* ---------- ② 字段 → 提示词渲染块；③ → 所在章节 ---------- */
const PROMPT_FILES = [
  ['article-meta', 'build/prompts/article.md'],
  ['comparison', 'build/prompts/comparison.md'],
  ['outcome（结局自身字段）', 'build/prompts/outcome.md'],
  ['outcome-values（时点数值）', 'build/prompts/outcomeValue.md'],
];
const LABELS = createFieldLabels(ROOT);

/** 在一份提示词里找到字段的渲染块（从 `- **key` 开始，到下一个同级 `- **` 或空行结束）。 */
function blockOf(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^-\\s+\\*\\*${key}[（(]`).test(l) || new RegExp(`^-\\s+\\*\\*${key}\\*\\*`).test(l));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^-\s+\*\*/.test(l) || /^#{1,6}\s/.test(l)) break;
    out.push(l);
  }
  /* 去掉尾部空行 */
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { startLine: start + 1, text: out.join('\n') };
}

/** 找到该行之前最近的标题，给出章节路径。 */
function sectionOf(text, lineNo) {
  const lines = text.split('\n').slice(0, lineNo);
  const stack = [];
  for (const l of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(l);
    if (!m) continue;
    const level = m[1].length;
    stack.length = level - 1;
    stack[level - 1] = m[2].trim();
  }
  return stack.filter(Boolean).join(' › ');
}

console.log(`\n══ Sheet1 低准确率描述字段 → SKILL / 提示词 溯源 ══\n`);
for (const field of FIELDS) {
  const [scope, name] = field.includes('.') ? [field.split('.')[0], field.split('.').slice(1).join('.')] : ['comparison', field];
  const label = LABELS.describe(field).names.join(' / ') || '（无列名映射）';
  const skills = skillOf(`${scope}.${name}`);
  console.log(`■ ${field}`);
  console.log(`   原始表格列名：${label}`);
  console.log(`   归属 SKILL  ：${skills.join('、')}`);

  const key = camel(name);
  let found = false;
  for (const [pname, rel] of PROMPT_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const b = blockOf(text, key);
    if (!b) continue;
    found = true;
    console.log(`   提示词文件  ：${rel}（${pname}）第 ${b.startLine} 行`);
    console.log(`   所在章节    ：${sectionOf(text, b.startLine) || '（顶层）'}`);
    console.log('   ── 提示词原文 ──');
    for (const l of (FULL ? b.text.split('\n') : b.text.split('\n').slice(0, 8))) console.log('   ' + l);
    if (!FULL && b.text.split('\n').length > 8) console.log(`   …（该块共 ${b.text.split('\n').length} 行，加 --full 看全）`);
  }
  if (!found) console.log(`   提示词文件  ：**未在这些提示词里找到 ${key} 的字段块**（可能是代码推导，或键名不同）`);
  console.log();
}
