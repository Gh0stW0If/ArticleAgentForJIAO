import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const number = '[−–+-]?\\d+(?:\\.\\d+)?';
const nativeTuple = new RegExp(`(${number})\\s*±\\s*(${number})`, 'g');
const parsedTuple = new RegExp(`^\\s*([|Il]?${number})\\s*(?:±|\\+\\s*/\\s*-)\\s*([|Il]?\\s*${number})\\s*$`);
const pValue = /^\s*[<>]?\s*\d+(?:\.\d+)?\s*$/;
const norm = value => value.toLowerCase().replace(/[−–—]/g, '-').replace(/\s+/g, '');
const tableNumber = text => /^\s*Table\s+(\d+[a-z]?)\s*[.:]/i.exec(text)?.[1]?.toLowerCase();
const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function plausibleDigitLoss(oldValue, realValue) {
  const a = norm(oldValue);
  const b = norm(realValue);
  if (a.replace(/^[|il]/, '1') === b && /^[|il]/.test(a)) return true;
  return b.length === a.length + 1 && [...b].some((digit, index) => /\d/.test(digit) && b.slice(0, index) + b.slice(index + 1) === a);
}

/** Verify pair rows against the native PDF text on the same page and named table. */
export function verifyNativeTableRows(doc, pageText) {
  const repairs = [];
  const unresolved = [];
  const blocks = doc.blocks.map(block => {
    const table = block.table;
    const id = tableNumber(table?.caption ?? '');
    if (block.dropped || !table?.grid || !id || !pageText.has(block.page)) return block;
    let active = false;
    const lines = pageText.get(block.page).split(/\r?\n/).flatMap(line => {
      const heading = tableNumber(line);
      if (heading) active = heading === id;
      if (!active || heading) return [];
      const tuples = [...line.matchAll(nativeTuple)];
      if (tuples.length !== 2) return [];
      const tail = line.slice(tuples[1].index + tuples[1][0].length).trim();
      if (!pValue.test(tail)) return [];
      return [{
        label: line.slice(0, tuples[0].index).trim(), p: tail,
        pairs: tuples.map(match => ({ raw: match[0], parts: [match[1], match[2]] })),
      }];
    });
    let html = table.html;
    let text = block.text;
    const grid = table.grid.map((row, rowIndex) => {
      if (row.length !== 4 || !row[0] || !pValue.test(row[3])) return row;
      const old = [parsedTuple.exec(row[1]), parsedTuple.exec(row[2])];
      if (old.some(pair => !pair)) return row;
      const candidates = lines.filter(line => norm(line.label) === norm(row[0]) && norm(line.p) === norm(row[3]));
      if (!candidates.length) {
        if (old.some(pair => /^[|Il]/.test(pair[1]) || /^[|Il]/.test(pair[2]))) {
          unresolved.push({ page: block.page, blockId: `b${block.index}`, row: rowIndex + 1, reason: '无法与原生 PDF 唯一对齐的疑似 OCR 数字' });
        }
        return row;
      }
      const changed = candidates.flatMap(line => {
        const diff = [];
        line.pairs.forEach((pair, side) => pair.parts.forEach((part, field) => {
          if (norm(part) !== norm(old[side][field + 1])) diff.push({ side, field, pair, part });
        }));
        return diff.length === 1 && plausibleDigitLoss(old[diff[0].side][diff[0].field + 1], diff[0].part) ? diff : [];
      });
      if (candidates.length !== 1 || changed.length !== 1) {
        if (changed.length || candidates.length === 1 && old.some(pair => /^[|Il]/.test(pair[1]) || /^[|Il]/.test(pair[2]))) {
          unresolved.push({ page: block.page, blockId: `b${block.index}`, row: rowIndex + 1, reason: '原生 PDF 表行存在冲突，保留供人工核对' });
        }
        return row;
      }
      const [{ side, pair }] = changed;
      const column = side + 1;
      const before = row[column];
      const result = [...row];
      result[column] = pair.raw;
      const encoded = escapeHtml(before);
      if (html?.split(encoded).length === 2) html = html.replace(encoded, () => escapeHtml(pair.raw));
      if (text?.split(before).length === 2) text = text.replace(before, () => pair.raw);
      const heading = table.grid[0]?.[column];
      const evidence = {
        kind: 'table', page: block.page, bbox: null, blockId: `b${block.index}`, quote: pair.raw,
        tableCell: { row: rowIndex + 1, column: column + 1, ...(heading ? { heading } : {}) },
      };
      repairs.push({ before, after: pair.raw, evidence, estimate: pair.parts[0], sd: pair.parts[1] });
      return result;
    });
    return { ...block, text, table: { ...table, html, grid } };
  });
  return { doc: repairs.length ? { ...doc, blocks } : doc, repairs, unresolved };
}

export function readNativeTables(root, year, articleId, doc) {
  const pages = [...new Set(doc.blocks.filter(block => block.table?.grid?.some(row =>
    row.length === 4 && [row[1], row[2]].every(part => parsedTuple.test(part)) && pValue.test(row[3])
  ) && tableNumber(block.table.caption ?? '')).map(block => block.page))];
  if (!pages.length) return { doc, repairs: [], unresolved: [] };
  const directory = join(root, 'Datas', 'articles', year);
  const matches = existsSync(directory) ? readdirSync(directory).filter(name => name.replace(/^-+/, '').replace(/\.pdf$/i, '') === articleId && /\.pdf$/i.test(name)) : [];
  if (matches.length !== 1) return { doc, repairs: [], unresolved: [{ reason: '无法唯一定位正文 PDF，请核对原表' }] };
  try {
    const first = Math.min(...pages);
    const last = Math.max(...pages);
    const text = execFileSync('pdftotext', ['-f', String(first), '-l', String(last), '-layout', '-enc', 'UTF-8', join(directory, matches[0]), '-'],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const nativePages = text.split('\f');
    return verifyNativeTableRows(doc, new Map(pages.map(page => [page, nativePages[page - first] ?? ''])));
  } catch (error) {
    return { doc, repairs: [], unresolved: [{ reason: `原生 PDF 表格核对失败（${error.code ?? 'READ_ERROR'}），请核对原表` }] };
  }
}

export function applyNativeTableRepairs(row, repairs) {
  const agrees = (left, right) => left.blockId === right.blockId
    && left.page === right.page && left.tableCell?.row === right.tableCell.row && left.tableCell?.column === right.tableCell.column;
  let updated = 0;
  for (const timepoint of Object.values(row.timepoints ?? {})) {
    if (timepoint.continuous?.varianceType?.code !== '3') continue;
    for (const side of ['experimental', 'control']) {
      const group = timepoint.continuous[side];
      const estimate = group?.estimate;
      if (!estimate) continue;
      const repair = repairs.find(item => estimate.evidence?.some(source => agrees(source, item.evidence)));
      if (!repair) continue;
      // Replace a pair as a unit to retain the original PDF anchor on each value.
      const field = raw => ({ raw, evidence: [repair.evidence], provenance: 'deterministic', confidence: 1 });
      group.estimate = field(repair.estimate);
      group.ciLower = field(repair.sd);
      updated++;
    }
  }
  return updated;
}
