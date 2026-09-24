/**
 * 打包前置检查：各包的 dist 是否齐、依赖里有没有第三方包、tsconfig.build.json 是否在。
 * 用法：node tools/_pack_prereq.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['core', 'ingest', 'skills', 'crossref', 'europepmc'];
for (const p of PKGS) {
  const dir = join(ROOT, 'packages', p);
  const raw = readFileSync(join(dir, 'package.json'), 'utf8');
  const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
  console.log(`（${p}/package.json ${raw.charCodeAt(0) === 0xFEFF ? '⚠ 带 BOM' : '无 BOM'}）`);
  const deps = Object.keys(j.dependencies ?? {});
  const third = deps.filter((d) => !d.startsWith('@aa/'));
  const dist = join(dir, 'dist');
  const n = existsSync(dist) ? readdirSync(dist).length : 0;
  /* dist 里最后一个被改的文件时间 */
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else newest = Math.max(newest, statSync(f).mtimeMs);
    }
  };
  if (n) walk(dist);
  console.log(`${p.padEnd(11)} deps=[${deps.join(', ')}]  第三方=[${third.join(', ')}]`);
  console.log(`            dist ${n} 项，最后修改 ${n ? new Date(newest).toISOString().slice(0, 16) : '—'}`
    + `  build=${existsSync(join(dir, 'tsconfig.build.json'))}  exports=${JSON.stringify(j.exports ?? j.main ?? null)}`);
}
console.log('\napps/web/dist 存在：', existsSync(join(ROOT, 'apps', 'web', 'dist')));
console.log('electron-builder 存在：', existsSync(join(ROOT, 'node_modules', 'electron-builder')));
console.log('electron/dist 存在：', existsSync(join(ROOT, 'node_modules', 'electron', 'dist')));
