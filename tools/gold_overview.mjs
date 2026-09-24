// tools/gold_overview.mjs — study-ID grammar + where fields live, across all years.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(process.cwd());
const LABEL = join(ROOT, 'Datas', 'label');
const OUT = join(ROOT, 'build', 'gold_inspect');
mkdirSync(OUT, { recursive: true });

/* ---------------- zip ---------------- */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const cnt = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const m = new Map();
  for (let i = 0; i < cnt; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    m.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return m;
}
function entryData(buf, e) {
  const nl = buf.readUInt16LE(e.localOff + 26), el = buf.readUInt16LE(e.localOff + 28);
  const s = e.localOff + 30 + nl + el;
  const raw = buf.subarray(s, s + e.compSize);
  return e.method === 0 ? raw : inflateRawSync(raw);
}

/* ---------------- xml ---------------- */
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
const colIdx = (ref) => { const L = (ref.match(/^[A-Z]+/) ?? ['A'])[0]; let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readWorkbook(path) {
  const buf = readFileSync(path);
  const ents = zipEntries(buf);
  const wbXml = entryData(buf, ents.get('xl/workbook.xml')).toString('utf8');
  const ssE = ents.get('xl/sharedStrings.xml');
  const sst = ssE ? findAll(parseXml(entryData(buf, ssE).toString('utf8')), 'si').map((si) => findAll(si, 't').map((x) => x.text).join('')) : [];
  const rels = {};
  for (const r of findAll(parseXml(entryData(buf, ents.get('xl/_rels/workbook.xml.rels')).toString('utf8')), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;

  const sheets = [];
  for (const sh of findAll(parseXml(wbXml), 'sheet')) {
    let t = rels[sh.attrs['r:id']];
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    const doc = parseXml(entryData(buf, ents.get(t)).toString('utf8'));
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
    sheets.push({ name: sh.attrs.name, rows });
  }
  return sheets;
}

const files = readdirSync(LABEL).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$')).sort();
const lines = [];
const idGrammar = [];
const counts = {};

for (const f of files) {
  const year = (f.match(/^(\d{4})/) ?? [])[1] ?? '?';
  const sheets = readWorkbook(join(LABEL, f));
  const s1 = sheets[0], s2 = sheets[1], s3 = sheets[2];
  const ids1 = s1.rows.map((x) => x.cells[1]).filter((v) => v && /^\d{4}-/.test(String(v)));
  const ids2 = s2 ? s2.rows.map((x) => x.cells[1]).filter((v) => v && /^\d{4}-/.test(String(v))) : [];
  const ids3 = s3 ? s3.rows.map((x) => x.cells[1]).filter((v) => v && /^\d{4}-/.test(String(v))) : [];
  const papers2 = new Set(ids2.map((v) => String(v).replace(/-\d+$/, '')));
  const papers3 = new Set(ids3.map((v) => String(v).replace(/-\d+$/, '')));
  const cols1 = Math.max(...s1.rows.map((x) => x.cells.length));
  const cols3 = s3 ? Math.max(...s3.rows.map((x) => x.cells.length)) : 0;

  counts[year] = (counts[year] ?? 0) + new Set(ids1.map((v) => String(v).replace(/-\d+$/, ''))).size;

  lines.push(`\n${'='.repeat(96)}\nFILE ${f}`);
  lines.push(`  Sheet1 "${s1.name}" rows=${s1.rows.length} cols=${cols1}  studyRows=${ids1.length}`);
  lines.push(`  Sheet2 "${s2?.name}" rows=${s2?.rows.length} cols=${Math.max(...(s2?.rows ?? [{ cells: [] }]).map((x) => x.cells.length))}  studyRows=${ids2.length} distinctPapers=${papers2.size}`);
  lines.push(`  Sheet3 "${s3?.name}" rows=${s3?.rows.length} cols=${cols3}  outcomeRows=${ids3.length} distinctPapers=${papers3.size}`);
  lines.push(`  Sheet1 ids : ${ids1.join(', ')}`);
  lines.push(`  Sheet2 ids : ${ids2.join(', ')}`);
  const s3ids = [...new Set(ids3.map(String))];
  lines.push(`  Sheet3 ids (${s3ids.length} distinct): ${s3ids.slice(0, 60).join(', ')}${s3ids.length > 60 ? ' …' : ''}`);

  for (const id of s3ids) idGrammar.push({ year, id });
}

// classify ID shapes
const shapes = {};
for (const { id } of idGrammar) {
  const m = /^(\d{4})-(\d+)(?:-(\d+))?$/.exec(id);
  const shape = !m ? 'OTHER:' + id : (m[3] ? 'YYYY-NN-K (K=' + m[3].length + ' digits)' : 'YYYY-NN');
  shapes[shape] = (shapes[shape] ?? 0) + 1;
}

// study ids present in sheet1 vs sheet3 coverage
lines.push('\n' + '='.repeat(96));
lines.push('\nID SHAPES SEEN IN SHEET3 (outcome level):');
for (const [k, v] of Object.entries(shapes).sort((a, b) => b[1] - a[1])) lines.push(`  ${String(v).padStart(5)}  ${k}`);
lines.push('\nPAPERS PER YEAR (from Sheet1): ' + JSON.stringify(counts));
lines.push('TOTAL papers: ' + Object.values(counts).reduce((a, b) => a + b, 0));

writeFileSync(join(OUT, 'OVERVIEW.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
