/** 一次性调试：`pickCorrespondingEmail` 的判据在真实文档上成立吗？ */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** ⚠️ 必须与 `packages/skills/src/article-meta.ts` 的 `EMAIL_RE` 完全一致——
 *  这里是**抄写**的副本，正则一旦不同步就会出现"源码能扫到、调试脚本扫不到"的假象
 *  （踩过一次：把 `\s*` 改成空格后，跨行断开的邮箱两边都扫不到，却误判成"模型拒答"）。 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;
const CORR = /(correspond(?:ence|ing)|通讯作者|通信作者|通訊作者|reprint)/i;

for (const [year, id] of [['2024', '2024-03'], ['2021', '2021-08'], ['2020', '2020-09']]) {
  const doc = ingest({ rootDir: ROOT, year, studyId: id }).doc;
  const all = [];
  const corr = [];
  for (const b of doc.blocks) {
    const text = String(b.text ?? '');
    if (!text) continue;
    const marked = CORR.test(text);
    for (const m of text.match(EMAIL_RE) ?? []) {
      all.push({ email: m.replace(/\s+/g, ''), page: b.page, section: b.section, dropped: !!b.dropped, marked });
      if (marked && !b.dropped) corr.push({ email: m.replace(/\s+/g, ''), page: b.page, section: b.section });
    }
  }
  console.log(`\n── ${id} ──  块数 ${doc.blocks.length}`);
  console.log(`  全部邮箱（含 dropped）：${all.length}  带 correspondence 且未 dropped：${corr.length}`);
  for (const c of corr) console.log(`    ✓ ${c.email}  p${c.page}/${c.section}`);
  const dropped = all.filter((a) => a.dropped);
  if (dropped.length) console.log(`  ⚠ dropped 块里的邮箱：${dropped.map((d) => d.email).join(', ')}`);
  const uniq = new Set(corr.map((c) => c.email.toLowerCase()));
  console.log(`  去重后候选数：${uniq.size} → ${uniq.size === 1 ? '应触发兜底' : '不触发'}`);
}
