// tools/gold_headers.mjs — 输出每个 workbooks 的"表头标签"原始布局。
// 目的：确认 2015-2025 各年份的字段名与列位置，判断需要几套映射。
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

function readSheets(path) {
  const buf = readFileSync(path); const ents = zipEntries(buf);
  const wbXml = entryData(buf, ents.get('xl/workbook.xml')).toString('utf8');
  const ssE = ents.get('xl/sharedStrings.xml');
  const sst = ssE ? findAll(parseXml(entryData(buf, ssE).toString('utf8')), 'si').map((si) => findAll(si, 't').map((x) => x.text).join('')) : [];
  const rels = {};
  for (const r of findAll(parseXml(entryData(buf, ents.get('xl/_rels/workbook.xml.rels')).toString('utf8')), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;
  const out = [];
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
    out.push({ name: sh.attrs.name, rows });
  }
  return out;
}

const files = readdirSync(LABEL).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$')).sort();
const lines = [];
const labelSets = {};   // `${sheet}|${year}` -> 标签数组（列顺序）

for (const f of files) {
  const year = (f.match(/^(\d{4})/) ?? [])[1];
  const sheets = readSheets(join(LABEL, f));
  lines.push(`\n${'='.repeat(110)}\n#### ${year}  ${f}`);
  sheets.forEach((sh, si) => {
    const w = sh.rows.reduce((x, r) => Math.max(x, r.cells.length), 0);
    lines.push(`\n  === Sheet${si + 1} "${sh.name}"  rows=${sh.rows.length} width=${w} ===`);
    // 表头 = 前若干行（数据行以 4位年-开头 为界）
    const ID_RE = /^\d{4}-\d{1,2}(-\d{1,2})?$/;
    let firstData = Infinity;
    for (const r of sh.rows) if (r.cells.some((v) => v && ID_RE.test(String(v).trim()))) { firstData = r.r; break; }
    lines.push(`  首个数据行: r${firstData === Infinity ? '(none)' : firstData}`);
    const hdrRows = sh.rows.filter((r) => r.r < firstData);
    for (const hr of hdrRows) {
      const nz = [];
      for (let i = 0; i < w; i++) if (hr.cells[i] !== undefined && String(hr.cells[i]).trim() !== '') nz.push(`${colName(i)}[${i}]=${JSON.stringify(String(hr.cells[i]).replace(/\s+/g, ' ').slice(0, 60))}`);
      lines.push(`   HDR r${hr.r} (${nz.length} 非空):`);
      lines.push('     ' + nz.join('\n     '));
    }
    // 记录标签序列（最后一行表头 = 字段名/编码行）
    const last = hdrRows.length ? hdrRows[hdrRows.length - 1] : null;
    if (last) {
      const arr = [];
      for (let i = 0; i < w; i++) arr.push(String(last.cells[i] ?? '').replace(/\s+/g, ' ').trim());
      while (arr.length && !arr[arr.length - 1]) arr.pop();
      labelSets[`Sheet${si + 1}|${year}`] = arr;
    }
  });
}

// ---- 统一性结论 ----
lines.push(`\n\n${'#'.repeat(110)}\n## 列标签序列统一性检查`);
for (const sheet of ['Sheet1', 'Sheet2', 'Sheet3']) {
  const per = Object.entries(labelSets).filter(([k]) => k.startsWith(sheet + '|'));
  lines.push(`\n--- ${sheet} ---`);
  for (const [k, v] of per) lines.push(`   ${k.padEnd(14)} 列数=${v.length}  首标签=${JSON.stringify(v[0])} 末标签=${JSON.stringify(v[v.length-1])}`);
  const base = per.find(([k]) => k.endsWith('|2015'))?.[1];
  if (!base) continue;
  // 找出所有年份共有的"标签→位置"映射差异
  for (const [k, v] of per) {
    if (k.endsWith('|2015')) continue;
    const diffs = [];
    for (let i = 0; i < Math.max(base.length, v.length); i++) {
      const a = base[i] ?? '', b = v[i] ?? '';
      if (a !== b) diffs.push(`${colName(i)}[${i}]: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
    lines.push(`   ${k}: ${diffs.length === 0 ? '✅ 与 2015 逐列一致' : `⚠️ ${diffs.length} 处差异`}`);
    if (diffs.length) for (const d of diffs.slice(0, 8)) lines.push(`        ${d}`);
  }
}

writeFileSync(join(OUT, 'HEADERS.txt'), lines.join('\n'), 'utf8');
writeFileSync(join(OUT, '_labelsets.json'), JSON.stringify(labelSets, null, 2), 'utf8');
console.log('written HEADERS.txt / _labelsets.json');
console.log(lines.slice(-90).join('\n'));
