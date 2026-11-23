import { normalizeMeasurementUnit } from '../../packages/core/dist/index.js';

const decimal = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

export function text(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function number(value) {
  const raw = text(value);
  return decimal.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
}

const sexPair = /^(\d+)\s*\/\s*(\d+)$/;

export function sexCounts(value) {
  const m = sexPair.exec(text(value));
  if (!m) return undefined;
  const male = Number(m[1]);
  const female = Number(m[2]);
  if (!Number.isSafeInteger(male) || !Number.isSafeInteger(female)) return undefined;
  return { male, female };
}

const eqPair = (a, b) => Boolean(a && b && a.male === b.male && a.female === b.female);

function legacySexRecord(comparison) {
  const experimental = sexCounts(comparison?.sexExperimental?.raw);
  const control = sexCounts(comparison?.sexControl?.raw);
  if (!experimental || !control) return undefined;
  const overall = { male: experimental.male + control.male, female: experimental.female + control.female };
  const raw = text(comparison.sexDistribution?.raw);
  const parts = raw.split(/\s*(?:;|\bvs\.?|对照)\s*/).map(sexCounts);
  if (parts.length === 2 && eqPair(parts[0], experimental) && eqPair(parts[1], control)) {
    return { experimental, control, overall };
  }
  if (parts.length === 1 && [overall, experimental, control].some(counts => eqPair(parts[0], counts))) {
    return { experimental, control, overall };
  }
  return undefined;
}

export function compareLegacySexDistribution(reference, oldComparison, newComparison) {
  const expected = sexCounts(reference);
  if (!expected || !eqPair(sexCounts(oldComparison?.sexDistribution?.raw), expected)) return undefined;
  const old = legacySexRecord(oldComparison);
  const current = legacySexRecord(newComparison);
  if (!old || !current) return undefined;
  const scopes = ['experimental', 'control', 'overall'].filter(scope => eqPair(old[scope], expected));
  if (scopes.length !== 1) return undefined;
  const [scope] = scopes;
  return { reference: { scope, ...expected }, current: { scope, ...current[scope] }, equal: eqPair(expected, current[scope]) };
}

export function normalizeUnit(value) {
  const normalized = normalizeMeasurementUnit(value);
  return ['reported','dimensionless'].includes(normalized.status) ? normalized.canonical : undefined;
}

export function normalizeRatio(value) {
  const raw = text(value);
  const percent = raw.endsWith('%');
  const magnitude = percent ? raw.slice(0, -1).trim() : raw;
  if (number(magnitude) === undefined) return undefined;
  const ratio = Number(percent ? magnitude + 'e-2' : magnitude);
  return ratio !== undefined && ratio >= 0 && ratio <= 1 ? ratio : undefined;
}

export function ratioAtReportedPrecision(value, numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
      numerator < 0 || denominator <= 0 || numerator > denominator) return false;
  const raw = text(value);
  const ratio = normalizeRatio(raw);
  if (ratio === undefined) return false;
  const places = /\.(\d+)\s*%?$/.exec(raw)?.[1].length ?? 0;
  const scale = raw.endsWith('%') ? 100 : 1;
  const expected = normalizeRatio((numerator * scale / denominator).toFixed(places) + (scale === 100 ? '%' : ''));
  return ratio === expected;
}

const pNumber = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const relation = '(?:<=|>=|[<>=≤≥])';
const explicitP = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])p(?:\s*[- ]?\s*value)?\s*(` + relation + String.raw`)\s*(` + pNumber + String.raw`)(?![\w.])`, 'gu');
const standaloneP = new RegExp('^\\s*(?:p\\s*)?(' + relation + ')?\\s*(' + pNumber + ')\\s*$', 'u');
const op = symbol => ({ '≤': '<=', '≥': '>=' })[symbol] ?? symbol;

export function normalizePValue(value, evidence = []) {
  const m = standaloneP.exec(text(value));
  if (!m) return undefined;
  const v = Number(m[2]);
  if (!Number.isFinite(v) || v < 0 || v > 1) return undefined;
  if (m[1]) return { operator: op(m[1]), value: v };

  const operators = new Set();
  for (const item of evidence) {
    const quote = text(item.quote);
    const matches = [...quote.matchAll(explicitP)];
    const single = standaloneP.exec(quote);
    if (single?.[1]) matches.push(single);
    for (const match of matches) {
      if (Number(match[2]) === v) operators.add(op(match[1]));
    }
  }
  return { operator: operators.size === 1 ? [...operators][0] : 'unspecified', value: v };
}

function readNumber(field) {
  return number(field?.raw);
}

export function normalizeDispersion(block, side) {
  const record = block?.[side];
  if (!record) return undefined;
  const lo = readNumber(record.ciLower);
  const hi = readNumber(record.ciUpper);
  const type = String(block.varianceType?.code ?? block.varianceType?.raw ?? '');
  if (type === '3' || type === '1') {
    if (lo === undefined || lo < 0 || (hi !== undefined && hi !== lo)) return undefined;
    return { type: type === '3' ? 'SD' : 'SE', value: lo };
  }
  if (type === '2' || type === '4') {
    if (lo === undefined || hi === undefined || lo > hi) return undefined;
    return { type: type === '2' ? 'CI' : 'IQR', lower: lo, upper: hi };
  }
  return undefined;
}

export function equivalentDuplicateSD(reference, oldBlock, newBlock, side) {
  const old = normalizeDispersion(oldBlock, side);
  const current = normalizeDispersion(newBlock, side);
  if (!old || !current || !['SD', 'SE'].includes(old.type) || old.type !== current.type ||
      old.value !== current.value || old.value !== number(reference)) return false;
  const oldSide = oldBlock[side];
  const newSide = newBlock[side];
  if (readNumber(oldSide.ciUpper) !== old.value || text(newSide.ciUpper?.raw)) return false;
  const oldEstimate = readNumber(oldSide.estimate);
  const oldN = readNumber(oldSide.n);
  const estimateType = block => text(block.estimateType?.code ?? block.estimateType?.raw);
  return oldEstimate !== undefined && oldEstimate === readNumber(newSide.estimate) &&
    oldN !== undefined && oldN === readNumber(newSide.n) &&
    Boolean(estimateType(oldBlock)) && estimateType(oldBlock) === estimateType(newBlock);
}
