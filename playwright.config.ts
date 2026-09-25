import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置：**交互层**测试（框选 → 证据 → 存盘 → 回滚 全链路）。
 *
 * 与 vitest 的分工（`vitest.config.mts` 只收 `packages` / `apps` 下 src 目录里的 test.ts）：
 *   vitest     —— 纯逻辑：几何换算、编码解码、提示词一致性…
 *   playwright —— 真实浏览器：拖拽框选、选项卡切换、人工修改落盘与回滚
 *
 * testDir 限定在 `e2e/`，否则 Playwright 会把 vitest 的用例也扫进来（两边默认的
 * 文件名匹配规则几乎一样）。
 *
 * webServer：**固定占用测试专用端口**（默认 43131，可用 AA_E2E_PORT 覆盖），并且
 * `reuseExistingServer: false`——端口被占就直接报错，绝不悄悄复用别人的服务。
 *
 * 这里踩过一个真实的坑：开发机常驻着打包好的 Electron 应用（它内嵌同一个
 * `apps/web/server.mjs`，监听默认的 43130）。`reuseExistingServer: true` 会让
 * Playwright 复用它，于是静态资源读的是磁盘上的**新** dist（DOM 是新的），
 * 接口却跑在**旧**进程的内存代码里——测试看着在跑，其实测的是旧构建，
 * 报错信息还完全对不上。宁可响亮地失败，也不要静默地测错版本。
 *
 * 需要对着已经起好的服务跑（例如调试线上问题）时，显式给 AA_WEB_URL，
 * 此时不再自己起 webServer。
 */
const E2E_PORT = process.env.AA_E2E_PORT ?? '43131';
const E2E_BASE = process.env.AA_WEB_URL ?? `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: E2E_BASE,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: process.env.AA_WEB_URL
    ? undefined
    : {
        command: 'node apps/web/server.mjs',
        url: `${E2E_BASE}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { AA_ROOT: process.cwd(), AA_PORT: E2E_PORT },
      },
});
