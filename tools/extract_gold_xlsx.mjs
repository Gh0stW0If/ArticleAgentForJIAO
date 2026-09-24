// tools/extract_gold_xlsx.mjs
// Dependency-free reader for the .xlsx gold-standard tables in Datas/label/.
// Dumps: node --experimental-strip-types not required; plain node >=14.
// Usage: node tools/extract_gold_xlsx.mjs
//
// READ-ONLY with respect to Datas/: nothing is ever written back into Datas/.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(process.cwd());
const LABEL_DIR = join(ROOT, 'Datas', 'label');
const OUT_DIR = join(ROOT, 'build', 'gold_inspect');
mkdirSync(OUT_DIR, { recursive: true });

/* ----------------------------- minimal ZIP reader ---------------------------- */

function readZipEntries(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found: not a zip/xlsx');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory at ' + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const { localOff } = entry;
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error('unsupported compression method ' + entry.method);
}

/* ------------------------------ minimal XML reader --------------------------- */

function xmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseXml(text) {
  const root = { tag: null, attrs: {}, children: [], text: '' };
  const stack = [root];
  // Attribute values can never legally contain a bare '>' in XML, so [^>]* is safe
  // and avoids the classic "attributes are optional" backtracking trap.
  const re = /<([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const between = text.slice(last, m.index);
    if (between) stack[stack.length - 1].text += xmlUnescape(between);
    last = re.lastIndex;

    const content = m[1];
    if (content.startsWith('!') || content.startsWith('?')) continue; // decl/comment/doctype

    if (content.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClose = content.endsWith('/');
    const body = selfClose ? content.slice(0, -1) : content;

    const nm = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!nm) continue;
    const tag = nm[1];

    const attrs = {};
    const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(body)) !== null) attrs[a[1]] = xmlUnescape(a[2]);

    const node = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findAll(node, tag, out = []) {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

function firstChild(node, tag) {
  return node.children.find((c) => c.tag === tag) ?? null;
}

/* -------------------------------- sheet reading ------------------------------ */

function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheetRows(sheetXml, sharedStrings) {
  const doc = parseXml(sheetXml);
  const rows = [];
  for (const rowEl of findAll(doc, 'row')) {
    const cells = [];
    for (const c of findAll(rowEl, 'c')) {
      const idx = colToIndex(c.attrs.r ?? 'A');
      const t = c.attrs.t;
      let value = '';

      if (t === 'inlineStr') {
        value = findAll(c, 't').map((x) => x.text).join('');
      } else {
        const v = firstChild(c, 'v');
        if (v) {
          value = v.text;
          if (t === 's') {
            const si = Number(value);
            value = sharedStrings[si] ?? '';
          }
        }
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function readSharedStrings(xmlText) {
  if (!xmlText) return [];
  const doc = parseXml(xmlText);
  return findAll(doc, 'si').map((si) => findAll(si, 't').map((x) => x.text).join(''));
}

function gridToText(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').replace(/\s+/g, ' ').trim()));
  const lines = norm.map((r, i) => `R${String(i + 1).padStart(3, '0')} | ` + r.map((v) => v.replace(/\|/g, '\\|')).join(' | '));
  return `cols=${width} rows=${norm.length}\n` + lines.join('\n');
}

/* ----------------------------------- main ----------------------------------- */

function readWorkbook(path) {
  const buf = readFileSync(path);
  const entries = readZipEntries(buf);
  const get = (name) => (entries.has(name) ? readEntry(buf, entries.get(name)) : null);

  const workbookXml = get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) throw new Error('no xl/workbook.xml (not an xlsx?)');
  const sharedXml = get('xl/sharedStrings.xml')?.toString('utf8') ?? null;
  const sharedStrings = readSharedStrings(sharedXml);

  // sheet name -> r:id
  const wb = parseXml(workbookXml);
  const sheetEls = findAll(wb, 'sheet');
  const relsXml = get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const rels = {};
  for (const r of findAll(parseXml(relsXml), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;

  const sheets = [];
  for (const s of sheetEls) {
    const rid = s.attrs['r:id'] ?? s.attrs['id'];
    let target = rels[rid] ?? '';
    if (target.startsWith('/')) target = target.slice(1);
    else target = 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target)?.toString('utf8');
    sheets.push({ name: s.attrs.name ?? basename(target), target, xml });
  }
  return { sheets, sharedStrings, sharedCount: sharedStrings.length };
}

const summary = [];
const files = readdirSync(LABEL_DIR).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'));

for (const file of files) {
  const full = join(LABEL_DIR, file);
  const report = { file, bytes: statSync(full).size, sheets: [] };
  try {
    const { sheets, sharedStrings, sharedCount } = readWorkbook(full);
    report.sharedStrings = sharedCount;
    const textParts = [`FILE: ${file}`, `size: ${report.bytes} bytes`, `sharedStrings: ${sharedCount}`, ''];

    for (const sh of sheets) {
      const rows = sh.xml ? readSheetRows(sh.xml, sharedStrings) : [];
      const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
      report.sheets.push({ name: sh.name, rows: rows.length, cols: width });
      textParts.push(`=== SHEET: ${sh.name} (rows=${rows.length} cols=${width}) ===`);
      textParts.push(gridToText(rows));
      textParts.push('');
    }
    const out = join(OUT_DIR, file.replace(/\.xlsx$/i, '') + '.txt');
    writeFileSync(out, textParts.join('\n'), 'utf8');
    report.dump = out;
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }
  summary.push(report);
}

writeFileSync(join(OUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
