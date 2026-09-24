/**
 * 为 Electron 打包准备一份**可解析的 `node_modules/@aa`**。
 *
 * 背景（实测）：
 *   打包版 `resources/app/packages/<pkg>/dist` 之间用**裸包名**互相引用
 *   （`import { warn } from '@aa/core'`），而 exe 里没有 node_modules
 *   → 直接 `ERR_MODULE_NOT_FOUND: Cannot find package '@aa/core'`，
 *   GUI 的「解析 / 抽取」按钮在打包版里跑不起来。
 *
 * 做法：把每个 `@aa/*` 包**只要 package.json + dist** 复制成真实目录
 * （不复制 src、不复制它自己的 node_modules，避免把软链和源码一起拖进 exe）。
 * 这些包**没有第三方依赖**（已核对），所以不需要搬 pnpm 的依赖树。
 *
 * 用法：node tools/desktop_stage_modules.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['core', 'crossref', 'europepmc', 'ingest', 'skills'];
const STAGE = join(ROOT, 'build', 'desktop-stage', 'node_modules', '@aa');

if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const p of PKGS) {
  const src = join(ROOT, 'packages', p);
  const dist = join(src, 'dist');
  if (!existsSync(dist)) {
    console.error(`✗ packages/${p}/dist 不存在，先跑 tsc -p packages/${p}/tsconfig.build.json`);
    process.exit(1);
  }
  const dst = join(STAGE, p);
  mkdirSync(dst, { recursive: true });
  /* package.json 去掉 BOM，并裁掉 scripts/devDependencies（exe 里用不到） */
  const raw = readFileSync(join(src, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
  const j = JSON.parse(raw);
  const slim = {
    name: j.name,
    version: j.version,
    type: j.type ?? 'module',
    main: j.main,
    types: j.types,
    exports: j.exports,
    dependencies: j.dependencies ?? {},
  };
  writeFileSync(join(dst, 'package.json'), `${JSON.stringify(slim, null, 2)}\n`, 'utf8');
  cpSync(dist, join(dst, 'dist'), { recursive: true });
  const depN = Object.keys(j.dependencies ?? {}).length;
  console.log(`✓ @aa/${p.padEnd(11)} dist 已复制（依赖 ${depN} 个，均为 @aa/* 内部包）`);
}

console.log(`\n已生成 ${STAGE}`);
