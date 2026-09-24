/** 一次性诊断：篇级"确定性编造"的数字长什么样、上下文是什么。 */
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { deLatex } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [year, id] = process.argv.slice(2);
const dirName = readdirSync(join(ROOT, 'build', 'mineru', year)).find((d) => d.replace(/^-+/, '') === id);
const txtDir = join(ROOT, 'build', 'mineru', year, dirName, 'txt');
const mid = JSON.parse(readFileSync(join(txtDir, readdirSync(txtDir).find((f) => f.endsWith('_middle.json'))), 'utf8'));
const pdfName = readdirSync(join(ROOT, 'Datas', 'articles', year)).find((f) => f.replace(/\.pdf$/i, '').replace(/^-+/, '') === id);
const pdf = join(ROOT, 'Datas', 'articles', year, pdfName);
const tmp = mkdtempSync(join(tmpdir(), 'diag2-'));
const wf = join(tmp, 'w.json');
spawnSync(join(ROOT, 'runtime', 'mineru', 'Scripts', 'python.exe'),
  [join(ROOT, 'tools', 'lib', 'pdf_words.py'), wf, pdf], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
const nat = JSON.parse(readFileSync(wf, 'utf8'))[pdf];

const dec = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const mSegs = [];
for (const page of mid.pdf_info ?? []) {
  const walk = (bs) => {
    for (const b of bs ?? []) {
      for (const l of b.lines ?? []) {
        let seg = '';
        for (const s of l.spans ?? []) {
          if (s.content) seg += deLatex(s.content);
          if (s.html) seg += dec(deLatex(String(s.html)).replace(/<[^>]+>/g, ' '));
        }
        if (seg.trim()) mSegs.push(seg);
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(page.para_blocks); walk(page.discarded_blocks);
}
const mText = mSegs.join('\n');
const nText = nat.pages.map((p) => p.words.map((w) => w.t).join(' ')).join(' ');

const numsOf = (t) => { const o = []; const re = /[-−–—]?\d+(?:[.,]\d+)?/g; let m;
  while ((m = re.exec(String(t ?? ''))) !== null) { let s = m[0].replace(/[−–—]/g, '-');
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s.replace(/^-/, ''))) s = s.replace(/[.,]/g, ''); else s = s.replace(/,/g, '.');
    const n = Number(s); if (Number.isFinite(n)) o.push(String(n)); } return o; };
const ms = new Set(numsOf(mText));
const extra = [...ms].filter((k) => !nText.includes(k));
console.log(`${id}：MinerU 篇级数字 ${ms.size} 种，其中原生全篇字面找不到的 ${extra.length} 种`);
for (const k of extra.slice(0, 14)) {
  const i = mText.search(new RegExp(`(^|[^\\d.])${k.replace('.', '\\.')}([^\\d]|$)`));
  console.log(`  ${k} → ${i < 0 ? '（找不到）' : '…' + mText.slice(Math.max(0, i - 80), i + 80).replace(/\s+/g, ' ') + '…'}`);
}
