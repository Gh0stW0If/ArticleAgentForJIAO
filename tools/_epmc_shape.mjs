/** 一次性：找出 Europe PMC 响应里邮箱到底在哪个字段（决定解析怎么写）。 */
const doi = process.argv[2] ?? '10.1016/j.eujim.2015.09.001';
const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
  + `?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core&pageSize=1`;
const r = await fetch(url, { headers: { 'User-Agent': 'article-agent/1.0' } });
const j = await r.json();
const c = j.resultList?.result?.[0];
if (!c) { console.log(`未收录：${doi}`); process.exit(0); }

console.log(`DOI ${doi}`);
console.log('顶层键:', Object.keys(c).join(', '));
const a = c.authorList?.author?.[0];
console.log('author[0] 键:', a ? Object.keys(a).join(', ') : '（无）');
console.log('author[0]:', JSON.stringify(a)?.slice(0, 400));
console.log('\nauthor 里带 @ 的：');
for (const [i, x] of (c.authorList?.author ?? []).entries()) {
  const s = JSON.stringify(x);
  if (s.includes('@')) console.log(`  author[${i}]: ${s.slice(0, 300)}`);
}
console.log('\n整条响应里含 @ 的路径：');
const walk = (o, path) => {
  if (typeof o === 'string') { if (o.includes('@')) console.log(`  ${path} → ${o.slice(0, 200)}`); return; }
  if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
};
walk(c, 'result');
