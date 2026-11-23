import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 测试配置。
 *
 * 关键决策：用 alias 把 `@aa/*` 直接指到各包的【源码】。
 *
 * 为什么不用 package.json 的 exports 指源码：
 *   Node 运行 ESM 时要求显式 `.js` 扩展名，而源码里写的 `./table.js`
 *   在 Node 下会去找不存在的 `table.js`（实际是 `table.ts`）——
 *   "exports 指源码"这条路在 Node 下根本不成立，只在打包器里可行。
 *   因此：包对外声明 dist（标准做法），测试通过 alias 走源码。
 *
 * 测试文件内部一律用相对路径 + `.ts` 扩展名（配合 allowImportingTsExtensions）。
 */
const pkg = (name: string): string => resolve(__dirname, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@aa/core': pkg('core'),
      '@aa/ingest': pkg('ingest'),
      '@aa/crossref': pkg('crossref'),
      '@aa/skills': pkg('skills'),
    },
  },
  test: {
    /*
     * `tools/` 也纳入：导出器（zip / xlsx 写入、核对结果摊平）是纯逻辑，
     * 没有理由只靠 e2e 覆盖。用 `.test.mjs` 命名，与包内的 `.test.ts` 区分开。
     */
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/**/*.test.mjs'],
    environment: 'node',
    globals: false,
  },
});
