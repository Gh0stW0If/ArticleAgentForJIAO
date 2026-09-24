/** 语料与产物普查（诊断用）：每年有多少 PDF / 解析 / 抽取 / 金标准文章。 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const years = Array.from({ length: 11 }, (_, i) => String(2015 + i));
let tp = 0; let tg = 0;
console.log('年份   PDF  解析  抽取  金标准  语料侧副产物');
for (const y of years) {
  const dir = join('Datas', 'articles', y);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const pdf = files.filter((f) => /\.pdf$/i.test(f)).length;
  const side = files.filter((f) => f.startsWith('.')).join(',') || '-';
  const midDir = join('build', 'mineru', y);
  const mid = existsSync(midDir) ? readdirSync(midDir).filter((d) => d !== '_clean').length : 0;
  const extDir = join('build', 'extraction', y);
  const ext = existsSync(extDir) ? readdirSync(extDir).filter((f) => /^\d{4}-\d+\.json$/.test(f)).length : 0;
  let gold = 0;
  const gf = join('build', 'gold', `${y}.json`);
  if (existsSync(gf)) {
    try { gold = JSON.parse(readFileSync(gf, 'utf8')).articles?.length ?? 0; } catch { /* 忽略 */ }
  }
  tp += pdf; tg += gold;
  console.log(`${y}  ${String(pdf).padStart(4)}  ${String(mid).padStart(4)}  ${String(ext).padStart(4)}  ${String(gold).padStart(6)}  ${side.slice(0, 70)}`);
}
console.log(`合计 PDF ${tp} 篇；金标准 ${tg} 篇`);

/* 语料侧副产物（用户既有工具留下的）长什么样，决定能否免 MinerU 跑全量 */
const probe = join('Datas', 'articles', '2015', '.article_agent_hybrid');
if (existsSync(probe)) {
  console.log('\n.article_agent_hybrid 内容:');
  for (const f of readdirSync(probe).slice(0, 8)) console.log('  ', f);
}
