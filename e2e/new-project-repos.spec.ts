import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 新建项目 · 多仓库（docs/design/multi-repo.md）：
 * - 0 / 1 / 多行都能建；行可增删；主仓库可切换，删掉主仓库会清掉选择；
 * - 每行有自己的默认分支和访问令牌，创建请求只发 repos / primaryRepoId；
 * - 令牌在界面上是密码框，服务端响应和页面文字都不回显明文；
 * - 地址里带账号 / 密码会被挡在客户端，不发创建请求；
 * - 刷新后从服务端读回来，仓库、分支、主仓库都还在。
 */
const RUN = currentRun();

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('complementary', { name: '首页侧栏' }).getByTitle('新建项目').click();
  return page.getByRole('region', { name: '新建项目' });
}

test('新建项目：两个仓库各自分支、主仓库、令牌只写不回；刷新后仍在', async ({ page }) => {
  await loginByApi(page);
  const panel = await open(page);
  const token = `e2e-secret-${RUN}-token`;
  await panel.getByLabel('项目名').fill(`e2e-repos-${RUN}`);
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();

  // 第一行：HTTPS + 独立分支 + 私有仓库令牌
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 名称').fill('api');
  await panel.getByLabel('仓库 1 地址').fill('https://example.com/acme/api.git');
  await panel.getByLabel('仓库 1 默认分支').fill('develop');
  const tokenInput = panel.getByLabel('仓库 1 访问令牌');
  await tokenInput.fill(token);
  // 凭据必须遮住；值仍然按输入框提交给服务端
  await expect(tokenInput).toHaveAttribute('type', 'password');
  await expect(tokenInput).toHaveValue(token);

  // 第二行：scp 写法 + 带斜杠的分支
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 2 名称').fill('web');
  await panel.getByLabel('仓库 2 地址').fill('git@example.com:acme/web.git');
  await panel.getByLabel('仓库 2 默认分支').fill('release/next');

  // 第三行用来验证「删除行」和「删掉主仓库会清掉选择」
  await panel.getByTestId('new-project-add-repo').click();
  await expect(panel.getByTestId('new-project-repo-row')).toHaveCount(3);
  await panel.getByTestId('new-project-repo-primary').nth(2).click();
  await expect(panel.getByTestId('new-project-repo-primary').nth(2)).toHaveAttribute('aria-pressed', 'true');
  await panel.getByTestId('new-project-repo-remove').nth(2).click();
  await expect(panel.getByTestId('new-project-repo-row')).toHaveCount(2);
  await expect(panel.getByTestId('new-project-repo-primary-badge')).toHaveCount(0);

  // 主仓库选第二行
  await panel.getByTestId('new-project-repo-primary').nth(1).click();
  await expect(panel.getByTestId('new-project-repo-primary-badge')).toHaveCount(1);

  // 折叠后的摘要只说个数和名字，绝不预览地址 / 令牌
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  const summary = panel.getByTestId('new-project-repos-summary');
  await expect(summary).toContainText('2 个');
  await expect(summary).toContainText('api');
  await expect(summary).toContainText('web');
  await expect(summary).not.toContainText('example.com');
  await expect(summary).not.toContainText(token);

  const created = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: '创建' }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const sent = response.request().postDataJSON() as {
    repos: Array<Record<string, unknown>>;
    primaryRepoId?: string | null;
    repoUrl?: unknown;
    defaultBranch?: unknown;
  };
  const body = (await response.json()) as {
    id: string;
    repos: Array<{ id: string; name: string; url: string; defaultBranch: string | null; hasToken?: boolean }>;
    primaryRepoId?: string | null;
  };

  // 请求：两条独立快照，主仓库指向第二行；老字段一个都不带
  expect(sent.repos).toHaveLength(2);
  expect(sent.repos[0]).toMatchObject({
    name: 'api',
    url: 'https://example.com/acme/api.git',
    defaultBranch: 'develop',
    credential: token
  });
  expect(sent.repos[1]).toMatchObject({
    name: 'web',
    url: 'git@example.com:acme/web.git',
    defaultBranch: 'release/next'
  });
  expect(sent.repos[0]?.['id']).toMatch(/^repo_new_/);
  expect(sent.repos[1]?.['id']).toMatch(/^repo_new_/);
  expect(sent.primaryRepoId).toBe(sent.repos[1]?.['id']);
  expect(sent).not.toHaveProperty('repoUrl');
  expect(sent).not.toHaveProperty('defaultBranch');

  // 响应：令牌只回 hasToken，明文不出现在 JSON / 页面里
  expect(body.repos).toHaveLength(2);
  expect(body.primaryRepoId).toBe(body.repos[1]?.id);
  expect(body.repos.map((repo) => repo.name)).toEqual(['api', 'web']);
  expect(body.repos[0]?.defaultBranch).toBe('develop');
  expect(body.repos[1]?.defaultBranch).toBe('release/next');
  expect(body.repos[0]?.hasToken).toBe(true);
  expect(JSON.stringify(body)).not.toContain(token);
  expect(await page.locator('body').innerText()).not.toContain(token);

  // 刷新后从服务端读回来：设置页里两条仓库、各自分支、第二行是主仓库
  await page.goto(`/#/p/${body.id}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();
  await page.getByTitle('项目设置').first().click();
  await page.getByRole('tab', { name: '代码与工作目录' }).click();
  const settings = page.getByTestId('project-repos');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('repo-row')).toHaveCount(2);
  await expect(settings.getByTestId('repo-name').nth(0)).toHaveValue('api');
  await expect(settings.getByTestId('repo-url').nth(0)).toHaveValue('https://example.com/acme/api.git');
  await expect(settings.getByTestId('repo-branch').nth(0)).toHaveValue('develop');
  await expect(settings.getByTestId('repo-name').nth(1)).toHaveValue('web');
  await expect(settings.getByTestId('repo-url').nth(1)).toHaveValue('git@example.com:acme/web.git');
  await expect(settings.getByTestId('repo-branch').nth(1)).toHaveValue('release/next');
  await expect(settings.getByTestId('repo-primary')).toHaveCount(1);
  await expect(settings.getByTestId('repo-row').nth(1).getByTestId('repo-primary')).toBeVisible();
  // 服务端不回明文：令牌框是空的，只留下「已配置」
  await expect(settings.getByTestId('repo-token').nth(0)).toHaveValue('');
  await expect(settings.getByTestId('repo-token').nth(0)).toHaveAttribute('placeholder', /已配置/);
  await expect(settings.getByTestId('repo-token').nth(1)).toHaveValue('');
  expect(await page.locator('body').innerText()).not.toContain(token);
});

test('新建项目：地址里带账号 / 密码会被挡住，折叠摘要也不预览地址', async ({ page }) => {
  await loginByApi(page);
  const panel = await open(page);
  await panel.getByLabel('项目名').fill(`e2e-repos-userinfo-${RUN}`);
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 名称').fill('secret');
  await panel.getByLabel('仓库 1 地址').fill('https://user:pass@example.com/acme/secret.git');

  // 即使输入框里是完整地址，折叠摘要也只说名字
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  const summary = panel.getByTestId('new-project-repos-summary');
  await expect(summary).toContainText('secret');
  await expect(summary).not.toContainText('user');
  await expect(summary).not.toContainText('pass@');
  await expect(summary).not.toContainText('example.com');

  let posted = false;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/projects') && request.method() === 'POST') posted = true;
  });

  // 展开后提交：被行内校验挡住，不发请求，并给出安全的替代做法
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  await panel.getByRole('button', { name: '创建' }).click();
  await expect(panel.getByTestId('new-project-repo-problem')).toContainText('地址里不要写账号、密码或令牌');
  await expect(panel.getByTestId('new-project-repo-problem')).toContainText('访问令牌');
  expect(posted).toBe(false);
  // 修正成不带 userinfo 的地址 + 令牌框，就可以正常提交
  await panel.getByLabel('仓库 1 地址').fill('https://example.com/acme/secret.git');
  await panel.getByLabel('仓库 1 访问令牌').fill(`token-${RUN}`);
  await expect(panel.getByTestId('new-project-repo-problem')).toHaveCount(0);
});
