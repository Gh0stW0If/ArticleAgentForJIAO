import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonScope, createOutcomeAuditSkill, createOutcomePlanSkill, declaredPrimaryChange, matchesDeclaredChange,
  sourceEventPair, validateExtractedIntervals,
} from '../packages/skills/dist/index.js';
import { applyNativeTableRepairs, verifyNativeTableRows } from './lib/source-table-repair.mjs';

const text = (index, value) => ({ index, text: value, page: 1, section: 'methods', type: 'text', bbox: null });
const table = (index, grid, caption = 'Table 2. Study results') => ({
  index, text: caption, page: 2, section: 'results', type: 'table', bbox: null,
  table: { caption, grid, html: '' },
});
const doc = (...blocks) => ({ articleId: '2026-01', blocks });
const field = (raw, code, evidence = []) => ({ raw, ...(code ? { code } : {}), evidence, provenance: 'model', confidence: 1 });
const mock = (paper, invoke) => ({ doc: paper, llm: { invoke } });

const declaration = text(1, 'The primary outcome was the change from baseline in mean weekly complete spontaneous bowel move-\nments (CSBMs) during weeks 1 to 8.');
const changeTable = table(2, [
  ['Outcome', 'EA Group (n=536)', 'SA Group (n=539)', 'Between-Group Difference (95% CI)', 'P Value'],
  ['Change from baseline in mean CSBMs per week (95% CI)', '', '', '', ''],
  ['Weeks 1-8', '1.76 (1.61 to 1.89)', '0.87 (0.73 to 0.97)', '0.90 (0.74 to 1.10)†', '<0.001'],
  ['Weeks 9-20', '1.96 (1.78 to 2.11)', '0.89 (0.69 to 0.95)', '1.09 (0.94 to 1.31)†', '<0.001'],
  ['Participants with ≥3 CSBMs per week', '168 (31.3)', '65 (12.1)', '', ''],
]);

test('recovers the declared change and its two intervals without crossing into the rate row', () => {
  const result = declaredPrimaryChange(doc(declaration, changeTable));
  assert.match(result.planned.name.raw, /change from baseline/);
  assert.equal(result.planned.name.evidence[0].quote, declaration.text);
  assert.equal(result.timepoints.endOfTreatment.continuous.experimental.estimate.raw, '1.76');
  assert.equal(result.timepoints.followUpEnd.continuous.experimental.estimate.raw, '1.96');
  assert.equal(result.timepoints.endOfTreatment.binary.differenceCiUpper.raw, '1.10');
  assert.equal(result.timepoints.followUpEnd.binary.differenceCiUpper.raw, '1.31');
  assert.equal(matchesDeclaredChange(result, 'mean CSBMs per week'), true);
  assert.equal(matchesDeclaredChange(result, 'proportion of patients with mean CSBMs per week'), false);
  assert.equal(matchesDeclaredChange(result, 'mean SBMs per week'), false);
  assert.equal(declaredPrimaryChange(doc(declaration, changeTable, { ...changeTable, index: 3 })), undefined);
});

test('missing primary declaration is checked against results before targeted recovery', async () => {
  const primary = 'The primary outcome was pain intensity at 6 weeks.';
  const paper = doc(text(1, primary), table(2, [
    ['Measure', 'Experimental', 'Control'],
    ['Pain intensity', '2.7', '4.9'],
  ]));
  let calls = 0;
  const skill = createOutcomePlanSkill({ primaryHint: field('pain intensity') });
  const out = await skill.run(mock(paper, async () => {
    calls++;
    if (calls === 1) return { json: { outcomes: [] } };
    const claim = value => ({ value, quote: primary });
    return { json: { outcomeName: claim('pain intensity'), anchor: claim(primary), outcomeClass: claim('1') } };
  }));
  assert.equal(calls, 2);
  assert.equal(out.payload.outcomes[0].name.raw, 'pain intensity');
});

const groups = ['Control group', 'TEAS-2 Hz group', 'TEAS-100 Hz group', 'TEAS-2/100 Hz group'];
const arms = {
  groups: groups.map((label, i) => ({ label: field(label), role: field(i ? 'experimental' : 'control') })),
  comparisons: groups.slice(1).map(label => ({
    intervention: field(`${label}; routine IVF`), control: field('Participants in the control group received routine IVF'),
  })),
};
const pregnancy = table(4, [
  ['Items', 'Control group (n=109)', 'TEAS-2 Hz group (n=108)', 'TEAS-100 Hz group (n=111)', 'TEAS-2/100 group (n=114)'],
  ['Clinical pregnancy rate (%)', '46/109 (42.2%)', '46/108 (42.59%)', '47/111 (42.34%)', '64/114 (56.14%) * #'],
  ['Implantation rate (%)', '54/217 (24.88%)', '55/219 (25.11%)', '53/223 (23.77%)', '82/231 (35.50%) * #'],
]);

test('same control identity, exclusive frequencies and table-specific denominators', () => {
  const scopes = arms.comparisons.map((_, index) => comparisonScope('2026-01', index, arms));
  assert.equal(new Set(scopes.map(scope => scope.controlId)).size, 1);
  assert.equal(new Set(scopes.map(scope => scope.interventionId)).size, 3);
  const clinical = scopes.map(scope => sourceEventPair(doc(pregnancy), 'clinical pregnancy rate', scope));
  assert.deepEqual(clinical.map(pair => [pair.experimental.events.raw, pair.experimental.n.raw]), [['46', '108'], ['47', '111'], ['64', '114']]);
  const implantation = sourceEventPair(doc(pregnancy), 'implantation rate', scopes[2]);
  assert.equal(implantation.experimental.n.raw, '231');
  assert.equal(implantation.control.n.raw, '217');
  assert.equal(sourceEventPair(doc(pregnancy, { ...pregnancy, index: 5 }), 'implantation rate', scopes[2]), undefined);
});

test('audit deletes an SD upper claim and declines duplicate-outcome or cross-cell proposals', async () => {
  const t = table(5, [
    ['Outcome', 'Group A', 'Group B'],
    ['baseline', '26.36 (16.29)', '24.15 (9.78)'],
    ['4 weeks', '26.36 (25.10 to 28.16)', '23.10 (21.04 to 25.67)'],
  ]);
  const evidence = (row, column) => [{ kind: 'table', page: 2, bbox: null, blockId: 'b5',
    quote: t.table.grid[row - 1][column - 1], tableCell: { row, column } }];
  const timepoints = { baseline: { continuous: { varianceType: field('SD', '3'),
    experimental: { estimate: field('26.36', undefined, evidence(2, 2)), ciLower: field('16.29', undefined, evidence(2, 2)), ciUpper: field('28.16', undefined, evidence(3, 2)) },
  } } };
  const issues = [];
  const unresolved = [];
  validateExtractedIntervals(timepoints, 'outcomes.0', issues, unresolved);
  assert.equal(issues[0].code, 'SINGLE_VARIANCE_UPPER');
  assert.equal(timepoints.baseline.continuous.experimental.ciLower.raw, '16.29');
  assert.equal(timepoints.baseline.continuous.experimental.ciUpper, undefined);

  const rows = [0, 1].map(index => ({ studyId: `2026-01-0${index + 1}`, outcome: { name: field('Hot flashes') },
    timepoints: structuredClone(timepoints), comparisonScope: comparisonScope('2026-01', index, arms),
  }));
  const proposal = { outcomeName: 'Hot flashes', timepoint: 'baseline', quote: '26.36 (25.10 to 28.16)',
    field: 'experimentalCiUpper', value: '28.16', source: { block: 5, row: 3, column: 2 } };
  const result = await createOutcomeAuditSkill({ extracted: rows }).run(mock(doc(t), async () => ({
    json: { gaps: [proposal, { ...proposal, outcomeId: '2026-01:comparison:1:1' }] },
  })));
  assert.deepEqual(result.payload.reported.map(item => item.outcomeIndex), [null, 0]);
  assert.deepEqual(result.payload.filled, []);
  assert.equal(result.payload.checkResults.some(item => item.code === 'AUDIT_CI_INCOMPLETE'), false);
  assert.equal(rows[0].timepoints.baseline.continuous.experimental.ciUpper, undefined);
});

test('audit only fills a missing bound from the same estimate cell of a CI', async () => {
  const t = table(6, [
    ['Outcome', 'Group A', 'Group B'],
    ['4 weeks', '26.36 (25.10 to 28.16)', '23.10 (21.04 to 25.67)'],
  ]);
  const ev = [{ kind: 'table', page: 2, bbox: null, blockId: 'b6', quote: '26.36 (25.10 to 28.16)', tableCell: { row: 2, column: 2 } }];
  const row = { studyId: '2026-01', outcome: { name: field('Hot flashes') }, timepoints: { endOfTreatment: {
    continuous: { varianceType: field('95% CI', '2'), experimental: { estimate: field('26.36', undefined, ev), ciLower: field('25.10', undefined, ev) } },
  } } };
  const candidate = { outcomeName: 'Hot flashes', timepoint: 'endOfTreatment', field: 'experimentalCiUpper' };
  const out = await createOutcomeAuditSkill({ extracted: [row] }).run(mock(doc(t), async () => ({
    json: { gaps: [
      { ...candidate, quote: '23.10 (21.04 to 25.67)', value: '25.67', source: { block: 6, row: 2, column: 3 } },
      { ...candidate, quote: ev[0].quote, value: '28.16', source: { block: 6, row: 2, column: 2 } },
    ] },
  })));
  assert.equal(out.payload.reported.length, 1);
  assert.equal(out.payload.filled.length, 1);
  assert.equal(row.timepoints.endOfTreatment.continuous.experimental.ciUpper.raw, '28.16');
});

test('both missing CI endpoints are committed together when one cell supports the triple', async () => {
  const t = table(6, [
    ['Outcome', 'Group A', 'Group B'],
    ['4 weeks', '26.36 (25.10 to 28.16)', '23.10 (21.04 to 25.67)'],
  ]);
  const ev = [{ kind: 'table', page: 2, bbox: null, blockId: 'b6', quote: '26.36 (25.10 to 28.16)', tableCell: { row: 2, column: 2 } }];
  const row = { studyId: '2026-01', outcome: { name: field('Hot flashes') }, timepoints: { endOfTreatment: {
    continuous: { varianceType: field('95% CI', '2'), experimental: { estimate: field('26.36', undefined, ev) } },
  } } };
  const base = { outcomeName: 'Hot flashes', timepoint: 'endOfTreatment', quote: ev[0].quote, source: { block: 6, row: 2, column: 2 } };
  const proposals = [
    { ...base, field: 'experimentalCiLower', value: '25.10' },
    { ...base, field: 'experimentalCiUpper', value: '28.16' },
  ];
  const skill = createOutcomeAuditSkill({ extracted: [row] });
  const partial = await skill.run(mock(doc(t), async () => ({ json: { gaps: proposals.slice(0, 1) } })));
  assert.equal(partial.payload.filled.length, 0);
  const full = await skill.run(mock(doc(t), async () => ({ json: { gaps: proposals } })));
  assert.equal(full.payload.filled.length, 2);
  assert.equal(row.timepoints.endOfTreatment.continuous.experimental.ciLower.raw, '25.10');
  assert.equal(row.timepoints.endOfTreatment.continuous.experimental.ciUpper.raw, '28.16');
});

test('repairs digit loss only with a unique same-page, same-table row and preserves original input', () => {
  const t = table(7, [
    ['Outcome', 'Arm A', 'Arm B', 'P Value'],
    ['TST (min)', '348.9±|15.79', '385.8±123.24', '0.063'],
    ['4w-baseline', '10.0 ± 171.46', '18.7 ± 163.26', '0.004'],
  ]);
  const native = [
    'Table 2. Study results',
    'TST (min)       348.9 ± 115.79       385.8 ± 123.24     0.063',
    '4w–baseline     110.0 ± 171.46        18.7 ± 163.26     0.004',
  ];
  const original = doc(t);
  const verified = verifyNativeTableRows(original, new Map([[2, native.join('\n')]]));
  assert.equal(verified.repairs.length, 2);
  assert.equal(t.table.grid[1][1], '348.9±|15.79');
  const [baseline, end] = verified.repairs;
  assert.equal(baseline.sd, '115.79');
  assert.equal(end.estimate, '110.0');
  const row = { timepoints: { endOfTreatment: { continuous: {
    varianceType: field('SD', '3'),
    experimental: { estimate: field('10.0', undefined, [end.evidence]), ciLower: field('171.46') },
    control: { estimate: field('18.7', undefined, [{ ...end.evidence, tableCell: { row: 3, column: 3 } }]) },
  } } } };
  assert.equal(applyNativeTableRepairs(row, verified.repairs), 1);
  assert.equal(row.timepoints.endOfTreatment.continuous.experimental.estimate.raw, '110.0');
  assert.equal(row.timepoints.endOfTreatment.continuous.control.estimate.raw, '18.7');
  const ambiguous = verifyNativeTableRows(original, new Map([[2, [...native, native[2]].join('\n')]]));
  assert.equal(ambiguous.repairs.length, 1);
  assert.equal(ambiguous.unresolved.length, 1);
});
