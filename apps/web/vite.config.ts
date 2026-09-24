import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 开发服务器把 /api 代理到本地 API 服务（server.mjs）。
 * pdf.js 的 worker 用 ?url 引入，由 Vite 处理为静态资源。
 */
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      '@aa/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 43131,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.AA_PORT ?? 43130}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
