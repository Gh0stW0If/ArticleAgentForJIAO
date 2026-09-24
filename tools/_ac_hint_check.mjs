/** 一次性核对：定点补料到底会往提示里塞什么？以及哪些篇属于"块进不了材料"。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAT = { sections: ['metadata', 'abstract', 'funding', 'acknowledgements'], pages: [1, 2] };
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const CORR = /(correspond(?:ence|ing)|通讯作者|通信作者|通訊作者|reprint)/i;
const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

const pageRows = JSON.parse(readFileSync(join(ROOT, 'build', 'author_contact_page.json'), 'utf8')).rows;
const W = { identical: 1, same_meaning: 1, contains_correct: 0.5, has_error: 0, completely_different: 0 };

/** 该篇金标准邮箱所在块能否进材料 */
function classify(t) {
  let doc;
  try { doc = ingest({ rootDir: ROOT, year: t.year, studyId: t.id }).doc; } catch { return null; }
  const needle = flat(t.emails[0]);
  const hits = doc.blocks.filter((b) => !b.dropped && flat(b.text).includes(needle));
  if (!hits.length) return { doc, kind: 'noDoc' };
  const inMat = hits.some((b) => MAT.sections.includes(b.section) || MAT.pages.includes(b.page));
  return { doc, kind: inMat ? 'inMat' : 'outMat', block: hits[0] };
}

const outMat = [];
for (const t of pageRows) {
  const c = classify(t);
  if (c && c.kind === 'outMat') outMat.push({ ...t, section: c.block.section, blockPage: c.block.page });
}
console.log(`\n"邮箱所在块进不了材料"的篇：${outMat.length}`);
writeFileSync(join(ROOT, 'build', '_ac_outmat.json'), JSON.stringify(outMat, null, 1), 'utf8');
for (const t of outMat) console.log(`  ${t.id}  块页 ${t.blockPage}  章节 ${t.section}  判定 ${t.verdict}`);

/* 打印几篇的补料内容（可用命令行指定 id） */
const wantIds = process.argv.slice(2);
const hintIds = wantIds.length ? wantIds : ['2020-01', '2024-28', '2024-03'];
for (const id of hintIds) {
  const t = pageRows.find((r) => r.id === id);
  if (!t) continue;
  const c = classify(t);
  if (!c?.doc) continue;
  const found = new Map();
  for (const b of c.doc.blocks) {
    if (b.dropped) continue;
    const text = String(b.text ?? '');
    if (!text) continue;
    const marked = CORR.test(text);
    for (const m of text.match(EMAIL_RE) ?? []) {
      const e = m.replace(/\s+/g, '').toLowerCase();
      const cur = found.get(e) ?? { pages: new Set(), sections: new Set(), marked: false };
      cur.pages.add(b.page); cur.sections.add(b.section); cur.marked ||= marked;
      found.set(e, cur);
    }
  }
  console.log(`\n── ${id} 的补料内容（金标准 ${t.emails[0]}）──`);
  const list = [...found.entries()].sort((a, b) => (Number(b[1].marked) - Number(a[1].marked)) || (Math.min(...a[1].pages) - Math.min(...b[1].pages)));
  for (const [e, v] of list) console.log(`  - ${e}（p${[...v.pages].join(',')}，${[...v.sections].join('/')}${v.marked ? '，同段出现 correspondence 字样' : ''}）`);
}
