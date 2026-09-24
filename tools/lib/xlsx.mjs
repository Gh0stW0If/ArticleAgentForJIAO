// tools/lib/xlsx.mjs — 零依赖 .xlsx 读取（ZIP + XML，仅用 node:zlib）
//
// 注意：XML 分词必须用 `<([^>]*)>`。曾用「正规」属性正则
// （要求 \s+ 分隔）导致 <tag a="b"> 完全不匹配、静默返回空表。

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/* ------------------------------- ZIP ------------------------------- */

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD 未找到：不是 zip/xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏 @' + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    map.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

function entryData(buf, e) {
  const nl = buf.readUInt16LE(e.localOff + 26);
  const el = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nl + el;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + e.method);
}

/* ------------------------------- XML ------------------------------- */

const unescape = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 极简 XML → 树。attribute 值内的裸 '>' 在合法 XML 中不会出现。 */
export function parseXml(text) {
  const root = { tag: null, attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const between = text.slice(last, m.index);
    if (between) stack[stack.length - 1].text += unescape(between);
    last = re.lastIndex;
    const content = m[1];
    if (content.startsWith('!') || content.startsWith('?')) continue;
    if (content.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = content.endsWith('/');
    const body = selfClose ? content.slice(0, -1) : content;
    const nm = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!nm) continue;
    const attrs = {};
    const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(body)) !== null) attrs[a[1]] = unescape(a[2]);
    const node = { tag: nm[1], attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

export const findAll = (node, tag, out = []) => {
  for (const c of node.children) { if (c.tag === tag) out.push(c); findAll(c, tag, out); }
  return out;
};

export const colToIndex = (ref) => {
  const letters = (ref.match(/^[A-Z]+/) ?? ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export const indexToCol = (i) => {
  let s = ''; i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

/* ----------------------------- workbook ---------------------------- */

/**
 * 读取 xlsx。
 * @returns {{ sheetNames: string[], sheets: {name:string, rows:{r:number,cells:string[]}[], comments: Record<string,string>}[], workbookParts: string[] }}
 */
export function readWorkbook(path) {
  const buf = readFileSync(path);
  const entries = zipEntries(buf);
  const get = (n) => (entries.has(n) ? entryData(buf, entries.get(n)) : null);

  const wbXml = get('xl/workbook.xml')?.toString('utf8');
  if (!wbXml) throw new Error('缺少 xl/workbook.xml');

  const ssRaw = get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sst = ssRaw
    ? findAll(parseXml(ssRaw), 'si').map((si) => findAll(si, 't').map((x) => x.text).join(''))
    : [];

  const rels = {};
  const relsXml = get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  for (const r of findAll(parseXml(relsXml), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;

  // 单元格批注（WPS 把部分 schema 说明放在批注里，必须读）
  const commentsBySheet = {};
  for (const cn of entries.keys()) {
    if (!/^xl\/comments\d+\.xml$/.test(cn)) continue;
    const xml = get(cn)?.toString('utf8');
    if (!xml) continue;
    const authors = findAll(parseXml(xml), 'author').map((a) => a.text);
    const map = {};
    for (const c of findAll(parseXml(xml), 'comment')) {
      const body = findAll(c, 't').map((t) => t.text).join('');
      const ai = Number(c.attrs.authorId);
      map[c.attrs.ref] = body;
      if (Number.isFinite(ai) && authors[ai]) map[c.attrs.ref + '@author'] = authors[ai];
    }
    commentsBySheet[cn] = map;
  }

  // 每个 sheet 的 rels → 批注文件
  const sheets = [];
  const sheetNames = [];
  for (const sh of findAll(parseXml(wbXml), 'sheet')) {
    const name = sh.attrs.name ?? 'Sheet';
    sheetNames.push(name);
    let target = rels[sh.attrs['r:id']];
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target)?.toString('utf8');
    const rows = [];
    if (xml) {
      const doc = parseXml(xml);
      for (const rowEl of findAll(doc, 'row')) {
        const cells = [];
        for (const c of findAll(rowEl, 'c')) {
          const i = colToIndex(c.attrs.r ?? 'A');
          let v = '';
          if (c.attrs.t === 'inlineStr') {
            v = findAll(c, 't').map((x) => x.text).join('');
          } else {
            const vv = c.children.find((x) => x.tag === 'v');
            if (vv) { v = vv.text; if (c.attrs.t === 's') v = sst[Number(v)] ?? ''; }
          }
          cells[i] = v;
        }
        rows.push({ r: Number(rowEl.attrs.r), cells });
      }
    }
    // 该 sheet 对应的批注
    let comments = {};
    const rp = `xl/worksheets/_rels/${target.split('/').pop()}.rels`;
    const rpx = get(rp)?.toString('utf8');
    if (rpx) {
      for (const rel of findAll(parseXml(rpx), 'Relationship')) {
        if (!/comments/.test(rel.attrs.Type ?? '')) continue;
        let ct = rel.attrs.Target ?? '';
        ct = ct.startsWith('/') ? ct.slice(1) : 'xl/' + ct.replace(/^\.\.\//, '').replace(/^\.\//, '');
        if (commentsBySheet[ct]) comments = commentsBySheet[ct];
      }
    }
    sheets.push({ name, rows, comments });
  }

  return { sheetNames, sheets };
}

/* ---------------------------- 网格工具 ---------------------------- */

/** 二维网格 → 以 (row, col0) 取值的访问器。 */
export function makeGrid(rows) {
  const byRow = new Map(rows.map((r) => [r.r, r.cells]));
  const width = rows.reduce((w, r) => Math.max(w, r.cells.length), 0);
  return {
    width,
    rowNumbers: rows.map((r) => r.r),
    at: (r, c) => {
      const cells = byRow.get(r);
      if (!cells) return '';
      const v = cells[c];
      return v === undefined || v === null ? '' : String(v);
    },
    has: (r) => byRow.has(r),
  };
}

/** 整行文本（用于判定表头行）。 */
export const rowText = (row) => (row.cells ?? []).map((v) => String(v ?? '')).join('\u0001');

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
