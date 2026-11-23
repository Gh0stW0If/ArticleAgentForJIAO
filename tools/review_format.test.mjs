
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLegacySexDistribution, normalizeUnit, normalizeRatio, ratioAtReportedPrecision,
  normalizePValue, normalizeDispersion, equivalentDuplicateSD,
} from './lib/review-format.mjs';

const raw = value => ({ raw: String(value) });
const sexes = (total, experimental, control) => ({
  sexDistribution: raw(total), sexExperimental: raw(experimental), sexControl: raw(control),
});

test('compare the same sex-count scope and verify the source representation', () => {
  const old = sexes('121/415', '121/415', '132/407');
  const current = sexes('121/415; 132/407', '121/415', '132/407');
  assert.equal(compareLegacySexDistribution('121/415', old, current)?.equal, true);
  assert.equal(compareLegacySexDistribution('121/415', old,
    sexes('132/407; 121/415', '132/407', '121/415'))?.equal, false);
  assert.equal(compareLegacySexDistribution('121/415', old,
    sexes('131/407', '121/415', '132/407')), undefined);
  assert.equal(compareLegacySexDistribution('NA', sexes('NA', 'NA', 'NA'), current), undefined);
  assert.equal(compareLegacySexDistribution('72/56', sexes('72/56', '37/28', '35/28'),
    sexes('37/28;35/28', '37/28', '35/28'))?.reference.scope, 'overall');
});

test('unit aliases and percentages preserve meaning', () => {
  assert.equal(normalizeUnit('points'), normalizeUnit('分'));
  assert.equal(normalizeUnit('VMS / day'), 'VMS/day');
  assert.equal(normalizeUnit('NA'), undefined);
  assert.notEqual(normalizeUnit('hours'), normalizeUnit('min'));
  assert.equal(normalizeRatio('3.6%'), normalizeRatio('0.036'));
  assert.equal(normalizeRatio('360%'), undefined);
  assert.ok(ratioAtReportedPrecision('0.0996', 24, 241));
  assert.ok(ratioAtReportedPrecision('0.099585', 24, 241));
  assert.equal(ratioAtReportedPrecision('0.099585', 23, 241), false);
});

test('preserve P value relation and detect ambiguous evidence', () => {
  assert.deepEqual(normalizePValue('0.05', [{ quote: 'Compared groups (P < 0.05).' }]), { operator:'<', value:0.05 });
  assert.deepEqual(normalizePValue('P = 0.05'), { operator:'=', value:0.05 });
  assert.deepEqual(normalizePValue('P≤.001'), { operator:'<=', value:0.001 });
  assert.deepEqual(normalizePValue('P <= .001'), { operator:'<=', value:0.001 });
  assert.deepEqual(normalizePValue('0.05', [{ quote: 'P < 0.05 and P = 0.05' }]), { operator:'unspecified', value:0.05 });
});

const block = (type, estimate, n, lower, upper) => ({
  varianceType: raw(type), estimateType: raw(1),
  experimental: { estimate:raw(estimate), n:raw(n), ciLower:raw(lower), ...(upper === undefined ? {} : {ciUpper:raw(upper)}) },
});

test('only normalize redundant single-valued dispersion with matching context', () => {
  const old = block(3, 2.75, 536, 0.69, 0.69);
  const current = block(3, 2.75, 536, 0.69);
  assert.deepEqual(normalizeDispersion(current, 'experimental'), { type:'SD', value:0.69 });
  assert.ok(equivalentDuplicateSD('0.69', old, current, 'experimental'));
  assert.equal(equivalentDuplicateSD('0.69', old, block(3, 2.75, 500, 0.69), 'experimental'), false);
  assert.equal(equivalentDuplicateSD('0.69', old, block(1, 2.75, 536, 0.69), 'experimental'), false);
  assert.equal(normalizeDispersion(block(3, 26.36, 163, 16.29, 28.16), 'experimental'), undefined);
  assert.equal(normalizeDispersion(block(2, 2.75, 536, 0.69), 'experimental'), undefined);
  assert.deepEqual(normalizeDispersion(block(2, 2.75, 536, 2.1, 3.1), 'experimental'), { type:'CI', lower:2.1, upper:3.1 });
});
