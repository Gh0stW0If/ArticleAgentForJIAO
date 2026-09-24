// tools/xlsx_schema.mjs — print aligned, per-column schema of every sheet.
// Usage: node tools/xlsx_schema.mjs <xlsx>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const path = resolve(process.argv[2]);
const OUT_DIR = join(resolve(process.cwd()), 'build', 'gold_inspect');
mkdirSync(OUT_DIR, { recursive: true });

/* zip */
const buf = readFileSync(path);
const eocdSig = 0x06054b50;
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
  if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
}
const cnt = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const entries = new Map();
for (let i = 0; i < cnt; i++) {
  const method = buf.readUInt16LE(off + 10);
  const compSize = buf.readUInt32LE(off + 20);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, localOff });
  off += 46 + nameLen + extraLen + commentLen;
}
function get(n) {
  const e = entries.get(n);
  if (!e) return null;
  const nl = buf.readUInt16LE(e.localOff + 26), el = buf.readUInt16LE(e.localOff + 28);
  const s = e.localOff + 30 + nl + el;
  const raw = buf.subarray(s, s + e.compSize);
  return e.method === 0 ? raw : inflateRawSync(raw);
}

/* xml */
const unesc = (s) => s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function parseXml(text) {
  const root = { tag: null, attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<([^>]*)>/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    const b = text.slice(last, m.index);
    if (b) stack[stack.length - 1].text += unesc(b);
    last = re.lastIndex;
    const c = m[1];
    if (c.startsWith('!') || c.startsWith('?')) continue;
    if (c.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
    const sc = c.endsWith('/');
    const body = sc ? c.slice(0, -1) : c;
    const nm = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!nm) continue;
    const attrs = {};
    const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(body)) !== null) attrs[a[1]] = unesc(a[2]);
    const node = { tag: nm[1], attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!sc) stack.push(node);
  }
  return root;
}
const findAll = (n, t, o = []) => { for (const c of n.children) { if (c.tag === t) o.push(c); findAll(c, t, o); } return o; };

const workbookXml = get('xl/workbook.xml').toString('utf8');
const ssXml = get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
const sst = findAll(parseXml(ssXml), 'si').map((si) => findAll(si, 't').map((x) => x.text).join(''));
const rels = {};
for (const r of findAll(parseXml(get('xl/_rels/workbook.xml.rels').toString('utf8')), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;

const colIdx = (ref) => { const L = ref.match(/^[A-Z]+/)[0]; let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const colName = (i) => { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

const out = [];
for (const sh of findAll(parseXml(workbookXml), 'sheet')) {
  let t = rels[sh.attrs['r:id']];
  t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  const doc = parseXml(get(t).toString('utf8'));
  const rows = [];
  for (const rowEl of findAll(doc, 'row')) {
    const cells = [];
    for (const c of findAll(rowEl, 'c')) {
      const i = colIdx(c.attrs.r ?? 'A');
      let v = '';
      if (c.attrs.t === 'inlineStr') v = findAll(c, 't').map((x) => x.text).join('');
      else { const vv = c.children.find((x) => x.tag === 'v'); if (vv) { v = vv.text; if (c.attrs.t === 's') v = sst[+v] ?? ''; } }
      cells[i] = v;
    }
    rows.push({ r: +rowEl.attrs.r, cells });
  }
  const width = rows.reduce((w, r) => Math.max(w, r.cells.length), 0);

  const headerRow = Math.max(...rows.map((r) => r.r));
  out.push(`\n################ SHEET: ${sh.attrs.name}  (rows=${rows.length}, width=${width}) ################`);
  for (const { r, cells } of rows) {
    const filled = cells.filter((x) => x && String(x).trim()).length;
    out.push(`\n----- row ${r}  (non-empty cells: ${filled}) -----`);
    for (let i = 0; i < width; i++) {
      const v = cells[i];
      if (v === undefined || String(v).trim() === '') continue;
      const s = String(v).replace(/\r?\n/g, ' ⏎ ');
      out.push(`  ${colName(i).padStart(3)} [${String(i).padStart(3)}]  ${s.length > 220 ? s.slice(0, 220) + '…' : s}`);
    }
  }
}
const o = join(OUT_DIR, 'SCHEMA_' + path.split(/[\\/]/).pop().replace(/\.xlsx$/i, '') + '.txt');
writeFileSync(o, out.join('\n'), 'utf8');
console.log('written:', o, 'chars:', out.join('\n').length);
