/**
 * **一条命令让 exe 变成最新版提取流程**。
 *
 * 顺序（每一步都不能少，否则 exe 里会缺东西）：
 *   1. 编译 5 个包 → `packages/<pkg>/dist`（提取流程的代码全在这里）
 *   2. 生成 `build/desktop-stage/node_modules/@aa`（让 exe 内能解析裸包名）
 *   3. electron-builder 打 portable exe
 *
 * 为什么不用 `pnpm -r build`：本环境 `pnpm` 不可用（runtime-commands 已消失），
 * 所以直接调 `node node_modules/typescript/bin/tsc`。
 *
 * 用法：
 *   node tools/desktop_make.mjs              # 全流程
 *   node tools/desktop_make.mjs --skip-tsc   # 只做 staging + 打包
 *   node tools/desktop_make.mjs --dry        # 只编译 + staging，不打包
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const EB = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const PKGS = ['core', 'europepmc', 'crossref', 'ingest', 'skills'];

const run = (label, cmd, args, cwd = ROOT) => {
  process.stdout.write(`\n── ${label} ──\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
};

if (!argv.includes('--skip-tsc')) {
  for (const p of PKGS) {
    const tsconfig = join(ROOT, 'packages', p, 'tsconfig.build.json');
    if (!existsSync(tsconfig)) { console.error(`✗ 缺 ${tsconfig}`); process.exit(1); }
    run(`tsc packages/${p}`, process.execPath, [TSC, '-p', tsconfig]);
  }
} else {
  console.log('（跳过 tsc）');
}

run('staging node_modules/@aa', process.execPath, [join(ROOT, 'tools', 'desktop_stage_modules.mjs')]);

/* 图标：electron-builder 的 win.icon 指向 build/icon.png，缺了会打包失败 */
if (!existsSync(join(ROOT, 'build', 'icon.png'))) {
  run('生成图标 build/icon.png', process.execPath, [join(ROOT, 'tools', 'make_icon.mjs'), join(ROOT, 'build', 'icon.png')]);
} else {
  console.log('\n── 图标 ──\n（build/icon.png 已存在，跳过）');
}

if (argv.includes('--dry')) {
  console.log('\n（--dry：不打包）');
  process.exit(0);
}

/* electron-builder 的路径基准是"项目目录"= apps/desktop，必须在该目录下运行 */
run('electron-builder portable', process.execPath, [EB, '--win', 'portable', '--config', 'electron-builder.yml'], join(ROOT, 'apps', 'desktop'));

console.log('\n完成。产物：build/desktop/ArticleAgent-<version>-portable.exe');
console.log('验收：node tools/desktop_verify.mjs');
