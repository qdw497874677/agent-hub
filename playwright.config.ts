import { mkdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { serverEnv } from './e2e/server-env.ts';

/**
 * Chrome 的单实例套接字放在 $TMPDIR 下，路径加上结尾的 NUL 不能超过 108 字节。
 * 隔离运行若把 TMPDIR 指到很长的工作目录，浏览器会在启动时退出。
 * 只改这个 Playwright 进程的 TMPDIR，不改用户 shell 的全局设置；已经够短就保持原值。
 */
const chromeSocketTail = '/com.google.Chrome.XXXXXX/SingletonSocket';
const inheritedTmp = process.env.TMPDIR ?? '';
if (inheritedTmp === '' || Buffer.byteLength(inheritedTmp) + Buffer.byteLength(chromeSocketTail) >= 108) {
  mkdirSync('/tmp/ah-e2e', { recursive: true });
  process.env.TMPDIR = '/tmp/ah-e2e';
}

const port = Number(process.env['E2E_PORT'] ?? 7896);
// 同机并行跑两套 e2e 时用 E2E_PORT / E2E_DATA_DIR 隔开
const dataDir = process.env['E2E_DATA_DIR'] ?? '/tmp/agent-hub-e2e-data';

/**
 * e2e 用固定端口 + 固定数据目录，但**不预清理**：
 * Playwright 会在主进程和每个 worker 进程里各求值一次本文件，
 * 在这儿 rmSync 会在 server 跑起来之后把目录删成 unlinked fd——
 * 数据看着有、`sqlite3` 查不到（踩过一次，代价不小）。
 * 用例自己用唯一标题隔离，不依赖「空库」这个前提。
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // 用系统 chromium，不额外下 200MB 的浏览器包
    launchOptions: { executablePath: process.env['E2E_CHROME'] ?? '/usr/bin/chromium' },
    trace: 'off'
  },
  webServer: {
    // 先构建前端：e2e 打的是 dist，旧包会让新界面的用例假失败
    command: `npm run build && node apps/server/src/main.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...serverEnv(),
      HUB_PORT: String(port),
      HUB_DATA_DIR: dataDir,
      // 组件安装 e2e 的假 npm registry（e2e/components.spec.ts 在这个端口上起）
      HUB_NPM_REGISTRY: 'http://127.0.0.1:17981',
      // 开 PR 的 token 路径打这个假 GitHub API（e2e/git-commit-push-pr.spec.ts 在这个端口上起）
      HUB_GITHUB_API: 'http://127.0.0.1:17982',
      HUB_SPAWN_WORKER: '1',
      // 整套 e2e 在一个服务里登录十几次，放宽登录限流，免得后面的用例吃 429
      HUB_LOGIN_RATE_MAX: '1000',
      // 52 条共用一个回环地址。生产默认仍是 10 次 / 10 分钟，这里只放宽测试进程。
      HUB_ENROLL_RATE_MAX: '1000',
      HUB_MAIL_RATE_MAX: '1000',
      // 发信走日志模式，同时把信逐行写进 outbox：用例从这里拿验证 / 重置链接
      HUB_MAIL_PROVIDER: 'log',
      HUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
      HUB_MAIL_OUTBOX: `${dataDir}/outbox.jsonl`,
      // 本机 Worker 只放开 /tmp：目录选择器的新建文件夹、托管目录都落在这里，不碰真实家目录
      WORKER_ROOTS: '/tmp',
      // 测试账号的密码文件放进 e2e 数据目录，不碰真实的 ~/.config/agent-hub
      HUB_TEST_ACCOUNT_FILE: `${dataDir}/test-account`,
      // 本机 Worker 的资产目录也放进 e2e 数据目录，不碰真实的 ~/.agent-hub/assets
      WORKER_ASSETS_DIR: `${dataDir}/worker-assets`,
      // 本机 Worker 不做模型自检：e2e 不该真去调模型（自检有专门的用例，用假 ACP agent）
      WORKER_MODEL_CHECK: '0'
    }
  }
});
