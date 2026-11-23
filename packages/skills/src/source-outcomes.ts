import type { Evidence, FieldValue, MiniDoc, MiniDocBlock, OutcomeBinary, OutcomeLevel, OutcomeTimepoint } from '@aa/core';
import type { PlannedOutcome } from './outcome-plan.ts';
import type { StudyPlanPayload } from './study-plan.ts';
import type { DifferenceFields } from './timepoints.ts';

type Scope = NonNullable<OutcomeLevel['comparisonScope']>;
const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function comparisonScope(studyId: string, index: number, plan?: StudyPlanPayload): Scope | undefined {
  if (!plan) return undefined;
  const pair = plan.comparisons[index];
  if (!pair?.intervention?.raw || !pair.control?.raw) return undefined;
  const arm = (text: string, role: string) => {
    const names = plan.groups
      .filter(group => !group.role?.raw || group.role.raw.toLowerCase() === role)
      .map(group => group.label?.raw ?? '')
      .filter(label => {
        const id = label.replace(/\s+group$/i, '');
        const tokens: readonly string[] = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        return Boolean(id && (key(text).includes(key(label)) || (/^[A-Z]{2,6}$/.test(id) && tokens.includes(id.toLowerCase()))));
      })
      .sort((a, b) => b.length - a.length);
    const label = names[0];
    return { id: `${studyId}:arm:${key(label ?? text).slice(0, 80)}`, text: label ? `${label} — ${text}` : text };
  };
  const experimental = arm(pair.intervention.raw, 'experimental');
  const control = arm(pair.control.raw, 'control');
  return {
    id: `${studyId}:comparison:${index + 1}`,
    interventionId: experimental.id,
    controlId: control.id,
    intervention: experimental.text,
    control: control.text,
  };
}

function value(raw: string, evidence: Evidence, code?: string): FieldValue {
  return { raw, evidence: [evidence], provenance: 'deterministic', confidence: 1, ...(code ? { code } : {}) };
}

function cell(block: MiniDocBlock, row: number, column: number): Evidence {
  const grid = block.table!.grid!;
  return {
    kind: 'table', blockId: `b${block.index}`, page: block.page, bbox: block.bbox,
    quote: grid[row]![column]!, tableCell: { row: row + 1, column: column + 1, heading: grid[0]?.[column] ?? '' },
  };
}

const eventPair = /^\s*(\d+)\s*\/\s*(\d+)(?:\s*[（(]\s*[\d.]+\s*%?\s*[）)])?\s*%?(?:\s+[*†‡#A-Z]+)*\s*$/;
const frequency = /(?<![\d/.])(\d+(?:\s*\/\s*\d+)?)\s*(?:hz\b|(?=\s+group\b))/i;
function armColumn(headers: readonly string[], description: string, control = false): number | undefined {
  const normalized = key(description);
  const freq = frequency.exec(description)?.[1]?.replace(/\s/g, '');
  const matching = headers.flatMap((header, i) => {
    if (!i || /(?:difference|p[\s-]*value|total pooled)/i.test(header)) return [];
    const label = header.replace(/\s*[（(]n\s*=.*$/i, '').trim();
    const columnFrequency = frequency.exec(label)?.[1]?.replace(/\s/g, '');
    const sharedControl = control && /^(?:usual care|control)(?: group)?$/i.test(label)
      && /\b(?:control|usual care)\b/i.test(description);
    const matches = freq ? columnFrequency === freq && normalized.includes(key(label.replace(/\s+group$/i, '').split(/[\s-]/)[0]!))
      : (!columnFrequency && key(label).length >= 3 && normalized.includes(key(label))) || sharedControl;
    return matches ? [i] : [];
  });
  return matching.length === 1 ? matching[0] : undefined;
}

/** Explicit n/N cells override model inference only when one outcome row and both arm columns match. */
export function sourceEventPair(doc: MiniDoc, name: string, scope: Scope): OutcomeBinary | undefined {
  const outcome = key(name.replace(/\s*(?:\(%\)|%)$/, ''));
  if (!outcome) return undefined;
  const candidates: OutcomeBinary[] = [];
  for (const block of doc.blocks) {
    const grid = block.table?.grid;
    const head = grid?.[0];
    if (!grid || !head) continue;
    const experimental = armColumn(head, scope.intervention);
    const control = armColumn(head, scope.control, true);
    if (experimental === undefined || control === undefined || experimental === control) continue;
    grid.forEach((row, i) => {
      if (i === 0 || key((row[0] ?? '').replace(/\s*(?:\(%\)|%)$/, '')) !== outcome) return;
      const a = eventPair.exec(row[experimental] ?? '');
      const b = eventPair.exec(row[control] ?? '');
      if (!a || !b || ![a, b].every(match => Number(match[2]) > 0 && Number(match[1]) <= Number(match[2]))) return;
      const field = (match: RegExpExecArray, column: number) => ({
        events: value(match[1]!, cell(block, i, column)), n: value(match[2]!, cell(block, i, column)),
      });
      candidates.push({ experimental: field(a, experimental), control: field(b, control) });
    });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

const number = '[−–+-]?\\d+(?:\\.\\d+)?';
const tuple = new RegExp(`^\\s*(${number})\\s*\\(\\s*(${number})\\s*(?:to|[–—,]|\\s+-\\s+)\\s*(${number})\\s*\\)\\s*[*†‡]?\\s*$`, 'i');
const window = /^(?:weeks?)\s+(\d+)\s*[-–—]\s*(\d+)/i;
export interface DeclaredChange {
  planned: PlannedOutcome;
  timepoints: NonNullable<OutcomeLevel['timepoints']>;
  groupLabels: readonly [string, string];
  acronym: string;
}

/** Finds a primary change outcome with an explicit week window and uniquely matching CI table. */
export function declaredPrimaryChange(doc: MiniDoc): DeclaredChange | undefined {
  const declarations = doc.blocks.flatMap(block => {
    if (block.type !== 'text' || (block.page !== 1 && !['abstract', 'methods'].includes(block.section))) return [];
    const text = block.text.replace(/(\p{L})-\s*\n\s*(?=\p{L})/gu, '$1').replace(/\s+/g, ' ');
    const match = /\b(?:the\s+)?primary\s+(?:outcome|end\s*point|measure)\s+(?:was|is)\s+(the change from baseline in [^.!?]{5,170}?)\s+during\s+weeks?\s+(\d+)\s*(?:to|[-–—])\s*(\d+)\b/i.exec(text);
    if (!match) return [];
    // The declared abbreviation must also appear in the result heading.
    const subject = match[1]!.replace(/^the change from baseline in\s+/i, '');
    const acronym = /\(([A-Z][A-Z0-9]+s?)\)/.exec(subject)?.[1];
    return acronym ? [{ block, quote: match[0], name: match[1]!, acronym, first: Number(match[2]), last: Number(match[3]) }] : [];
  });
  if (!declarations.length) return undefined;
  const candidates: DeclaredChange[] = [];
  for (const block of doc.blocks) {
    const grid = block.table?.grid;
    if (!grid?.length || grid[0]?.length !== 5) continue;
    const headers = grid[0];
    const diffLabel = headers[3] ?? '';
    if (!/\bbetween[- ]group difference\b/i.test(diffLabel) || !/\b95\s*%\s*(?:ci|cl|confidence interval)\b/i.test(diffLabel)) continue;
    const groupLabels = [headers[1]!, headers[2]!] as const;
    if (!groupLabels.every(label => /\bn\s*=\s*\d+/i.test(label))) continue;
    const declaration = declarations.find(item => grid.some(r =>
      /^change from baseline/i.test(r[0] ?? '') && new RegExp(`\\b${item.acronym}\\b`, 'i').test(r[0] ?? '')));
    if (!declaration) continue;
    const titleRow = grid.findIndex(r => /^change from baseline/i.test(r[0] ?? '')
      && new RegExp(`\\b${declaration.acronym}\\b`, 'i').test(r[0] ?? ''));
    const timepoints: DeclaredChange['timepoints'] = {};
    for (let i = titleRow + 1; i < grid.length; i++) {
      const r = grid[i]!;
      const span = window.exec(r[0] ?? '');
      if (!span) break;
      const start = Number(span[1]);
      const end = Number(span[2]);
      const at = start === declaration.first && end === declaration.last ? 'endOfTreatment'
        : start === declaration.last + 1 && end >= start ? 'followUpEnd' : undefined;
      const matches = [1, 2, 3].map(col => tuple.exec(r[col] ?? ''));
      if (!at || matches.some(match => !match)) continue;
      const heading = cell(block, titleRow, 0);
      const field = (col: number, part: number) => value(matches[col - 1]![part]!, cell(block, i, col));
      const group = (col: number) => ({
        estimate: field(col, 1), ciLower: field(col, 2), ciUpper: field(col, 3),
      });
      const difference: DifferenceFields = {
        differenceEstimate: field(3, 1), differenceCiLower: field(3, 2), differenceCiUpper: field(3, 3),
      };
      const result: OutcomeTimepoint = {
        continuous: {
          estimateType: value('change from baseline', heading, '3'),
          varianceType: value('95% CI', heading, '2'),
          experimental: group(1), control: group(2),
        },
        binary: difference as OutcomeBinary,
      };
      timepoints[at] = result;
    }
    if (!timepoints.endOfTreatment) continue;
    const evidence: Evidence = {
      kind: 'text', page: declaration.block.page, bbox: declaration.block.bbox,
      blockId: `b${declaration.block.index}`, quote: declaration.block.text,
    };
    const marker = value(declaration.quote, evidence);
    candidates.push({ planned: { name: value(declaration.name, evidence), anchor: marker }, timepoints, groupLabels, acronym: declaration.acronym });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function matchesDeclaredChange(change: DeclaredChange, label: string): boolean {
  const name = change.planned.name?.raw ?? '';
  if (sameOutcomeLabel(label, name) || sameOutcomeLabel(label, name.replace(/\s*\([^)]+\)$/, ''))) return true;
  const outcome = new RegExp(`\\b${change.acronym}\\b`, 'i').test(label);
  return outcome && /\bmean\b/i.test(label) && /\b(?:weekly|per week)\b/i.test(label)
    && !/\b(?:rate|percentage|proportion|participants|at least|number of participants)\b|[≥%]/i.test(label);
}

export function sameOutcomeLabel(left: string, right: string): boolean {
  return Boolean(key(left) && key(left) === key(right));
}
