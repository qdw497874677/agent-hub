import { test, expect, type Page, type Route } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 仓库的「检查」按钮（新建项目草稿 + 项目设置已保存行）：
 * - 只读：只发一行仓库的地址 / 分支 / 令牌，不保存、不创建、不 clone；
 * - 已保存但没改过的行也能查，带上数据库里的仓库 id，没填令牌就不带令牌；
 * - 结论写清是哪台机器、读到哪个分支；失败分类只转述后端，不自己猜；
 * - 地址 / 分支 / 令牌 / 机器一变，旧结论立刻消失，请求还在路上也一样；
 * - 机器可显式选；选了谁，请求就带谁。
 */
const RUN = currentRun();

const REPO_URL = 'https://example.com/acme/api.git';

type ProbeReply = {
  workerId: string | null;
  workerLabel: string | null;
  unavailable: string | null;
  credentialSource?: 'draft' | 'saved' | 'worker' | null;
  results: Array<{
    name: string;
    url: string;
    branch: string | null;
    ok: boolean;
    defaultBranch: string | null;
    message: string | null;
    failureKind?: 'authentication' | 'branch_missing' | 'unreachable' | 'credential_unavailable' | null;
    credentialSource?: 'draft' | 'saved' | 'worker' | null;
  }>;
};

function reply(over: Partial<ProbeReply> = {}): ProbeReply {
  return {
    workerId: 'remote-b',
    workerLabel: 'omarchy',
    unavailable: null,
    credentialSource: 'draft',
    results: [
      {
        name: 'api',
        url: REPO_URL,
        branch: 'dev',
        ok: true,
        defaultBranch: 'main',
        message: null,
        failureKind: null,
        credentialSource: 'draft'
      }
    ],
    ...over
  };
}

async function openNewProject(page: Page) {
  await page.goto('/');
  await page.getByRole('complementary', { name: '首页侧栏' }).getByTitle('新建项目').click();
  const panel = page.getByRole('region', { name: '新建项目' });
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  return panel;
}

/** 两台在线机器：选择器才会出现，验证显式选机器后 workerId 真的发出去。 */
async function mockTwoWorkers(page: Page) {
  await page.route('**/api/workers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          workerId: 'local-a',
          label: 'hub-a',
          origin: 'local',
          state: 'online',
          agentIds: [],
          agentModels: {},
          capabilities: ['git']
        },
        {
          workerId: 'remote-b',
          label: 'omarchy',
          origin: 'remote',
          state: 'online',
          agentIds: [],
          agentModels: {},
          capabilities: ['git']
        }
      ])
    })
  );
}

function isSaveRequest(request: { url(): string; method(): string }) {
  const url = new URL(request.url());
  return request.method() === 'POST' && url.pathname === '/api/projects';
}

async function csrfHeaders(page: Page, baseURL: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

test('新建项目 · 单行检查走草稿接口：显式选机器、只发这一行、不保存；改地址 / 换机器 / 请求在途都清掉旧结论', async ({
  page,
  baseURL
}) => {
  await loginByApi(page);
  await mockTwoWorkers(page);
  let saves = 0;
  page.on('request', (request) => {
    if (isSaveRequest(request)) saves += 1;
  });

  let count = 0;
  const payloads: unknown[] = [];
  let response = reply();
  await page.route('**/api/repo-check', async (route) => {
    count += 1;
    payloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  const panel = await openNewProject(page);
  await panel.getByLabel('项目名').fill(`e2e-repo-check-${RUN}`);
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 名称').fill('api');
  await panel.getByLabel('仓库 1 地址').fill(REPO_URL);
  await panel.getByLabel('仓库 1 默认分支').fill('dev');
  const token = `e2e-check-secret-${RUN}`;
  await panel.getByLabel('仓库 1 访问令牌').fill(token);

  // 公开仓库能读 ≠ 令牌被接受：这条提示必须一直在
  await expect(panel.getByTestId('repo-probe-hint')).toContainText('公开仓库不校验令牌');
  // 两台机器：可以显式选远程那台
  const machine = panel.getByRole('radiogroup', { name: '在哪台机器上检查' });
  await expect(machine).toBeVisible();
  await machine.getByRole('radio', { name: /omarchy/ }).click();
  await expect(machine.getByRole('radio', { name: /omarchy/ })).toHaveAttribute('aria-checked', 'true');

  await panel.getByTestId('new-project-repo-check').click();
  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText(
    '在 omarchy 上，可读取，分支 dev 存在 · 这次用的是填写的令牌'
  );
  await expect(panel.getByTestId('new-project-repo-check')).toBeEnabled();

  expect(count).toBe(1);
  const sent = payloads[0] as { repos: Array<Record<string, unknown>>; workerId?: string };
  expect(sent.repos).toHaveLength(1);
  expect(sent.repos[0]).toMatchObject({
    name: 'api',
    url: REPO_URL,
    defaultBranch: 'dev',
    credential: token
  });
  expect(sent.repos[0]?.['id']).toMatch(/^repo_new_/);
  expect(sent.workerId).toBe('remote-b');
  // 检查按钮绝不该顺手建项目
  expect(saves).toBe(0);
  expect(response.results[0]?.credentialSource).toBe('draft');
  // 令牌只在密码框里，不进页面文字
  expect(await page.locator('body').innerText()).not.toContain(token);

  // 后端说认证没过：原样转述，不自己编「令牌无效」
  response = reply({
    results: [
      {
        name: 'api',
        url: REPO_URL,
        branch: 'dev',
        ok: false,
        defaultBranch: 'main',
        message: '认证失败：请检查仓库地址、令牌，或这台机器上的凭据',
        failureKind: 'authentication',
        credentialSource: 'draft'
      }
    ]
  });
  await panel.getByTestId('new-project-repo-check').click();
  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText(
    '在 omarchy 上，认证失败：请检查仓库地址、令牌，或这台机器上的凭据'
  );

  // 改分支 → 上一轮结论立刻消失
  await panel.getByLabel('仓库 1 默认分支').fill('release/next');
  await expect(panel.getByTestId('new-project-repo-check-result')).toHaveCount(0);

  // 请求还在路上时改地址：晚到的响应必须被丢掉，按钮也不能重复点
  await page.unroute('**/api/repo-check');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gatedCount = 0;
  await page.route('**/api/repo-check', async (route: Route) => {
    gatedCount += 1;
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply()) });
  });
  await panel.getByTestId('new-project-repo-check').click();
  await expect(panel.getByTestId('new-project-repo-check')).toBeDisabled();
  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText('正在读取仓库');
  const completed = page.waitForResponse('**/api/repo-check');
  await panel.getByLabel('仓库 1 地址').fill('https://example.com/acme/other.git');
  release();
  await completed;
  await expect(panel.getByTestId('new-project-repo-check-result')).toHaveCount(0);
  await expect(panel.getByTestId('new-project-repo-check')).toBeEnabled();
  expect(gatedCount).toBe(1);

  // 请求在途时换机器同理：旧机器上的结论不能挂到新机器名下
  await page.unroute('**/api/repo-check');
  let releaseMachine: () => void = () => undefined;
  const machineGate = new Promise<void>((resolve) => {
    releaseMachine = resolve;
  });
  await page.route('**/api/repo-check', async (route) => {
    await machineGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply()) });
  });
  await panel.getByTestId('new-project-repo-check').click();
  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText('正在读取仓库');
  await machine.getByRole('radio', { name: /hub-a/ }).click();
  const machineDone = page.waitForResponse('**/api/repo-check');
  releaseMachine();
  await machineDone;
  await expect(panel.getByTestId('new-project-repo-check-result')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(token);
});

test('项目设置 · 已保存但没改过的行也能检查：带 id、不带令牌、不发保存请求', async ({ page, baseURL }) => {
  await loginByApi(page);
  const headers = await csrfHeaders(page, baseURL ?? '');
  const created = await page.request.post('/api/projects', {
    data: {
      name: `e2e-repo-check-saved-${RUN}`,
      repos: [{ name: 'api', url: REPO_URL, defaultBranch: 'main' }]
    },
    headers
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; repos: Array<{ id: string; name: string; url: string }> };
  const saved = project.repos[0];
  expect(saved?.id).toBeTruthy();

  let saves = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/projects/${project.id}`) saves += 1;
  });
  let payload: { repos: Array<Record<string, unknown>>; workerId?: string } | undefined;
  await page.route(`**/api/projects/${project.id}/repos/check`, async (route) => {
    payload = route.request().postDataJSON() as typeof payload;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        reply({
          workerId: null,
          workerLabel: 'hub 本机',
          credentialSource: 'saved',
          results: [
            {
              name: 'api',
              url: REPO_URL,
              branch: null,
              ok: true,
              defaultBranch: 'main',
              message: null,
              failureKind: null,
              credentialSource: 'saved'
            }
          ]
        })
      )
    });
  });

  await page.goto(`/#/p/${project.id}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();
  await page.getByTitle('项目设置').first().click();
  await page.getByRole('tab', { name: '代码与工作目录' }).click();
  const settings = page.getByTestId('project-repos');
  await expect(settings.getByTestId('repo-row')).toHaveCount(1);

  // 一个字都不改，直接检查
  await settings.getByTestId('repo-check').click();
  await expect(settings.getByTestId('repo-check-result')).toContainText(
    '在 hub 本机 上，可读取，默认分支是 main · 这次用的是已保存的令牌'
  );

  expect(payload?.repos).toHaveLength(1);
  // 已保存行带数据库 id；没输入新令牌，就绝不把空令牌发出去
  expect(payload?.repos[0]).toMatchObject({ id: saved?.id, name: 'api', url: REPO_URL, defaultBranch: 'main' });
  expect(payload?.repos[0]).not.toHaveProperty('credential');
  expect(payload).not.toHaveProperty('workerId');
  expect(saves).toBe(0);
  await expect(settings.getByTestId('repos-save')).toBeDisabled();
});

test('手机宽度 · 行内检查按钮和结论都看得见，不撑破卡片', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.route('**/api/repo-check', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply()) })
  );
  const panel = await openNewProject(page);
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 地址').fill(REPO_URL);
  await panel.getByLabel('仓库 1 默认分支').fill('dev');
  const button = panel.getByTestId('new-project-repo-check');
  await expect(button).toBeVisible();
  await button.click();
  const result = panel.getByTestId('new-project-repo-check-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('可读取，分支 dev 存在');

  const rowBox = await panel.getByTestId('new-project-repo-row').boundingBox();
  expect(rowBox?.width ?? 0).toBeLessThanOrEqual(390);
});
