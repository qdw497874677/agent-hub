import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * 内置资产：项目设置里一键启用 Playwright（不贴 JSON）→ 预览里没 Chromium 的机器标「需安装浏览器」
 * → 显式带上它派生会话 → 模型看到的工具清单里有 Playwright 的工具（本地假网关，不用付费模型）。
 * GitHub 要密钥：先弹出填密钥，填了才启用。桌面 + 手机截图。
 */
const RUN = currentRun().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
const SHOTS = process.env['E2E_SCREENSHOTS'];

let upstream: Server;
let gatewayPort = 0;
let seenTools: string[] = [];

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-1', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as { stream?: boolean; tools?: Array<{ function: { name: string } }> };
      seenTools = (body.tools ?? []).map((tool) => tool.function.name);
      const content = `TOOLS_SEEN ${seenTools.length}`;
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'm-1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant', content }, null);
      chunk({}, 'stop');
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  gatewayPort = (upstream.address() as { port: number }).port;
});

test.afterAll(() => {
  upstream?.closeAllConnections();
  upstream?.close();
});

async function openAssetsTab(page: Page, projectId: string) {
  await page.goto(`/#/p/${projectId}`);
  // 只改 hash 不会重载，上一次开的设置窗口还在；重载一次，从干净状态开
  await page.reload();
  // 窄屏侧栏是收起的，设置入口在里面；桌面与移动两份侧栏同时在 DOM 里，`:visible` 才点得到当前那份
  if ((page.viewportSize()?.width ?? 1280) <= 768) await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.locator('button[title="项目设置"]:visible').first().click();
  await page.getByRole('tab', { name: '资产' }).click();
  await expect(page.getByTestId('builtin-assets')).toBeVisible();
}

test('内置资产：一键启用 Playwright，缺浏览器的机器被标出，带上后会话工具清单里有它的工具', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  let workerId = '';
  for (let i = 0; i < 60 && !workerId; i++) {
    const overview = (await (await page.request.get('/api/admin/assets')).json()) as { workers: Array<{ workerId: string; label: string; state: string }> };
    workerId = (overview.workers.find((w) => w.state === 'online' && w.label === '本机') ?? overview.workers.find((w) => w.state === 'online'))?.workerId ?? '';
    if (!workerId) await page.waitForTimeout(500);
  }
  expect(workerId, '本机 Worker 必须在线').toBeTruthy();

  const dir = mkdtempSync(join(tmpdir(), 'e2e-builtin-'));
  const project = (await (await page.request.post('/api/projects', { headers, data: { name: `e2e builtin ${RUN}`, rootPath: dir } })).json()) as { id: string; name: string };
  const slug = `bi${RUN}`;
  let secretSaved = false;
  try {
    // —— 1. 项目设置 · 资产：内置清单，带「内置」标和来源 / 许可证 ——
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAssetsTab(page, project.id);
    const playwright = page.locator('[data-testid="builtin-asset"][data-id="playwright"]');
    await expect(playwright).toContainText('Playwright 浏览器');
    await expect(playwright.getByTestId('asset-builtin')).toBeVisible();
    await expect(playwright).toContainText('@playwright/mcp@0.0.85');
    await expect(playwright).toContainText('Apache-2.0');
    await expect(playwright.getByTestId('builtin-browser')).toBeVisible();
    if (SHOTS) await page.getByTestId('builtin-assets').screenshot({ path: join(SHOTS, 'builtin-list-1280.png') });

    // —— 2. 一键启用（不贴 JSON） ——
    await playwright.getByTestId('builtin-enable').click();
    await expect(playwright.getByTestId('builtin-enabled')).toBeVisible();
    await expect(page.locator('[data-testid="project-asset"][data-name="playwright"]').getByTestId('asset-builtin')).toBeVisible();

    // —— 3. 要密钥的：先填密钥才启用 ——
    const github = page.locator('[data-testid="builtin-asset"][data-id="github"]');
    const secretsBefore = (await (await page.request.get('/api/assets/secrets')).json()) as { team: { name: string }[] };
    const hadToken = secretsBefore.team.some((s) => s.name === 'GITHUB_TOKEN');
    if (!hadToken) {
      await github.getByTestId('builtin-enable').click();
      await expect(github.getByTestId('builtin-secrets')).toBeVisible();
      await expect(github.getByTestId('builtin-secret-save')).toBeDisabled();
      if (SHOTS) await page.getByTestId('builtin-assets').screenshot({ path: join(SHOTS, 'builtin-secret-1280.png') });
      await github.getByTestId('builtin-secret-input').fill(`ghp_e2e_fake_${RUN}`);
      await github.getByTestId('builtin-secret-save').click();
      secretSaved = true;
      await expect(github.getByTestId('builtin-enabled')).toBeVisible();
    }
    if (SHOTS) await page.getByTestId('builtin-assets').screenshot({ path: join(SHOTS, 'builtin-enabled-1280.png') });

    // —— 4. 派生前预览：没有 hub 装的 Chromium → 「需安装浏览器」（界面默认不勾） ——
    const plan = (await (await page.request.get(`/api/projects/${project.id}/assets?workerId=${encodeURIComponent(workerId)}`)).json()) as {
      entries: Array<{ assetId: string; name: string; kind: string; problem?: string }>;
    };
    const entry = plan.entries.find((e) => e.kind === 'mcp' && e.name === 'playwright');
    expect(entry, JSON.stringify(plan.entries)).toBeTruthy();
    const browsers = (await (await page.request.get('/api/builtin/browser')).json()) as { workers: Array<{ workerId: string; ready: boolean }> };
    if (!browsers.workers.find((w) => w.workerId === workerId)?.ready) expect(entry?.problem ?? '').toContain('需安装浏览器');

    // —— 5. 显式带上 Playwright 派生（假网关），模型看到的工具里有 browser_* ——
    const provider = await page.request.post('/api/providers', {
      headers,
      data: { slug, name: '假网关（内置资产）', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, apiKey: 'fake-key', models: ['m-1'], routing: 'direct', scope: 'personal' }
    });
    expect(provider.ok(), await provider.text()).toBe(true);
    const task = (await (await page.request.post('/api/tasks', { headers, data: { projectId: project.id, title: `内置 Playwright ${RUN}` } })).json()) as { id: string };
    const models = (await (await page.request.get(`/api/providers/models?taskId=${task.id}`)).json()) as Array<{ slug: string; models: Array<{ id: string }> }>;
    const model = models.find((m) => m.slug === slug)?.models[0]?.id;
    expect(model).toBeTruthy();
    const derived = await page.request.post('/api/sessions/derive', { headers, data: { taskId: task.id, agentId: 'pi', model, workerId, assetIds: [entry!.assetId] } });
    expect(derived.status(), await derived.text()).toBe(201);
    const session = (await derived.json()) as { id: string };
    await expect
      .poll(async () => ((await (await page.request.get(`/api/sessions/${session.id}/assets`)).json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name), { timeout: 30_000 })
      .toContain('playwright');
    const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { headers, data: { text: '列一下你能用的工具' } });
    expect(prompted.ok(), await prompted.text()).toBe(true);
    // npx 第一次要下载 @playwright/mcp，给足时间
    await expect.poll(async () => await (await page.request.get(`/api/sessions/${session.id}/events?after=0`)).text(), { timeout: 180_000, intervals: [2000] }).toContain('TOOLS_SEEN');
    expect(seenTools.some((name) => name.endsWith('browser_navigate')), seenTools.join(', ')).toBe(true);
    expect(seenTools.some((name) => name.endsWith('browser_snapshot'))).toBe(true);

    // —— 6. 手机宽度 ——
    await page.setViewportSize({ width: 390, height: 844 });
    await openAssetsTab(page, project.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'builtin-390.png'), fullPage: true });
  } finally {
    if (secretSaved) await page.request.delete('/api/assets/secrets/team/GITHUB_TOKEN', { headers }).catch(() => undefined);
    const assets = (await (await page.request.get('/api/admin/assets')).json()) as { assets: Array<{ id: string; projectId: string | null }> };
    for (const asset of assets.assets.filter((a) => a.projectId === project.id)) await page.request.delete(`/api/admin/assets/${asset.id}`, { headers }).catch(() => undefined);
    await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: project.name }, headers }).catch(() => undefined);
  }
});
