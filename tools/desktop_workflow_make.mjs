import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLeaks } from './lib/secret_scan.mjs';
import { scanRuntimeDeps } from './desktop_dep_scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args = [], cwd = root) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(script + ' failed (' + result.status + ')');
};
run(join(root, 'tools', 'desktop_make.mjs'), ['--dry']);
run(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'apps/web/tsconfig.json', '--noEmit']);
run(join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'), ['build'], join(root, 'apps', 'web'));
const stage = join(root, 'build', 'desktop-workflow-stage', 'pdfjs-dist');
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(join(root, 'tools', 'nodepdf', 'node_modules', 'pdfjs-dist'), stage, { recursive: true });
if (!process.argv.includes('--dry')) {
  run(join(root, 'node_modules', 'electron-builder', 'cli.js'),
    ['--win', 'portable', '--config', 'electron-builder-workflow.yml'], join(root, 'apps', 'desktop'));
}
if (!process.argv.includes('--dry')) {
  const appDir = join(root, 'build/desktop-workflow/win-unpacked/resources/app');
  const leaks = findSecretLeaks(appDir);
  const deps = scanRuntimeDeps(appDir);
  if (leaks.length || deps.missing.length) throw new Error('打包验收失败：密钥文件 ' + leaks.length + '，缺依赖 ' + JSON.stringify(deps.missing));
}
console.log('工作流客户端构建完成：build/desktop-workflow');
