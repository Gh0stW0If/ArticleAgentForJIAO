/**
 * A/B：带单位的三列（\`*_desc\`/\`*_value\`/\`*_unit\`）在**提示词改写前后**的变化。
 *
 * 直接按"逐比较组直接比对"的口径算（不经 judged 子集），分类与
 * `tools/_scheme_columns_direct.mjs` 一致：
 *   一致报NR / 值一致 / 值不同 / **漏抽** / **过度填充**
 *
 * 用法：node tools/_unit_rules_ab.mjs --old build/_backup_units
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const OLD = arg('old', 'build/_backup_units');

const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const codeOf = (o) => (o && typeof o === 'object' && 'code' in o && o.code ? String(o.code) : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';
const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const COLS = [
  ['needle_retention_desc', '留针-描述'], ['needle_retention_value', '留针-数值'], ['needle_retention_unit', '留针-单位'],
  ['course_desc', '疗程-描述'], ['course_value', '疗程-数值'], ['course_unit', '疗程-单位'],
  ['frequency_desc', '频次-描述'], ['frequency_value', '频次-数值'], ['frequency_unit', '频次-单位'],
  ['max_followup_desc', '随访-描述'], ['max_followup_value', '随访-数值'], ['max_followup_unit', '随访-单位'],
];

/**
 * 收集一批文章的 prediction。
 * ⚠️ 两个目录结构不同：备份目录是**扁平**的（`_backup_units/2015-01.json`），
 * 而产物目录是**按年份分目录**的（`build/extraction/2015/2015-01.json`）。
 */
function loadPreds(dir, only) {
  const out = new Map();
  for (const id of only) {
    const flat = join(ROOT, dir, `${id}.json`);
    const nested = join(ROOT, dir, id.slice(0, 4), `${id}.json`);
    const file = existsSync(flat) ? flat : (existsSync(nested) ? nested : null);
    if (!file) continue;
    try { out.set(id, JSON.parse(readFileSync(file, 'utf8'))); } catch { /* 跳过坏文件 */ }
  }
  return out;
}

function classify(preds) {
  const st = new Map();
  const bump = (col, kind) => { const s = st.get(col) ?? { n: 0 }; s[kind] = (s[kind] ?? 0) + 1; s.n++; st.set(col, s); };
  for (const [id, pred] of preds) {
    const y = id.slice(0, 4);
    const gf = join(ROOT, 'build', 'gold', `${y}.json`);
    if (!existsSync(gf)) continue;
    const gold = JSON.parse(readFileSync(gf, 'utf8'));
    const ga = (gold.articles ?? []).find((a) => a.article_id === id);
    if (!ga) continue;
    const gcs = ga.comparisons ?? []; const pcs = pred.comparisons ?? [];
    for (let i = 0; i < gcs.length; i++) {
      if (!pcs[i]) continue;
      for (const [key] of COLS) {
        const gLeaf = gcs[i][key]; const pLeaf = pcs[i][CAMEL(key)];
        if (gLeaf === undefined && pLeaf === undefined) continue;
        const gv = raw(gLeaf); const pv = raw(pLeaf);
        const gc = codeOf(gLeaf); const pc = codeOf(pLeaf);
        const gSent = isSent(gv); const pSent = isSent(pv);
        const gHas = key.endsWith('_unit') ? !!gc : !gSent;
        const pHas = key.endsWith('_unit') ? !!pc : !pSent;
        if (gSent && pSent) { bump(key, 'bothNR'); continue; }
        if (gHas && pHas) {
          const same = key.endsWith('_unit') ? gc === pc : gv.replace(/\s+/g, '') === pv.replace(/\s+/g, '');
          bump(key, same ? 'same' : 'diff'); continue;
        }
        if (gHas && !pHas) { bump(key, 'miss'); continue; }
        if (!gHas && pHas) { bump(key, 'over'); continue; }
        bump(key, 'other');
      }
    }
  }
  return st;
}

const only = readdirSync(join(ROOT, OLD)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const before = classify(loadPreds(OLD, only));
const after = classify(loadPreds('build/extraction', only));
const sum = (m) => {
  const t = { n: 0, bothNR: 0, same: 0, diff: 0, miss: 0, over: 0, other: 0 };
  for (const s of m.values()) for (const k of Object.keys(t)) t[k] += s[k] ?? 0;
  return t;
};
const A = sum(before); const B = sum(after);
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

console.log(`\n══ 带单位三列的 A/B（旧目录 ${OLD}）══\n`);
console.log('  结论            旧        新        变化');
for (const [k, label] of [['bothNR', '一致报 NR'], ['same', '值一致'], ['diff', '值不同'], ['miss', '漏抽'], ['over', '过度填充']]) {
  const d = B[k] - A[k];
  console.log(`  ${label.padEnd(12)}${String(A[k]).padStart(6)}   ${String(B[k]).padStart(6)}   ${d >= 0 ? '+' : ''}${d}`);
}
console.log(`  ${'样本'.padEnd(12)}${String(A.n).padStart(6)}   ${String(B.n).padStart(6)}`);
console.log(`\n  直观正确率（一致报NR + 值一致）：旧 ${pc(A.bothNR + A.same, A.n)} → 新 ${pc(B.bothNR + B.same, B.n)}`);

console.log('\n  逐列（值一致率 / 漏抽 / 过度填充）：');
console.log('    列            旧值一致   新值一致   旧漏抽  新漏抽   旧过填  新过填');
for (const [key, label] of COLS) {
  const a = before.get(key) ?? { n: 0 }; const b = after.get(key) ?? { n: 0 };
  const f = (x) => `${x.same ?? 0}/${x.n || 0}`;
  console.log(`    ${label.padEnd(12)}${f(a).padStart(8)}  ${f(b).padStart(8)}  ${String(a.miss ?? 0).padStart(6)}  ${String(b.miss ?? 0).padStart(6)}  ${String(a.over ?? 0).padStart(6)}  ${String(b.over ?? 0).padStart(6)}`);
}
