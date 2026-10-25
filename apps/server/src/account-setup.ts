import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AccountDeps } from '@agent-hub/domain';
import { seedAccount } from '@agent-hub/domain';

const DAY = 24 * 60 * 60 * 1000;

/**
 * 旧 HUB_TOKEN 的过渡期：从第一次在账号版里见到它算起 N 天（默认 30）。
 * 起点记在数据目录里，重启不会续命。
 */
export async function hubTokenWindow(
  dataDir: string,
  token: string | null,
  days: number,
  now: number
): Promise<{ value: string; until: number } | null> {
  if (token === null) return null;
  const file = join(dataDir, 'hub-token-since');
  let since = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  if (!Number.isFinite(since) || since <= 0) {
    since = now;
    await writeFile(file, String(since), { mode: 0o600 });
  }
  const until = since + days * DAY;
  return now < until ? { value: token, until } : null;
}

/**
 * 内置测试账号：给了 options.password（HUB_TEST_ACCOUNT_PASSWORD）就用它，每次启动对齐并写进密码文件；
 * 否则密码随机生成，只写进 mode 600 的文件，绝不打日志。
 * 文件已存在就沿用里面的密码（并把账号对齐到它），所以重启不会换密码。
 */
export async function seedTestAccount(
  accounts: AccountDeps,
  options: { email: string; passwordFile: string; password?: string },
  log: (line: string) => void
): Promise<void> {
  const fixed = options.password !== undefined && options.password.length > 0 ? options.password : null;
  let password = fixed ?? (await readFile(options.passwordFile, 'utf8').catch(() => '')).trim();
  if (fixed !== null || password.length < 10) {
    if (fixed === null) password = randomBytes(18).toString('base64url');
    await mkdir(dirname(options.passwordFile), { recursive: true, mode: 0o700 });
    await writeFile(options.passwordFile, `${password}\n`, { mode: 0o600 });
  }
  await chmod(options.passwordFile, 0o600);
  const seeded = await seedAccount(accounts, {
    email: options.email,
    password,
    role: 'owner',
    displayName: '测试账号',
    operatorChosen: fixed !== null
  });
  if (!seeded.ok) log(`内置测试账号没建成：${seeded.error.message}`);
  else log(`内置测试账号：${seeded.value.email}（密码在 ${options.passwordFile}）`);
}
