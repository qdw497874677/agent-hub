import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { boxOf, expectNoHorizontalOverflow, expectNoOverlap, expectTouchTarget, type Box } from './hitbox.ts';

/**
 * 仓库的「检查」按钮（新建项目草稿 + 项目设置已保存行）：
 * - 只读：只发一行仓库的地址 / 分支 / 令牌，不保存、不创建、不 clone；
 * - 已保存但没改过的行也能查，带上数据库里的仓库 id，没填令牌就不带令牌；
 * - 结论写清是哪台机器、读到哪个分支；失败分类只转述后端，不自己猜；
 * - 地址 / 分支 / 令牌 / 机器一变，旧结论立刻消失，请求还在路上也一样；
 * - 机器可显式选；选了谁，请求就带谁。
 */
const RUN = currentRun();
const SHOTS = process.env['E2E_SCREENSHOTS'];

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
    diagnostic?: {
      id: string;
      stage: 'credential' | 'worker' | 'git' | 'branch';
      code:
        | 'credential_unavailable'
        | 'worker_unavailable'
        | 'http_401'
        | 'http_403'
        | 'authentication_unknown'
        | 'dns'
        | 'tls'
        | 'timeout'
        | 'network'
        | 'branch_missing'
        | 'unknown';
      transport: 'https' | 'ssh';
      durationMs: number;
      httpStatus?: 401 | 403;
    };
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
  const projectTree = page.getByTestId('project-sidebar');
  await expect(projectTree.getByRole('button', { name: '新建', exact: true })).toBeVisible();
  await projectTree.getByRole('button', { name: '项目设置' }).click();
  await page.getByRole('link', { name: '代码与工作目录', exact: true }).click();
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

test('失败诊断 · 窄屏用键盘展开，只显示受控字段；复制内容不含地址和令牌', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL ?? 'http://127.0.0.1:7896' });
  const token = `e2e-diagnostic-secret-${RUN}`;
  await page.route('**/api/repo-check', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        reply({
          results: [
            {
              name: 'api',
              url: REPO_URL,
              branch: 'dev',
              ok: false,
              defaultBranch: 'main',
              message: '服务器拒绝了这次访问（401），请检查令牌',
              failureKind: 'authentication',
              credentialSource: 'draft',
              diagnostic: {
                id: `repo-check-401-e2e-${RUN}`,
                stage: 'git',
                code: 'http_401',
                transport: 'https',
                durationMs: 412,
                httpStatus: 401
              }
            }
          ]
        })
      )
    })
  );

  const panel = await openNewProject(page);
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 地址').fill(REPO_URL);
  await panel.getByLabel('仓库 1 默认分支').fill('dev');
  await panel.getByLabel('仓库 1 访问令牌').fill(token);
  await panel.getByTestId('new-project-repo-check').click();

  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText('服务器拒绝了这次访问（401）');
  const toggle = panel.getByTestId('new-project-repo-check-result-diagnostic-toggle');
  const details = panel.getByTestId('new-project-repo-check-result-diagnostic-details');
  // 诊断默认收起，不抢失败结论的注意力
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(details).toHaveCount(0);

  // 窄屏上键盘可展开 / 收起
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toBeVisible();
  await expect(details).toContainText('Git 访问');
  await expect(details).toContainText('服务器返回 401（未授权）');
  await expect(details).toContainText('http_401');
  await expect(details).toContainText('412 毫秒');
  await expect(details).toContainText('omarchy');
  await expect(details).toContainText(`repo-check-401-e2e-${RUN}`);

  // 详情与页面文字都不带地址 / 令牌；主结论仍可读到后端那句话
  const panelText = await details.innerText();
  expect(panelText).not.toContain(REPO_URL);
  expect(panelText).not.toContain('acme/api');
  expect(panelText).not.toContain(token);

  await page.keyboard.press('Enter');
  await expect(details).toHaveCount(0);

  // 复制的是受控摘要，不是请求内容
  await page.keyboard.press('Enter');
  const copy = panel.getByTestId('new-project-repo-check-result-diagnostic-copy');
  await expect(copy).toHaveAttribute('aria-label', '复制诊断信息');
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`编号：repo-check-401-e2e-${RUN}`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.startsWith('仓库检查诊断')).toBe(true);
  expect(copied).toContain(`编号：repo-check-401-e2e-${RUN}`);
  expect(copied).toContain('原因：服务器返回 401（未授权）');
  expect(copied).toContain('代码：http_401');
  expect(copied).not.toContain(REPO_URL);
  expect(copied).not.toContain(token);
  expect(await page.locator('body').innerText()).not.toContain(token);

  // 展开后的详情不撑破窄屏卡片
  const rowBox = await panel.getByTestId('new-project-repo-row').boundingBox();
  expect(rowBox?.width ?? 0).toBeLessThanOrEqual(390);
});

test('失败诊断 · 剪贴板不可用或被拒绝时展开只读文本，选中同一段安全内容', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // 部署在普通 HTTP 的非 loopback 地址上时，navigator.clipboard 根本不存在
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await loginByApi(page);
  const token = `e2e-manual-secret-${RUN}`;
  const diagnosticId = `repo-check-manual-${RUN}`;
  await page.route('**/api/repo-check', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        reply({
          results: [
            {
              name: 'api',
              url: REPO_URL,
              branch: 'dev',
              ok: false,
              defaultBranch: 'main',
              message: '服务器返回 401，请检查令牌',
              failureKind: 'authentication',
              credentialSource: 'draft',
              diagnostic: {
                id: diagnosticId,
                stage: 'git',
                code: 'http_401',
                transport: 'https',
                durationMs: 412,
                httpStatus: 401
              }
            }
          ]
        })
      )
    })
  );

  const panel = await openNewProject(page);
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 地址').fill(REPO_URL);
  await panel.getByLabel('仓库 1 默认分支').fill('dev');
  await panel.getByLabel('仓库 1 访问令牌').fill(token);
  await panel.getByTestId('new-project-repo-check').click();

  const toggle = panel.getByTestId('new-project-repo-check-result-diagnostic-toggle');
  await toggle.click();
  const copy = panel.getByTestId('new-project-repo-check-result-diagnostic-copy');
  // 窄屏上复制按钮是 44px 的点击目标
  const copyBox = await copy.boundingBox();
  expect(copyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await copy.click();

  // 不假装复制成功：给出说明 + 只读文本，并把内容选中
  const manual = panel.getByTestId('new-project-repo-check-result-diagnostic-manual');
  const textarea = panel.getByTestId('new-project-repo-check-result-diagnostic-manual-text');
  await expect(manual).toContainText('没法写入剪贴板');
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveAttribute('readonly', '');
  const expected = [
    '仓库检查诊断',
    `编号：${diagnosticId}`,
    '阶段：Git 访问',
    '原因：服务器返回 401（未授权）',
    '代码：http_401',
    '传输：HTTPS',
    '耗时：412 毫秒',
    'HTTP 状态：401',
    '机器：omarchy',
    '凭据：这次用的是填写的令牌'
  ].join('\n');
  await expect(textarea).toHaveValue(expected);
  const selected = await textarea.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    return { start: field.selectionStart, end: field.selectionEnd, length: field.value.length };
  });
  expect(selected).toEqual({ start: 0, end: expected.length, length: expected.length });
  // 选中内容只有受控摘要
  expect(expected).not.toContain(REPO_URL);
  expect(expected).not.toContain(token);

  // 浏览器有剪贴板接口但权限被拒：同样落到手动复制，而不是静默失败
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }
    });
  });
  await copy.click();
  await expect(panel.getByTestId('new-project-repo-check-result-diagnostic-manual')).toHaveCount(1);
  await expect(textarea).toHaveValue(expected);
  await expect(textarea).toBeFocused();
  expect(await page.locator('body').innerText()).not.toContain(token);
});

test('失败诊断 · 旧后端不带 diagnostic 时只显示原结论，不出现空的诊断入口', async ({ page }) => {
  await loginByApi(page);
  await page.route('**/api/repo-check', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        reply({
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
        })
      )
    })
  );

  const panel = await openNewProject(page);
  await panel.getByTestId('new-project-add-repo').click();
  await panel.getByLabel('仓库 1 地址').fill(REPO_URL);
  await panel.getByLabel('仓库 1 默认分支').fill('dev');
  await panel.getByTestId('new-project-repo-check').click();

  await expect(panel.getByTestId('new-project-repo-check-result')).toContainText('认证失败');
  await expect(panel.getByTestId('new-project-repo-check-result-diagnostic-toggle')).toHaveCount(0);
  await expect(panel.getByTestId('new-project-repo-check-result-diagnostic')).toHaveCount(0);
});

test('手机触控目标 · 项目页头与仓库检查/删除是分开的 44×44，桌面仍紧凑', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const headers = await csrfHeaders(page, baseURL ?? '');
  const project = (await (
    await page.request.post('/api/projects', {
      data: {
        name: `e2e 触控目标 ${RUN}`,
        repos: [{ name: 'api', url: REPO_URL, defaultBranch: 'main' }]
      },
      headers
    })
  ).json()) as { id: string };

  await page.route(`**/api/projects/${project.id}/repos/check`, (route) =>
    route.fulfill({
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
    })
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}`);
  await page.reload();
  const mobileHeader = page.locator('header').filter({ has: page.locator('button[aria-label="打开侧栏"]') });
  await expect(mobileHeader).toBeVisible();
  const viewSwitch = mobileHeader.getByTestId('view-switch');
  const targets = [
    ['打开侧栏', mobileHeader.getByRole('button', { name: '打开侧栏' })],
    ['画布', viewSwitch.getByRole('button', { name: '画布', exact: true })],
    ['列表', viewSwitch.getByRole('button', { name: '列表', exact: true })],
    ['全局菜单', mobileHeader.getByRole('button', { name: '全局菜单' })]
  ] as const;
  const boxes: Array<{ label: string; box: Box }> = [];
  for (const [label, target] of targets) {
    boxes.push({ label, box: await expectTouchTarget(target, label, 390) });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      expectNoOverlap(a.box, b.box, `${a.label} 与 ${b.label}`);
    }
  }
  await expectNoHorizontalOverflow(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/project-header-390.png` });

  // 视图切换本身仍然工作，不是只会显示更大的图标。
  await viewSwitch.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.id}/list`));
  await expect(viewSwitch.getByRole('button', { name: '列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await viewSwitch.getByRole('button', { name: '画布', exact: true }).click();

  await page.setViewportSize({ width: 320, height: 700 });
  const narrowBoxes: Array<{ label: string; box: Box }> = [];
  for (const [label, target] of targets) {
    narrowBoxes.push({ label, box: await expectTouchTarget(target, `${label}（320）`, 320) });
  }
  for (let i = 0; i < narrowBoxes.length; i++) {
    for (let j = i + 1; j < narrowBoxes.length; j++) {
      const a = narrowBoxes[i]!;
      const b = narrowBoxes[j]!;
      expectNoOverlap(a.box, b.box, `${a.label} 与 ${b.label}（320）`);
    }
  }
  await expectNoHorizontalOverflow(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/project-header-320.png` });

  // 搜索与新建移入项目抽屉；在两种窄屏下仍能触达且不横溢。
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 844 });
    await mobileHeader.getByRole('button', { name: '打开侧栏' }).click();
    const drawer = page.getByTestId('nav-sheet');
    await expect(drawer).toBeVisible();
    await expectTouchTarget(drawer.getByRole('button', { name: '搜索', exact: true }), '项目搜索', width);
    await expectTouchTarget(drawer.getByRole('button', { name: '新建', exact: true }), '新建菜单', width);
    await expectTouchTarget(drawer.getByRole('button', { name: '项目设置' }), '项目设置', width);
    await drawer.getByRole('button', { name: '新建', exact: true }).click();
    await expect(drawer.getByRole('menuitem', { name: '新建任务' })).toBeVisible();
    await expect(drawer.getByRole('menuitem', { name: '新开主会话' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await drawer.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(drawer).toHaveCount(0);
  }

  // 从手机抽屉进项目设置；已保存仓库行上的检查和删除各自是 44×44。
  await page.setViewportSize({ width: 390, height: 844 });
  await mobileHeader.getByRole('button', { name: '打开侧栏' }).click();
  const sheet = page.getByTestId('nav-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: '项目设置' }).click();
  await page.getByRole('button', { name: '返回设置目录' }).click();
  await page.getByRole('link', { name: '代码与工作目录', exact: true }).click();
  const settings = page.getByTestId('project-repos');
  await expect(settings.getByTestId('repo-row')).toHaveCount(1);

  const check = settings.getByTestId('repo-check').first();
  const remove = settings.getByTestId('repo-remove').first();
  const checkBox = await expectTouchTarget(check, '仓库检查', 390);
  const removeBox = await expectTouchTarget(remove, '仓库删除', 390);
  expectNoOverlap(checkBox, removeBox, '仓库检查与删除');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repo-actions-390.png` });

  // 实际点检查：请求真的发出，结论落在这一行。
  await check.click();
  await expect(settings.getByTestId('repo-check-result').first()).toContainText('可读取');
  await expect(settings.getByTestId('repo-check-result').first()).toContainText('默认分支是 main');

  // 独立临时行验证删除：只删草稿行，原有已保存行不动。
  await settings.getByTestId('repo-add').click();
  await expect(settings.getByTestId('repo-row')).toHaveCount(2);
  await settings.getByTestId('repo-remove').nth(1).click();
  await expect(settings.getByTestId('repo-row')).toHaveCount(1);
  await expect(settings.getByTestId('repo-name').first()).toHaveValue('api');
  await expect(settings.getByTestId('repo-url').first()).toHaveValue(REPO_URL);

  await page.setViewportSize({ width: 320, height: 700 });
  await settings.getByTestId('repo-row').first().scrollIntoViewIfNeeded();
  const check320 = await expectTouchTarget(settings.getByTestId('repo-check').first(), '仓库检查（320）', 320);
  const remove320 = await expectTouchTarget(settings.getByTestId('repo-remove').first(), '仓库删除（320）', 320);
  expectNoOverlap(check320, remove320, '仓库检查与删除（320）');
  await expectNoHorizontalOverflow(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repo-actions-320.png` });

  // 桌面回归：项目页头只出现投影条，仓库按钮回到紧凑行高。
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId('project-bar')).toBeVisible();
  await expect(mobileHeader).toBeHidden();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/project-header-1280.png` });
  await page.getByTitle('项目设置').first().click();
  await page.getByRole('link', { name: '代码与工作目录', exact: true }).click();
  const desktopSettings = page.getByTestId('project-repos');
  const desktopCheck = await boxOf(desktopSettings.getByTestId('repo-check').first(), '桌面仓库检查');
  const desktopRemove = await boxOf(desktopSettings.getByTestId('repo-remove').first(), '桌面仓库删除');
  expect(desktopCheck.height).toBeLessThan(44);
  expect(desktopRemove.height).toBeLessThan(44);
  expect(desktopCheck.x + desktopCheck.width).toBeLessThan(desktopRemove.x);
});
