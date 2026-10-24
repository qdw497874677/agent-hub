import { defineConfig } from '@playwright/test';

const port = 7896;

/**
 * e2e 用固定端口 + 固定数据目录，但**不预清理**：
 * Playwright 会在主进程和每个 worker 进程里各求值一次本文件，
 * 在这儿 rmSync 会在 server 跑起来之后把目录删成 unlinked fd——
 * 数据看着有、`sqlite3` 查不到（踩过一次，代价不小）。
 * 用例自己用唯一标题隔离，不依赖「空库」这个前提。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // 用系统 chromium，不额外下 200MB 的浏览器包
    launchOptions: { executablePath: '/usr/bin/chromium' },
    trace: 'off'
  },
  webServer: {
    command: `node apps/server/src/main.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      HUB_PORT: String(port),
      HUB_DATA_DIR: '/tmp/agent-hub-e2e-data',
      HUB_SPAWN_WORKER: '1'
    }
  }
});
