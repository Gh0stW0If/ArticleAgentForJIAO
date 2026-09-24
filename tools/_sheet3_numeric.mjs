/** Sheet3 数值类指标的准确率拆解（严格口径；不含自然语言字段） */
import { readFileSync } from 'node:fs';

const rep = JSON.parse(readFileSync('build/eval/2015.json', 'utf8'));

/** 时点块内的**数值叶子**（与 outcome.ts 的键一致）。 */
const NUMERIC_LEAVES = new Set([
  'estimate', 'ci_lower', 'ci_upper', 'n',            // continuous 两组
  'events',                                            // binary 两组
  'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6',      // categorical 两组
  'difference_estimate', 'difference_ci_lower', 'difference_ci_upper',
]);
/** 时点块内的**编码字段**（严格可判定，但严格来说不算"数值"）。 */
const CODE_LEAVES = new Set(['estimate_type', 'variance_type']);

const isTimepoint = (k) => /^(baseline|end_of_treatment|follow_up_end)\./.test(k);
const leafOf = (k) => k.split('.').pop();
const tpOf = (k) => k.split('.')[0];

const rows = Object.entries(rep.byField)
  .filter(([k]) => isTimepoint(k))
  .map(([k, s]) => ({ k, tp: tpOf(k), leaf: leafOf(k), ...s }));

const acc = (s) => {
  const n = s.hit + s['code-hit'] + s.wrong + s.missed;
  return n ? (s.hit + s['code-hit']) / n : 0;
};
const sum = (list) => list.reduce((a, r) => ({
  hit: a.hit + r.hit + r['code-hit'], wrong: a.wrong + r.wrong, missed: a.missed + r.missed,
}), { hit: 0, wrong: 0, missed: 0 });

const numeric = rows.filter((r) => NUMERIC_LEAVES.has(r.leaf));
const codes = rows.filter((r) => CODE_LEAVES.has(r.leaf));
const other = rows.filter((r) => !NUMERIC_LEAVES.has(r.leaf) && !CODE_LEAVES.has(r.leaf));

const show = (label, list) => {
  const s = sum(list);
  const n = s.hit + s.wrong + s.missed;
  console.log(`  ${label.padEnd(22)} 准确率 ${((s.hit / n) * 100).toFixed(1).padStart(5)}%   ` +
    `命中 ${String(s.hit).padStart(3)} / 错 ${String(s.wrong).padStart(3)} / 漏 ${String(s.missed).padStart(3)}  （共 ${n}）`);
  return s;
};

console.log(`\n=== Sheet3 时点块字段的构成 ===`);
show('数值类（合计）', numeric);
show('编码类（estimate_type…）', codes);
show('其他', other);

console.log(`\n=== 数值类：按时点 ===`);
for (const tp of ['baseline', 'end_of_treatment', 'follow_up_end']) {
  show(tp, numeric.filter((r) => r.tp === tp));
}

console.log(`\n=== 数值类：按叶子 ===`);
const byLeaf = new Map();
for (const r of numeric) {
  if (!byLeaf.has(r.leaf)) byLeaf.set(r.leaf, []);
  byLeaf.get(r.leaf).push(r);
}
for (const [leaf, list] of [...byLeaf.entries()].sort((a, b) => sum(b[1]).hit + sum(b[1]).wrong + sum(b[1]).missed - (sum(a[1]).hit + sum(a[1]).wrong + sum(a[1]).missed))) {
  show(leaf, list);
}

console.log(`\n=== 数值类：按类型 ===`);
for (const kind of ['continuous', 'binary', 'categorical']) {
  const list = numeric.filter((r) => r.k.includes(`.${kind}.`));
  if (list.length) show(kind, list);
}
