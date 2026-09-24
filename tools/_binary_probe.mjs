import { readFileSync, readdirSync } from 'node:fs';

const dir = 'build/llm-cache';
const hits = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  let j;
  try { j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
  const tag = String(j.tag ?? '');
  if (!tag.includes('outcome-values') || !tag.includes('2016-04')) continue;
  hits.push({ tag, at: j.at, resp: j.response, user: j.prompt?.user ?? '' });
}
hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
console.log(`2016-04 的 outcome-values 缓存条目 ${hits.length} 条（按时间倒序，只看最近 4 条）`);
for (const h of hits.slice(0, 4)) {
  const txt = h.resp?.text ?? '';
  console.log(`\n== ${h.tag} @ ${h.at} ==`);
  const json = h.resp?.json ?? (() => { try { return JSON.parse(txt); } catch { return null; } })();
  if (json) {
    for (const [tp, block] of Object.entries(json)) {
      const b = block?.binary;
      if (!b) continue;
      console.log(`   ${tp}.binary:`, JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v?.value ?? v]))).slice(0, 400));
    }
  } else {
    console.log('   非 JSON，前 200 字符：', txt.slice(0, 200));
  }
}
