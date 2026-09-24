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
 * webServer：优先复用已在跑的 `pnpm web:api`（reuseExistingServer），
 * 没跑时自己起一个，保证 `pnpm web:e2e` 一条命令可跑。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.AA_WEB_URL ?? 'http://127.0.0.1:43130',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node apps/web/server.mjs',
    url: 'http://127.0.0.1:43130/api/health',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { AA_ROOT: process.cwd() },
  },
});
