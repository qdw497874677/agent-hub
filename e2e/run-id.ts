import { readFileSync } from 'node:fs';

/**
 * 一次 `playwright test` 的 run id。
 *
 * 不能在用例文件顶层写 `Date.now()`：Playwright 会为失败后的用例重启 worker 进程，
 * 模块因此被重新求值，第二条用例会拿到一个新的名字，然后去找一个不存在的项目——
 * 上一次就是这么超时了四次。globalSetup 只跑一次，把 id 写在文件里，各方都读它。
 */
export const RUN_FILE = '/tmp/agent-hub-e2e-run';

export function currentRun(): string {
  try {
    return readFileSync(RUN_FILE, 'utf8').trim();
  } catch {
    return Date.now().toString(36);
  }
}
