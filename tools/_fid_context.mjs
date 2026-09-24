/**
 * 对账残差的**上下文取证**：页级"漏读/读错"的数字，在原页面里到底长什么样？
 *
 * 页级数字多重集对账会把"切分差异"也算成差异（例如一个词被拆成两个词、
 * 引用年份与卷号的分隔符不同）。只看数字列表无法判断是"真读错"还是"切分差异"，
 * 必须把两边各自的上下文并排打出来看。这个工具就是干这个的。
 *
 * 用法：node tools/_fid_context.mjs <year> <id> <page> [页码...]
 */

import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { deLatex } from '../packages/core/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [year, id, ...pageArgs] = process.argv.slice(2);

const dirName = readdirSync(join(ROOT, 'build', 'mineru', year)).find((d) => d.replace(/^-+/, '') === id);
const txtDir = join(ROOT, 'build', 'mineru', year, dirName, 'txt');
const midFile = readdirSync(txtDir).find((f) => f.endsWith('_middle.json'));
const mid = JSON.parse(readFileSync(join(txtDir, midFile), 'utf8'));

const pdfName = readdirSync(join(ROOT, 'Datas', 'articles', year)).find((f) => f.replace(/\.pdf$/i, '').replace(/^-+/, '') === id);
const pdf = join(ROOT, 'Datas', 'articles', year, pdfName);
const tmp = mkdtempSync(join(tmpdir(), 'fidctx-'));
const wf = join(tmp, 'w.json');
const r = spawnSync(join(ROOT, 'runtime', 'mineru', 'Scripts', 'python.exe'),
  [join(ROOT, 'tools', 'lib', 'pdf_words.py'), wf, pdf], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 300));
const nat = JSON.parse(readFileSync(wf, 'utf8'))[pdf];

const dec = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const pageText = (page) => {
  const segs = [];
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      for (const line of b.lines ?? []) {
        let seg = '';
        for (const s of line.spans ?? []) {
          if (s.content) seg += deLatex(s.content);
          if (s.html) seg += dec(deLatex(String(s.html)).replace(/<[^>]+>/g, ' '));
        }
        if (seg.trim()) segs.push(seg);
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(page.para_blocks); walk(page.discarded_blocks);
  return segs.join('\n');
};

const numsOf = (text) => {
  const out = [];
  const re = /[-−–—]?\d+(?:[.,]\d+)?/g; let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    let s = m[0].replace(/[−–—]/g, '-');
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s.replace(/^-/, ''))) s = s.replace(/[.,]/g, '');
    else s = s.replace(/,/g, '.');
    const n = Number(s);
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
};

for (const ps of pageArgs) {
  const p = Number(ps);
  const mt = pageText(mid.pdf_info[p - 1]);
  const nt = (nat.pages[p - 1]?.words ?? []).map((w) => w.t).join(' ');
  const ms = new Set(numsOf(mt)); const ns = new Set(numsOf(nt));
  const extra = [...ms].filter((x) => !ns.has(x));
  const missing = [...ns].filter((x) => !ms.has(x));
  console.log(`\n──────── ${id} p${p} ────────`);
  console.log(`MinerU 有而原生无（${extra.length}）：${extra.slice(0, 20).join(', ')}`);
  console.log(`原生有而 MinerU 无（${missing.length}）：${missing.slice(0, 20).join(', ')}`);

  const show = (label, text, keys) => {
    console.log(`\n  【${label}】`);
    for (const k of keys.slice(0, 6)) {
      const i = text.search(new RegExp(`(^|[^\\d.])${k.replace('.', '\\.')}([^\\d]|$)`));
      console.log(i < 0 ? `   ${k}：找不到上下文` : `   ${k} → …${text.slice(Math.max(0, i - 70), i + 70).replace(/\s+/g, ' ')}…`);
    }
  };
  if (extra.length) show('MinerU 侧多出来的数字', mt, extra);
  if (missing.length) show('原生侧有、MinerU 没有的数字', nt, missing);
}
