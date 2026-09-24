// tools/zip_probe.mjs — list ZIP entries + first bytes of key parts of an xlsx.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const path = resolve(process.argv[2]);
const buf = readFileSync(path);
console.log('file:', path, 'bytes:', buf.length);

const eocdSig = 0x06054b50;
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
  if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
}
console.log('eocd offset:', eocd);
if (eocd < 0) process.exit(1);

const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
console.log('central dir offset:', off, 'entry count:', count);

const names = [];
for (let i = 0; i < count; i++) {
  const sig = buf.readUInt32LE(off);
  if (sig !== 0x02014b50) { console.log('!! bad CD sig at', off, '=', sig.toString(16)); break; }
  const method = buf.readUInt16LE(off + 10);
  const compSize = buf.readUInt32LE(off + 20);
  const uncompSize = buf.readUInt32LE(off + 24);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
  names.push({ name, method, compSize, uncompSize, localOff });
  off += 46 + nameLen + extraLen + commentLen;
}
for (const n of names) {
  console.log(`  ${n.method} comp=${n.compSize} uncomp=${n.uncompSize} local=${n.localOff}  ${n.name}`);
}

// try inflating each xml part
for (const n of names) {
  if (!/\.(xml|rels)$/i.test(n.name)) continue;
  try {
    const lo = n.localOff;
    const lnameLen = buf.readUInt16LE(lo + 26);
    const lextraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + n.compSize);
    const data = n.method === 0 ? raw : inflateRawSync(raw);
    const s = data.toString('utf8');
    console.log(`\n===== ${n.name} (${s.length} chars) =====`);
    console.log(s.slice(0, 1200));
    if (s.length > 1200) console.log(`... [truncated, total ${s.length}]`);
  } catch (e) {
    console.log(`\n===== ${n.name} FAILED: ${e.message}`);
  }
}
