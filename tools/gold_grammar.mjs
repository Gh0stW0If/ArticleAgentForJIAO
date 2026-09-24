// tools/gold_grammar.mjs — auto-detect ID columns, then report ID grammar per sheet/year.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(process.cwd());
const LABEL = join(ROOT, 'Datas', 'label');
const OUT = join(ROOT, 'build', 'gold_inspect');
mkdirSync(OUT, { recursive: true });

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const cnt = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  const m = new Map();
  for (let i = 0; i < cnt; i++) {
    const method = buf.readUInt16LE(off + 10), compSize = buf.readUInt32LE(off + 20), nameLen = buf.readUInt16LE(off + 28),
      extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32), localOff = buf.readUInt32LE(off + 42);
    m.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return m;
}
function entryData(buf, e) {
  const nl = buf.readUInt16LE(e.localOff + 26), el = buf.readUInt16LE(e.localOff + 28), s = e.localOff + 30 + nl + el;
  const raw = buf.subarray(s, s + e.compSize);
  return e.method === 0 ? raw : inflateRawSync(raw);
}
const unesc = (s) => s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseXml(t) {
  const root = { tag: null, attrs: {}, children: [], text: '' }; const st = [root]; const re = /<([^>]*)>/g; let last = 0, x;
  while ((x = re.exec(t)) !== null) {
    const b = t.slice(last, x.index); if (b) st[st.length - 1].text += unesc(b); last = re.lastIndex;
    const c = x[1]; if (c.startsWith('!') || c.startsWith('?')) continue;
    if (c.startsWith('/')) { if (st.length > 1) st.pop(); continue; }
    const sc = c.endsWith('/'); const body = sc ? c.slice(0, -1) : c;
    const nm = /^([A-Za-z_][\w.:-]*)/.exec(body); if (!nm) continue;
    const at = {}; const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g; let a;
    while ((a = ar.exec(body)) !== null) at[a[1]] = unesc(a[2]);
    const nd = { tag: nm[1], attrs: at, children: [], text: '' };
    st[st.length - 1].children.push(nd); if (!sc) st.push(nd);
  }
  return root;
}
const findAll = (n, t, o = []) => { for (const c of n.children) { if (c.tag === t) o.push(c); findAll(c, t, o); } return o; };
const colIdx = (ref) => { const L = (ref.match(/^[A-Z]+/) ?? ['A'])[0]; let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const colName = (i) => { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

function readWorkbook(path) {
  const buf = readFileSync(path); const ents = zipEntries(buf);
  const wbXml = entryData(buf, ents.get('xl/workbook.xml')).toString('utf8');
  const ssE = ents.get('xl/sharedStrings.xml');
  const sst = ssE ? findAll(parseXml(entryData(buf, ssE).toString('utf8')), 'si').map((si) => findAll(si, 't').map((x) => x.text).join('')) : [];
  const rels = {};
  for (const r of findAll(parseXml(entryData(buf, ents.get('xl/_rels/workbook.xml.rels')).toString('utf8')), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;
  const sheets = [];
  for (const sh of findAll(parseXml(wbXml), 'sheet')) {
    let t = rels[sh.attrs['r:id']]; t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    const doc = parseXml(entryData(buf, ents.get(t)).toString('utf8'));
    const rows = [];
    for (const rowEl of findAll(doc, 'row')) {
      const cells = [];
      for (const c of findAll(rowEl, 'c')) {
        const i = colIdx(c.attrs.r ?? 'A'); let v = '';
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

const ID_RE = /^\d{4}-\d{1,2}(?:-\d{1,2})?$/;
const lines = [];
const grammar = {};

for (const f of readdirSync(LABEL).filter((x) => x.toLowerCase().endsWith('.xlsx') && !x.startsWith('~$')).sort()) {
  const year = (f.match(/^(\d{4})/) ?? [])[1];
  const sheets = readWorkbook(join(LABEL, f));
  lines.push(`\n${'='.repeat(100)}\nFILE ${f}`);

  sheets.forEach((sh, si) => {
    const width = sh.rows.reduce((w, r) => Math.max(w, r.cells.length), 0);
    // score each column for ID-ness
    const scores = [];
    for (let i = 0; i < width; i++) {
      const vals = sh.rows.map((r) => r.cells[i]).filter((v) => v !== undefined && String(v).trim() !== '');
      const hits = vals.filter((v) => ID_RE.test(String(v).trim()));
      const uniq = new Set(hits.map(String));
      scores.push({ col: i, nonEmpty: vals.length, idHits: hits.length, distinct: uniq.size, sample: [...uniq].slice(0, 6) });
    }
    const idCols = scores.filter((s) => s.idHits >= 2 && s.idHits >= 0.5 * s.nonEmpty).sort((a, b) => a.col - b.col);
    lines.push(`\n  --- Sheet${si + 1} "${sh.name}" rows=${sh.rows.length} width=${width}`);
    if (!idCols.length) { lines.push('      (no study-id column detected)'); return; }
    for (const c of idCols) {
      lines.push(`      idColumn ${colName(c.col)}[${c.col}]  nonEmpty=${c.nonEmpty} idCells=${c.idHits} distinct=${c.distinct}`);
      lines.push(`        sample: ${c.sample.join(', ')}`);
    }
    const primary = idCols[0];
    const uniq = new Set(sh.rows.map((r) => r.cells[primary.col]).filter((v) => v && ID_RE.test(String(v).trim())).map(String));
    const shapes = {};
    for (const id of uniq) {
      const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(id);
      const k = !m ? 'OTHER' : (m[3] ? `YYYY-NN-K (K has ${m[3].length} digit(s))` : 'YYYY-NN');
      (shapes[k] ??= []).push(id);
    }
    lines.push(`      DISTINCT ids = ${uniq.size}`);
    for (const [k, v] of Object.entries(shapes)) {
      lines.push(`        ${k}: ${v.length}  e.g. ${v.slice(0, 10).join(', ')}${v.length > 10 ? ' …' : ''}`);
    }
    grammar[`${year}|Sheet${si + 1}`] = { distinct: uniq.size, shapes: Object.fromEntries(Object.entries(shapes).map(([k, v]) => [k, v.length])) };
  });
}

lines.push(`\n\n${'#'.repeat(100)}\nGRAMMAR SUMMARY\n` + JSON.stringify(grammar, null, 2));
writeFileSync(join(OUT, 'GRAMMAR.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
