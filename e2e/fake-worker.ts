import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * e2e 的确定性 agent：一个只装了假 ACP 的远端 Worker（enroll + spawn，和 attention / 检查点用例同一套办法）。
 *
 * 为什么不用本机 Worker 的 pi：pi 的就绪探测要真起进程、20 秒超时，结果还会按 `probeIntervalMs`（默认 5 分钟）
 * 缓存；机器忙的时候探测超时，`POST /api/sessions/derive` 直接 503，看起来像接口坏了。项目授权、派工这些
 * 用例只需要「会话真的建起来了」，不需要真模型，所以固定在假 ACP 上，不受宿主机负载影响。
 *
 * 一个 spec 文件共用一个 Worker（Playwright 在这套配置里 workers: 1），`test.afterAll` 里调 `stopFakeWorker()`。
 */
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

export const FAKE_AGENT_ID = 'fakeacp';

interface Running {
  readonly workerId: string;
  readonly dir: string;
  readonly process: ChildProcess;
}

let running: Running | null = null;

const isOnline = async (page: Page, workerId: string): Promise<boolean> => {
  const response = await page.request.get('/api/workers');
  if (!response.ok()) return false;
  const workers = (await response.json()) as Array<{ workerId?: string; id?: string; state: string }>;
  return workers.some((worker) => (worker.workerId ?? worker.id) === workerId && worker.state === 'online');
};

/**
 * 拿到本文件里可用的假 ACP Worker id。第一次调用会登记 + 起进程，之后复用；
 * Worker 掉线就重新起一个（不重试「等它准备好」—— 它不依赖任何外部探测）。
 */
export async function ensureFakeWorker(page: Page, baseURL: string, agentId: string = FAKE_AGENT_ID): Promise<string> {
  if (running !== null) {
    if (running.process.exitCode === null && (await isOnline(page, running.workerId))) return running.workerId;
    stopFakeWorker();
  }

  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  if (!pairing.ok()) throw new Error(`申请配对码失败：HTTP ${pairing.status()} ${await pairing.text()}`);
  const code = ((await pairing.json()) as { code: string }).code;

  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 假 ACP 机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  if (enrolled.status !== 0) throw new Error(`Worker 登记失败：${enrolled.stderr || enrolled.stdout}`);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  if (workerId === '' || credential === '') throw new Error('Worker 登记没有回 workerId / 凭据');

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-fake-'));
  const child = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH,
      HOME: state,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential,
      WORKER_ID: workerId,
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: state,
      WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
      WORKER_MODEL_CHECK: '0',
      ACP_AGENTS: JSON.stringify([
        { id: agentId, label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }
      ])
    },
    stdio: 'ignore'
  });
  running = { workerId, dir: state, process: child };

  for (let i = 0; i < 120; i++) {
    if (await isOnline(page, workerId)) return workerId;
    if (child.exitCode !== null) break;
    await page.waitForTimeout(250);
  }
  stopFakeWorker();
  throw new Error('假 ACP Worker 没能在 30 秒内上线（看 apps/worker/src/main.ts 的启动错误）');
}

/** 关掉假 ACP Worker 并清掉它的状态目录。没起过就什么都不做。 */
export function stopFakeWorker(): void {
  if (running === null) return;
  const { process, dir } = running;
  running = null;
  try {
    process.kill('SIGTERM');
  } catch {
    /* 已经退了 */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 目录被 Worker 自己清掉了也无所谓 */
  }
}
