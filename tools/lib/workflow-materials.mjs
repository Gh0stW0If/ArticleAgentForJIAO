import fs from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ingest } from '../../packages/ingest/dist/index.js';
import { fingerprint, atomicJson, studyDirectory } from './workflow-store.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pdfLibrary;
async function pdfjs() {
  if (!pdfLibrary) {
    const require = createRequire(import.meta.url);
    const path = require.resolve('pdfjs-dist/legacy/build/pdf.mjs', {
      paths: [join(appRoot, 'tools', 'nodepdf'), join(appRoot, 'apps', 'web')],
    });
    pdfLibrary = await import(pathToFileURL(path).href);
  }
  return pdfLibrary;
}
export function findSources(root, year, study) {
  const files = [];
  const escaped = study.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const directory of [join(root, 'Datas', 'articles', year), join(root, 'build', 'imports', year)]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const clean = name.replace(/^-+/, '');
      if (clean === study + '.pdf' || new RegExp('^' + escaped + '-\\d+\\.pdf$', 'i').test(clean)) {
        const path = join(directory, name);
        files.push({
          id: fingerprint(relative(root, path)).slice(0, 16), path: relative(root, path),
          name, attachment: clean !== study + '.pdf', fingerprint: fingerprint(fs.readFileSync(path)),
        });
      }
    }
  }
  if (files.filter(f => !f.attachment).length !== 1) throw new Error('无法唯一定位正文 PDF');
  return files.sort((a, b) => Number(a.attachment) - Number(b.attachment) || a.name.localeCompare(b.name));
}
function linesOf(items, height) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const x = item.transform[4], y = height - item.transform[5];
    let line = lines.find(v => Math.abs(v.y - y) < 3);
    if (!line) { line = { y, chunks: [] }; lines.push(line); }
    line.chunks.push({ x, y, text: item.str, width: item.width, height: item.height || 10 });
  }
  return lines.sort((a, b) => a.y - b.y).map(line => {
    const chunks = line.chunks.sort((a, b) => a.x - b.x);
    return {
      text: chunks.map(v => v.text).join(' '),
      bbox: [Math.min(...chunks.map(v => v.x)), Math.min(...chunks.map(v => v.y - v.height)),
        Math.max(...chunks.map(v => v.x + v.width)), Math.max(...chunks.map(v => v.y + 3))],
    };
  });
}
export async function readWorkflowMaterials(root, year, study) {
  const sources = findSources(root, year, study);
  const warnings = [];
  let parsed;
  try { parsed = ingest({ rootDir: root, year, studyId: study }).doc; }
  catch { warnings.push('尚无 MinerU 缓存，使用 PDF 原生文字；扫描页可点解析'); }
  // A new OCR/table parse of an unchanged PDF must invalidate the material cache too.
  const version = fingerprint({ sources: sources.map(s => [s.id, s.fingerprint]), parsed: parsed ? fingerprint(parsed.blocks) : null, parser: 4 });
  const cachePath = join(studyDirectory(root, year, study), 'materials-' + version.slice(0, 16) + '.json');
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const blocks = [];
  const main = sources.find(s => !s.attachment);
  if (parsed) {
    for (const b of parsed.blocks.filter(b => !b.dropped && b.section !== 'references')) {
      blocks.push({
        id: 'mineru:' + b.index, documentId: main.id, page: b.page, bbox: b.bbox, type: b.type, section: b.section,
        text: b.text, caption: b.table?.caption ?? '', grid: b.table?.grid ?? null,
      });
    }
  }
  for (const source of sources) {
    try {
      const library = await pdfjs();
      const loadingTask = library.getDocument({ data: new Uint8Array(fs.readFileSync(join(root, source.path))),
        useSystemFonts: true, isEvalSupported: false });
      const pdf = await loadingTask.promise;
      source.pages = pdf.numPages;
      source.nativeTextPages = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        const pdfPage = await pdf.getPage(page);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const { items } = await pdfPage.getTextContent();
        const lines = linesOf(items, viewport.height);
        if (!lines.length) { warnings.push(source.name + ' 第 ' + page + ' 页无可读文字，需解析'); continue; }
        source.nativeTextPages.push(page);
        // Whole-page text preserves table headings, native digits and attachment identity.
        blocks.push({
          id: 'pdf:' + source.id + ':' + page, documentId: source.id, page, bbox: null,
          type: 'native', section: source.attachment ? 'supplementary' : 'unknown',
          text: lines.map(line => line.text).join('\n'), lines,
        });
        pdfPage.cleanup();
      }
      await loadingTask.destroy();
    } catch (error) {
      warnings.push(source.name + ' 原生文字读取失败：' + error.message);
    }
  }
  if (!blocks.length) throw new Error('没有可读材料，请先解析 PDF');
  const result = { fingerprint: version, sources, blocks, warnings };
  atomicJson(cachePath, result);
  return result;
}
export function renderBlock(block, limit = 7000) {
  return '[[' + block.id + ']] 文档=' + block.documentId + ' 页=' + block.page
    + (block.caption ? ' ' + block.caption : '') + '\n'
    + (block.grid ? block.grid.map((row, i) => (i + 1) + ' | ' + row.join(' | ')).join('\n') : block.text).slice(0, limit);
}
export function numericSourceTokens(value) {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/(?<=\d)\s*[-–—]\s*(?=[+−-]?(?:\d|\.\d))/g, ' ')
    .replace(/[−–]/g, '-')
    .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, token => token.replace(/,/g, ''))
    .replace(/,/g, ' ');
  return text.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g)?.map(Number) ?? [];
}
export function groundSource(materials, source, raw) {
  if (!source || typeof source !== 'object') return null;
  const block = materials.blocks.find(b => b.id === String(source.block).trim().replace(/^\[\[([\s\S]*)\]\]$/, '$1'));
  if (!block || !String(source.quote ?? '').trim()) return null;
  const norm = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').replace(/[−–]/g, '-').replace(/\s*([±=():,%|])\s*/g, '$1').trim();
  const quote = String(source.quote).trim();
  let content = block.text + '\n' + (block.caption ?? '') + '\n' + (block.grid?.flat().join('\n') ?? '');
  let bbox = block.bbox;
  const row = Number(source.row), column = Number(source.column);
  if (Number.isSafeInteger(row) && Number.isSafeInteger(column) && block.grid) {
    content = block.grid[row - 1]?.[column - 1] ?? '';
  }
  let evidenceQuote = quote;
  if (!norm(content).includes(norm(quote))) {
    if (raw !== undefined) return null;
    const referencedRows = quote.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const validated = [];
    for (const line of referencedRows) {
      const match = /^(\d+)\s*\|\s*(.*)$/.exec(line);
      if (match && block.grid) {
        const actual = block.grid[Number(match[1]) - 1];
        if (!actual || norm(actual.join(' | ')) !== norm(match[2])) return null;
        validated.push(actual.join('\t'));
      } else {
        if (!norm(block.caption ?? '').includes(norm(line)) && !norm(block.text).includes(norm(line))) return null;
        validated.push(line);
      }
    }
    if (!validated.length) return null;
    evidenceQuote = validated.join('\n');
  }
  if (raw !== undefined && raw !== '' && !numericSourceTokens(quote).includes(Number(String(raw).replace(/[−–]/g, '-')))) return null;
  const line = block.lines?.find(line => norm(line.text).includes(norm(quote)));
  if (line) bbox = line.bbox;
  return {
    documentId: block.documentId, page: block.page, bbox, quote: evidenceQuote,
    blockId: block.id, ...(block.grid && row && column ? { row, column } : {}),
  };
}
