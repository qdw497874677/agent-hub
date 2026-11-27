import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { currentRun } from './run-id.ts';

// Only the browser-facing broker endpoint is faked; project creation and navigation use the test Hub.
const REPO_URL = 'https://example.com/acme/api.git';
const SYNTHETIC_SECRET = 'synthetic-test-only-not-a-real-token';

async function seed(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value;
  expect(csrf).toBeTruthy();
  const response = await page.request.post('/api/projects', {
    headers: { origin: baseURL, 'x-hub-csrf': csrf! },
    data: { name: `e2e-hub-credential-${currentRun()}`, repos: [{ name: 'api', url: REPO_URL, defaultBranch: 'main' }] }
  });
  expect(response.status(), await response.text()).toBe(201);
  const project = await response.json() as { id: string; repos: Array<{ id: string }> };
  expect(project.repos[0]?.id).toBeTruthy();
  return { projectId: project.id, repoId: project.repos[0]!.id };
}

async function openSettings(page: Page, projectId: string, mobile: boolean) {
  await page.goto(`/#/p/${projectId}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();
  if (mobile) {
    await page.locator('header').filter({ has: page.locator('button[aria-label="打开侧栏"]') }).getByRole('button', { name: '打开侧栏' }).click();
    await page.getByTestId('nav-sheet').getByRole('button', { name: '项目设置' }).click();
    await page.getByRole('button', { name: '返回设置目录' }).click();
  } else {
    await page.getByTitle('项目设置').first().click();
  }
  await page.getByTestId('settings-surface').getByRole('link', { name: '代码与工作目录', exact: true }).click();
  await expect(page.getByTestId('project-repos').getByTestId('repo-row')).toHaveCount(1);
}

for (const mobile of [false, true]) {
  test(`Hub 仓库凭证 · ${mobile ? '390px' : '桌面'}：未满足启用条件时隐藏，启用预览和写入状态`, async ({ page, baseURL }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { projectId, repoId } = await seed(page, baseURL!);
    const endpoint = `**/api/projects/${projectId}/repos/${repoId}/hub-credential`;
    // A real Hub without the isolation configuration must not expose management controls.
    const disabled = page.waitForResponse((response) => response.url().endsWith(`/repos/${repoId}/hub-credential`) && response.request().method() === 'GET');
    await openSettings(page, projectId, mobile);
    const disabledResponse = await disabled;
    expect(disabledResponse.status()).toBe(404);
    expect(await disabledResponse.json()).toMatchObject({ error: { code: 'not_found' } });
    await expect(page.getByTestId('hub-repo-credential')).toHaveCount(0);

    type Credential = { id: string; name: string; version: number };
    let binding: { credentialId: string; name: string; version: number } | null = null;
    let credentials: Credential[] = [{ id: 'existing', name: '共享只读', version: 3 }];
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createPayload: unknown;
    let rotatePayload: unknown;
    let revokePayload: unknown;
    await page.route(`${endpoint}**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === 'GET') return route.fulfill({ json: { binding, credentials } });
      if (path.endsWith('/create')) {
        createPayload = request.postDataJSON();
        await createGate;
        binding = { credentialId: 'new', name: '测试只读', version: 1 };
        credentials = [...credentials, { id: 'new', name: '测试只读', version: 1 }];
      } else if (path.endsWith('/rotate')) {
        rotatePayload = request.postDataJSON();
        binding = { credentialId: 'new', name: '测试只读', version: 2 };
        credentials = credentials.map((item) => item.id === 'new' ? { ...item, version: 2 } : item);
      } else if (path.endsWith('/revoke')) {
        revokePayload = request.postDataJSON();
        binding = null;
        credentials = credentials.filter((item) => item.id !== 'new');
      } else if (method === 'PUT') {
        binding = { credentialId: 'existing', name: '共享只读', version: 3 };
      } else if (method === 'DELETE') {
        binding = null;
      }
      return route.fulfill({ json: { ok: true } });
    });
    await page.reload();
    await openSettings(page, projectId, mobile);
    const card = page.getByTestId('hub-repo-credential');
    await expect(card).toContainText('尚未绑定');
    await card.getByLabel('选择已有凭证').selectOption('existing');
    await card.getByRole('button', { name: '绑定', exact: true }).click();
    await expect(card).toContainText('已绑定 共享只读');
    page.once('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: '解除绑定' }).click();
    await expect(card).toContainText('尚未绑定');

    await card.getByRole('button', { name: '新增并绑定' }).click();
    const form = page.getByTestId('hub-credential-form');
    await form.getByLabel('凭证名称').fill('测试只读');
    await form.getByLabel('凭证值').fill(SYNTHETIC_SECRET);
    await form.getByRole('button', { name: '确认保存' }).click();
    await expect(card).toContainText('处理中');
    await expect(card.getByRole('button', { name: '新增并绑定' })).toBeDisabled();
    await expect(form).toHaveCount(0);
    releaseCreate();
    await expect(card).toContainText('凭证已保存并绑定到此仓库');
    expect(createPayload).toEqual({ name: '测试只读', credential: SYNTHETIC_SECRET });
    await expect(page.locator('body')).not.toContainText(SYNTHETIC_SECRET);
    expect(await page.locator('input').evaluateAll((inputs) => inputs.some((input) => (input as HTMLInputElement).value === 'synthetic-test-only-not-a-real-token'))).toBe(false);
    await expect(card).toContainText('已绑定 测试只读');

    await page.getByTestId('repo-branch').fill('other');
    await expect(card).toContainText('有未保存的修改');
    await expect(card.getByRole('button', { name: '轮换凭证' })).toBeDisabled();
    await expect(card.getByRole('button', { name: '撤销共享凭证' })).toBeDisabled();
    await page.getByTestId('repo-branch').fill('main');
    await card.getByRole('button', { name: '轮换凭证' }).click();
    await form.getByLabel('凭证值').fill(SYNTHETIC_SECRET);
    page.once('dialog', (dialog) => dialog.accept());
    await form.getByRole('button', { name: '确认保存' }).click();
    await expect(card).toContainText('版本 2');
    expect(rotatePayload).toEqual({ credential: SYNTHETIC_SECRET, credentialId: 'new', version: 1 });
    page.once('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: '撤销共享凭证' }).click();
    await expect(card).toContainText('凭证已撤销');
    expect(revokePayload).toEqual({ credentialId: 'new', version: 2 });
  });
}
