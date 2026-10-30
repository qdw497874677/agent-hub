import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';

export const TEST_EMAIL = 'test@agent-hub.local';
/** server 启动时生成、写进 e2e 数据目录的测试账号密码。 */
export const testPassword = (): string => readFileSync('/tmp/agent-hub-e2e-data/test-account', 'utf8').trim();

/** 走 API 登录：cookie 落在 page 的上下文里，后续页面直接是已登录状态。 */
export async function loginByApi(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', { data: { email: TEST_EMAIL, password: testPassword() } });
  if (!response.ok()) throw new Error(`测试账号登录失败：HTTP ${response.status()}`);
}

const OUTBOX = '/tmp/agent-hub-e2e-data/outbox.jsonl';

/** 从日志模式的 outbox 里取发给某人的最新一封信里的链接（等它落盘，最多 5 秒）。 */
export async function mailedLink(email: string, kind: 'verify' | 'reset' | 'invite' = 'verify'): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(OUTBOX)) {
      const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        const mail = JSON.parse(line) as { to: string; text: string };
        const link = new RegExp(`https?://\\S+#/${kind}\\?token=[\\w-]+`).exec(mail.text)?.[0];
        if (mail.to === email && link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`outbox 里没有发给 ${email} 的 ${kind} 链接`);
}

/** 走 API 点验证链接：新注册的成员要先验证邮箱才能用。 */
export async function verifyByApi(request: APIRequestContext, email: string): Promise<void> {
  const token = new URL((await mailedLink(email)).replace('#/verify?', '?')).searchParams.get('token');
  const response = await request.post('/api/auth/verify-email', { data: { token } });
  if (!response.ok()) throw new Error(`验证邮箱失败：HTTP ${response.status()}`);
}

/**
 * ADR 0011：开放注册默认关。要自助注册的用例先用测试账号（hub 管理员）把它打开。
 * e2e 数据目录跨 run 保留，所以每个用到的文件都调一次，幂等。
 */
export async function openRegistration(baseURL: string | undefined): Promise<void> {
  const { request } = await import('@playwright/test');
  const admin = await request.newContext({ baseURL });
  try {
    const login = await admin.post('/api/auth/login', { data: { email: TEST_EMAIL, password: testPassword() } });
    if (!login.ok()) throw new Error(`测试账号登录失败：HTTP ${login.status()}`);
    const csrf = (await admin.storageState()).cookies.find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const saved = await admin.put('/api/admin/settings', { headers: { 'x-hub-csrf': csrf }, data: { openRegistration: true } });
    if (!saved.ok()) throw new Error(`打开注册失败：HTTP ${saved.status()}`);
  } finally {
    await admin.dispose();
  }
}
