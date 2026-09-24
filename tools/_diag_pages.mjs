/** 一次性诊断：看 MinerU 页文本与原生页文本的长度关系、以及差异数字的上下文。 */
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const year = process.argv[2] ?? '2015';
const id = process.argv[3] ?? '2015-02';
const dirName = readdirSync(join('build', 'mineru', year)).find((d) => d.replace(/^-+/, '') === id);
const txtDir = join('build', 'mineru', year, dirName, 'txt');
const midFile = readdirSync(txtDir).find((f) => f.endsWith('_middle.json'));
const mid = JSON.parse(readFileSync(join(txtDir, midFile), 'utf8'));
const pdfName = readdirSync(join('Datas', 'articles', year)).find((f) => f.replace(/\.pdf$/i, '').replace(/^-+/, '') === id);
const pdf = join('Datas', 'articles', year, pdfName);

const tmp = mkdtempSync(join(tmpdir(), 'diag-'));
const wf = join(tmp, 'w.json');
const r = spawnSync('runtime/mineru/Scripts/python.exe', ['tools/lib/pdf_words.py', wf, pdf], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 300));
const nat = JSON.parse(readFileSync(wf, 'utf8'))[pdf];

const dec = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const ptext = (p) => {
  const parts = [];
  const walk = (bs) => {
    for (const b of bs ?? []) {
      for (const l of b.lines ?? []) for (const s of l.spans ?? []) {
        if (s.content) parts.push(s.content);
        if (s.html) parts.push(dec(String(s.html).replace(/<[^>]+>/g, ' ')));
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(p.para_blocks); walk(p.discarded_blocks);
  return parts.join(' ');
};

console.log(`${id} 页 | 原生词数 | 原生字符 | MinerU字符 | 比值`);
for (let i = 0; i < mid.pdf_info.length; i++) {
  const nw = nat.pages[i]?.words ?? [];
  const nc = nw.map((w) => w.t).join(' ').length;
  const mt = ptext(mid.pdf_info[i]);
  console.log(`  p${i + 1} | ${nw.length} | ${nc} | ${mt.length} | ${nc ? (mt.length / nc).toFixed(2) : '—'}`);
}

const pageNo = Number(process.argv[4] ?? 0);
if (pageNo) {
  const mt = ptext(mid.pdf_info[pageNo - 1]);
  const nt = (nat.pages[pageNo - 1]?.words ?? []).map((w) => w.t).join(' ');
  console.log(`\n=== ${id} p${pageNo} MinerU 文本（前 1200 字）===`);
  console.log(mt.slice(0, 1200));
  console.log(`\n=== ${id} p${pageNo} 原生文本（前 1200 字）===`);
  console.log(nt.slice(0, 1200));
}
