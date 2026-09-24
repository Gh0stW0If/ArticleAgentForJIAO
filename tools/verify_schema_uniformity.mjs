// tools/verify_schema_uniformity.mjs
// 目标：确认 2015-2025 × 3 sheet 的字段结构是否一致，字段是否会发生列位移。
// 输出：每个 sheet 的"有效宽度"（最后一个有非空表头单元格的列）与年份间差异。
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(process.cwd());
const LABEL = join(ROOT, 'Datas', 'label');
const OUT = join(ROOT, 'build', 'gold_inspect');
mkdirSync(OUT, { recursive: true });

/* ---------- zip ---------- */
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

/* ---------- xml ---------- */
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

const ID_RE = /^\d{4}-\d{1,2}(-\d{1,2})?$/;
const files = readdirSync(LABEL).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$')).sort();
const report = {};
const lines = [];

for (const f of files) {
  const year = (f.match(/^(\d{4})/) ?? [])[1];
  const sheets = readWorkbook(join(LABEL, f));
  sheets.forEach((sh, si) => {
    const key = `Sheet${si + 1}`;
    // 数据区：存在研究ID的行
    const dataRows = sh.rows.filter((r) => r.cells.some((v) => v && ID_RE.test(String(v).trim())));
    // 表头行 = 数据行之前的行
    const firstDataRow = dataRows.length ? dataRows[0].r : Infinity;
    const headerRows = sh.rows.filter((r) => r.r < firstDataRow);
    // headerRows 合并后的最大非空列
    let hdrW = 0;
    for (const hr of headerRows) for (let i = 0; i < hr.cells.length; i++) if (hr.cells[i] !== undefined && String(hr.cells[i]).trim() !== '') hdrW = Math.max(hdrW, i + 1);
    // 数据区最大非空列
    let dataW = 0;
    for (const dr of dataRows) for (let i = 0; i < dr.cells.length; i++) if (dr.cells[i] !== undefined && String(dr.cells[i]).trim() !== '') dataW = Math.max(dataW, i + 1);
    const declaredW = sh.rows.reduce((w, r) => Math.max(w, r.cells.length), 0);
    report[`${year}|${key}`] = { headerW: hdrW, dataW, declaredW, headerRows: headerRows.length, dataRows: dataRows.length };
    lines.push(`${year} ${key.padEnd(7)} headerRows=${String(headerRows.length).padStart(2)} dataRows=${String(dataRows.length).padStart(3)} headerW=${String(hdrW).padStart(3)} dataW=${String(dataW).padStart(3)} declaredW=${String(declaredW).padStart(3)}`);
  });
}

// 汇总：每个 sheet 各年份的 headerW/dataW 是否一致
lines.push('\n===== 一致性汇总 =====');
for (const key of ['Sheet1', 'Sheet2', 'Sheet3']) {
  const hdr = [], dat = [];
  for (const [k, v] of Object.entries(report)) if (k.endsWith('|' + key)) { hdr.push(v.headerW); dat.push(v.dataW); }
  lines.push(`${key}: headerW 集合 = {${[...new Set(hdr)].sort((a,b)=>a-b).join(', ')}}   dataW 集合 = {${[...new Set(dat)].sort((a,b)=>a-b).join(', ')}}`);
}

// 表头逐列哈希比对（Sheet1/Sheet2 字段名行；Sheet3 用 R005 编码行）
lines.push('\n===== 表头逐列比对（检测列位移） =====');
function headerSignature(sheets, si, rowPick) {
  const sh = sheets[si];
  const rows = sh.rows;
  const dataRows = rows.filter((r) => r.cells.some((v) => v && ID_RE.test(String(v).trim())));
  const firstDataRow = dataRows.length ? dataRows[0].r : Infinity;
  const headerRows = rows.filter((r) => r.r < firstDataRow);
  const picked = rowPick(headerRows);
  if (!picked) return null;
  const w = rows.reduce((w, r) => Math.max(w, r.cells.length), 0);
  const sig = [];
  for (let i = 0; i < w; i++) sig.push(String(picked.cells[i] ?? '').replace(/\s+/g, ' ').trim());
  // 去掉尾部空列
  while (sig.length && !sig[sig.length - 1]) sig.pop();
  return sig;
}

// Sheet1/Sheet2：字段名行 = 表头最后一行；Sheet3：编码行 = 表头最后一行
const sigs = {};
for (const f of files) {
  const year = (f.match(/^(\d{4})/) ?? [])[1];
  const sheets = readWorkbook(join(LABEL, f));
  sheets.forEach((sh, si) => {
    const sig = headerSignature(sheets, si, (hrs) => hrs.length ? hrs[hrs.length - 1] : null);
    if (sig) sigs[`${year}|Sheet${si + 1}`] = sig;
  });
}

for (const key of ['Sheet1', 'Sheet2', 'Sheet3']) {
  const per = Object.entries(sigs).filter(([k]) => k.endsWith('|' + key));
  const maxLen = Math.max(...per.map(([, s]) => s.length));
  lines.push(`\n--- ${key}: 各年长度 ${per.map(([k, s]) => `${k.slice(0, 4)}:${s.length}`).join(' ')} ---`);
  // 与 2015 基准逐列比较
  const base = per.find(([k]) => k.startsWith('2015'))?.[1];
  if (!base) { lines.push('  (无 2015 基准)'); continue; }
  for (const [k, s] of per) {
    if (k.startsWith('2015')) continue;
    const diffs = [];
    for (let i = 0; i < Math.max(base.length, s.length); i++) {
      if ((base[i] ?? '') !== (s[i] ?? '')) diffs.push(`${colName(i)}[${i}]: "${base[i] ?? ''}"→"${s[i] ?? ''}"`);
    }
    if (diffs.length === 0) lines.push(`  ${k}: ✅ 与 2015 完全一致 (${s.length} 列)`);
    else lines.push(`  ${k}: ⚠️ ${diffs.length} 处差异\n      ` + diffs.slice(0, 12).join('\n      ') + (diffs.length > 12 ? `\n      ... 另有 ${diffs.length - 12} 处` : ''));
  }
}

writeFileSync(join(OUT, 'UNIFORMITY.txt'), lines.join('\n'), 'utf8');
writeFileSync(join(OUT, '_uniformity.json'), JSON.stringify({ report, sigs }, null, 2), 'utf8');
console.log(lines.join('\n'));
