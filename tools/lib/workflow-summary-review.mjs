import { renderBlock } from './workflow-materials.mjs';

function words(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function outcomeMaterials(materials, candidate) {
  const names = [candidate.name, candidate.instrument?.split(':')[0]].filter(Boolean);
  const aliases = new Set();
  for (const name of names) {
    const full = words(name);
    if ((full.length >= 4 || /^[A-Z][A-Z0-9]{1,9}$/.test(name.trim())) && !['nr', 'na', 'ne'].includes(full)) aliases.add(full);
    for (const [, abbreviation] of name.matchAll(/\(([A-Z][A-Z0-9-]{1,11})\)/g)) aliases.add(words(abbreviation));
    const bare = words(name.replace(/\([^()]*\)/g, ''));
    if (bare.length >= 4) aliases.add(bare);
    if (bare.split(' ').length >= 3 && / (score|scale)$/.test(bare)) {
      aliases.add(bare.replace(/ (score|scale)$/, (_, kind) => kind === 'score' ? ' scale' : ' score'));
    }
  }
  const attachmentIds = new Set(materials.sources.filter(source => source.attachment).map(source => source.id));
  const evidence = candidate.evidence ?? [];
  const related = materials.blocks.filter(block => {
    if (attachmentIds.has(block.documentId)) return true;
    if (evidence.some(e => e.blockId === block.id || (e.documentId === block.documentId && e.page === block.page))) return true;
    const content = ' ' + words([block.text, block.caption, block.grid?.flat().join(' ')].join(' ')) + ' ';
    return [...aliases].some(alias => content.includes(' ' + alias + ' '));
  });
  return related.length ? related : materials.blocks;
}

const reviewableKeys = ['estimate', 'n', 'events', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper'];
const missingUnit = record => ['not_reported', 'not_extractable', 'unrecognized'].includes(record.unit?.status);

export function fieldReviewTarget(item, record, chunk) {
  if (record.rejected || record.status !== 'needs_review' || !item.time) return null;
  const unresolved = reviewableKeys.filter(key => item.values?.[key]?.value != null && record.values[key] === undefined);
  for (const [low, high] of [['ciLower', 'ciUpper'], ['iqrLower', 'iqrUpper']]) {
    if (unresolved.includes(low) && !unresolved.includes(high)) unresolved.push(high);
    else if (unresolved.includes(high) && !unresolved.includes(low)) unresolved.push(low);
  }
  if (missingUnit(record) && item.unit?.source?.quote && !/^(?:NR|NA|N\/A|NE)?$/i.test(String(item.unit.value ?? '').trim())) {
    unresolved.push('unit');
  }
  if (!unresolved.length) return null;
  const anchors = [record.scopeSource?.blockId, ...Object.values(record.evidence).map(e => e.blockId)];
  for (const key of unresolved) {
    const claim = key === 'unit' ? item.unit : item.values?.[key];
    if (!claim?.source?.quote) continue;
    anchors.push(String(claim.source.block ?? '').trim().replace(/^\[\[([\s\S]*)\]\]$/, '$1'));
  }
  const blockIds = new Set(anchors.filter(Boolean));
  const blocks = chunk.filter(block => blockIds.has(block.id));
  if (!blocks.length) return null;
  return { item, record, fields: unresolved, blocks };
}

const reviewPrompt = '复核指定的临床试验结局字段。只检查给出的字段，不改变组别、结局、时点、估计类型或已核实的值。'
  + '不能从相邻行或其他比较组代取数据。CI 或 IQR 的两界必须属于同一估计；SD、SE 各为单值。有表格时请定位到同一数据单元格。'
  + '保留完整原文 quote，用 [[...]] 里的 block 标识；行列号从 1 开始，适用于表格网格。没有证据的字段省略。'
  + '返回 JSON {"repairs":[{"id":1,"values":{"字段":{"value":"原值","source":{"block":"标识","quote":"原文","row":1,"column":1}}},"unit":{"value":"原文单位","source":{"block":"标识","quote":"原文"}}}]}。';

export async function reviewSummaryFields({ materials, candidate, targets, llm, tag, validate, reasoningEffort = 'high' }) {
  // Keep one bounded review request per selected outcome.
  const selected = targets.slice(0, 6);
  const blocks = new Map();
  for (const target of selected) {
    for (const block of target.blocks) blocks.set(block.id, block);
  }
  if (!blocks.size) return new Map();
  const request = selected.map(({ record, fields }, index) => ({
    id: index + 1, group: record.group, comparison: record.comparison, time: record.time,
    estimand: record.estimand, statistic: record.statistic, verified: record.values, fields,
  }));
  const response = await llm.invoke({
    system: reviewPrompt,
    user: JSON.stringify({ outcome: candidate.name, instrument: candidate.instrument, domain: candidate.domain, targets: request })
      + '\n\n' + [...blocks.values()].map(block => renderBlock(block, 9000)).join('\n\n').slice(0, 36000),
    temperature: 0, reasoningEffort, tag,
  });
  if (!Array.isArray(response.json?.repairs)) throw Error('疑难字段复核未返回 repairs 数组');
  const repaired = new Map();
  for (const proposal of response.json.repairs) {
    const index = Number(proposal?.id) - 1;
    if (!Number.isInteger(index) || repaired.has(index)) continue;
    const target = selected[index];
    if (!target) continue;
    const { item, record, fields } = target;
    const revised = { ...item, values: { ...item.values } };
    const allowedBlocks = new Set(target.blocks.map(block => block.id));
    const sourceAllowed = value => allowedBlocks.has(String(value?.source?.block ?? '').trim().replace(/^\[\[([\s\S]*)\]\]$/, '$1'));
    for (const key of fields) {
      if (key === 'unit') {
        if (sourceAllowed(proposal.unit)) revised.unit = proposal.unit;
      } else if (sourceAllowed(proposal.values?.[key])) {
        revised.values[key] = proposal.values[key];
      }
    }
    const result = validate(materials, candidate, revised);
    if (result.rejected || result.id !== record.id) continue;
    if (!Object.entries(record.values).every(([key, value]) => result.values[key] === value)) continue;
    if ((record.unit?.canonical && result.unit?.canonical !== record.unit.canonical) || result.issues.length > record.issues.length) continue;
    const gained = fields.filter(key => key === 'unit' ? !missingUnit(result) : result.values[key] !== undefined);
    if (gained.length) repaired.set(index, { ...result, reasoningReview: { effort: reasoningEffort ?? 'auto', fields: gained } });
  }
  return repaired;
}
