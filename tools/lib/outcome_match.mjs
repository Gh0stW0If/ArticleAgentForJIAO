/**
 * 结局行的**名称匹配**（多档严格度）——评测与字典工具共用。
 *
 * 为什么单独抽出来：`outcome_coverage.mjs`（诊断）与 `outcome_dictionary.mjs`（字典）
 * 必须用同一套判据，否则"诊断说能找到、字典说找不到"。
 *
 * 四路比对：gold名↔机器名 / gold名↔机器工具 / gold工具↔机器名 / gold工具↔机器工具，
 * 取最强的一路（金标准的"结局名称"列有时填的是疾病名，真正的结局写在"测量工具"列里）。
 *
 * 三档：
 *   strict   字面口径（与 `tools/lib/align.mjs` 的 Dice ≥0.34 / 词集包含 一致）
 *   synonym  加缩写展开（qol→quality of life、vas→visual analogue scale…）
 *   concept  加词形近似（depression≈depressive、birth≈births）+ 稀有内容词相交
 */
import { dice, normText, tokensOf } from './align.mjs';

/** 缩写展开表（只收实测撞到的，逐条可审计） */
export const ABBR = new Map(Object.entries({
  qol: 'quality of life', hrqol: 'quality of life',
  vas: 'visual analogue scale', vnrs: 'verbal numeric rating scale',
  nrs: 'numeric rating scale', vms: 'vasomotor symptoms',
  sas: 'anxiety', sds: 'depression', hads: 'anxiety depression',
  bdi: 'depression', cesd: 'depression', phq: 'depression', hamd: 'depression', hamay: 'anxiety',
  ponv: 'postoperative nausea vomiting', msq: 'migraine quality of life',
}));

const STOP = new Set(['of', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'a', 'an',
  'scale', 'score', 'questionnaire', 'index', 'test', 'instrument', 'measure', 'measurement',
  'assessment', 'survey', 'total', 'item', 'version', 'vs', 'from', 'after', 'before', 'during',
  'per', 'day', 'week', 'month', 'nr', 'na', 'ne']);

/** 词形近似：相等，或长度 ≥5 时互为前缀（depress≈depression、birth≈births） */
export const tokEq = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

export function tokenSet(s, { synonym = false, concept = false } = {}) {
  const raw = String(s ?? '')
    .replace(/[\u2460-\u2473]/g, ' ')
    .replace(/^\s*\d+\s*[.、)]\s*/, ' ');
  let toks = [...tokensOf(raw)];
  if (synonym || concept) toks = toks.flatMap((t) => (ABBR.has(t) ? ABBR.get(t).split(' ') : [t]));
  const out = new Set();
  for (const t of toks) {
    if (t.length <= 2 || STOP.has(t)) continue;
    out.add(concept ? t.replace(/(iveness|ation|ings|ing|ive|ies|es|s)$/, (m) => (t.length - m.length >= 4 ? '' : m)) : t);
  }
  return out;
}

const inter = (A, B, concept) => {
  let n = 0;
  for (const a of A) for (const b of B) if (concept ? tokEq(a, b) : a === b) { n++; break; }
  return n;
};
const setDice = (A, B, concept) => {
  if (!A.size || !B.size) return 0;
  const n = inter(A, B, concept);
  return (2 * n) / (A.size + B.size);
};

/**
 * 单路匹配强度。level: exact > subset > strong > weak > none
 */
export function strength(a, b, opt = {}) {
  const A = tokenSet(a, opt); const B = tokenSet(b, opt);
  if (!A.size || !B.size) return { level: 'none', d: 0 };
  if (normText(a) && normText(a) === normText(b)) return { level: 'exact', d: 1 };
  const n = inter(A, B, Boolean(opt.concept));
  const minSize = Math.min(A.size, B.size);
  const d = (2 * n) / (A.size + B.size);
  if (n === minSize && minSize >= 1) return { level: 'subset', d };
  if (d >= 0.5) return { level: 'strong', d };
  if (d >= 0.34) return { level: 'weak', d };
  if (opt.concept && n >= 1 && d >= 0.3) return { level: 'weak', d };
  if (opt.weak && n >= 1) return { level: 'weak', d };
  return { level: 'none', d };
}
export const RANK = { exact: 4, subset: 3, strong: 2, weak: 1, none: 0 };

/** 一条金标准行 vs 一条机器行：四路取最强 */
export function bestMatch(goldRow, machRow, opt = {}) {
  const gn = String(goldRow?.outcome?.name?.raw ?? '');
  const gi = String(goldRow?.outcome?.instrument?.raw ?? '');
  const mn = String(machRow?.outcome?.name?.raw ?? '');
  const mi = String(machRow?.outcome?.instrument?.raw ?? '');
  const cands = [
    ['名↔名', gn, mn], ['名↔具', gn, mi], ['具↔名', gi, mn], ['具↔具', gi, mi],
  ].map(([how, a, b]) => ({ how, ...strength(a, b, opt) }));
  cands.sort((x, y) => RANK[y.level] - RANK[x.level] || y.d - x.d);
  return cands[0];
}

/** 金标准的这一行，机器的列表里有没有（不要求一对一） */
export function presentIn(goldRow, machRows, opt = {}) {
  let best = { level: 'none', d: 0, how: '', row: null };
  for (const m of machRows) {
    const r = bestMatch(goldRow, m, opt);
    if (RANK[r.level] > RANK[best.level] || (RANK[r.level] === RANK[best.level] && r.d > best.d)) best = { ...r, row: m };
  }
  return best;
}
