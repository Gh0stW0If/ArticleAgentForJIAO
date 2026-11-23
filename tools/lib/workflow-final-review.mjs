import { fingerprint } from './workflow-store.mjs';
import { groundSource, renderBlock } from './workflow-materials.mjs';

export function canReviewSummary(state) {
  return ['done', 'partial'].includes(state.stages.summary?.status)
    && state.result?.selectionRevision === state.selection.revision
    && Boolean(state.result?.records?.length);
}

export function finalReviewSnapshot(state, records) {
  return fingerprint([state.result?.runId, state.selection.revision, records.map(r => ({
    id: r.id, group: r.group, comparison: r.comparison, time: r.time, estimand: r.estimand, statistic: r.statistic,
    values: r.values, unit: r.unit, evidence: r.evidence, scopeSource: r.scopeSource,
  }))]);
}

export function isFinalReviewCurrent(state, records) {
  return Boolean(state.review && canReviewSummary(state)
    && state.review.snapshot === finalReviewSnapshot(state, records));
}

const fields = new Set([
  'estimate', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper', 'events', 'n',
  'unit', 'group', 'time', 'estimand', 'statistic', 'outcome', 'comparison',
]);
const prompt = '对照原文复核已汇总的临床试验结果，逐条检查数值、单位、结局/分域、组别、时点、估计口径和统计量。'
  + '数值必须属于该结果的原文行列。SD、SE、CI 和 IQR 不互换，单位为量表分数时规范单位可为 NA。'
  + '仅指出有原文支持的明确问题，不修改任何数值，也不评审其他结局。每条都返回，未发现明确问题时 findings 为空。'
  + '格式：{"reviews":[{"recordId":"输入的标识","findings":[{"field":"问题字段","reason":"简明说明","source":{"block":"原文标识","quote":"逐字原文","row":1,"column":1}}]}]}。'
  + '没有支持问题的可定位原文时不生成该发现。';

export async function reviewFinalRecords({ materials, records, llm, study, progress }) {
  const batches = [];
  for (let i = 0; i < records.length; i += 4) batches.push(records.slice(i, i + 4));
  const knownBlocks = new Map(materials.blocks.map(block => [block.id, block]));
  const findings = [], errors = [];
  let checked = 0;
  for (const [index, batch] of batches.entries()) {
    const input = [], blocks = new Map(), sourcesByRecord = new Map();
    for (const record of batch) {
      const sources = [record.scopeSource, ...Object.values(record.evidence ?? {}), record.unit?.source]
        .filter(source => source?.blockId && knownBlocks.has(source.blockId));
      if (!sources.length) continue;
      sourcesByRecord.set(record.id, new Set(sources.map(source => source.blockId)));
      for (const source of sources) blocks.set(source.blockId, knownBlocks.get(source.blockId));
      input.push({ recordId:record.id, outcome:record.outcome, instrument:record.instrument, domain:record.domain,
        group:record.group, comparison:record.comparison, time:record.time, estimand:record.estimand,
        statistic:record.statistic, values:record.values, unit:record.unit?.canonical ?? record.unit?.raw,
        scopeSource:record.scopeSource, evidence:record.evidence, unitSource:record.unit?.source,
      });
    }
    if (input.length) {
      try {
        const blockText = [...blocks.values()].map(block => renderBlock(block, 5000)).join('\n\n');
        const result = await llm.invoke({
          system:prompt, user:'本批已汇总记录：' + JSON.stringify(input) + '\n\n原文：\n' + blockText,
          temperature:0, tag:'workflow-final-review:' + study + ':' + (index + 1),
        });
        if (!Array.isArray(result.json?.reviews)) throw Error('最终复核未返回 reviews 数组');
        for (const record of input) {
          const entries = result.json.reviews.filter(item => item?.recordId === record.recordId);
          if (entries.length !== 1 || !Array.isArray(entries[0].findings)) continue;
          let complete = true;
          for (const finding of entries[0].findings) {
            const field = finding?.field;
            const reason = typeof finding?.reason === 'string' ? finding.reason.trim() : '';
            const source = groundSource({ blocks:[...blocks.values()] }, finding?.source);
            if (!fields.has(field) || !reason || !source || !sourcesByRecord.get(record.recordId).has(source.blockId)) {
              complete = false;
              continue;
            }
            findings.push({ recordId:record.recordId, field, reason, source });
          }
          if (complete) checked++;
        }
      } catch (error) {
        errors.push('第 ' + (index + 1) + ' 批：' + error.message);
      }
    }
    progress?.(index + 1, batches.length);
  }
  return { checked, unchecked:records.length - checked, findings, errors };
}
