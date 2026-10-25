import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export const TEST_EMAIL = 'test@agent-hub.local';
/** server 启动时生成、写进 e2e 数据目录的测试账号密码。 */
export const testPassword = (): string => readFileSync('/tmp/agent-hub-e2e-data/test-account', 'utf8').trim();

/** 走 API 登录：cookie 落在 page 的上下文里，后续页面直接是已登录状态。 */
export async function loginByApi(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', { data: { email: TEST_EMAIL, password: testPassword() } });
  if (!response.ok()) throw new Error(`测试账号登录失败：HTTP ${response.status()}`);
}
