import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 项目 / 任务的「默认 Agent」（运行时 + 模型 + 思考强度）。
 *
 * 只验证界面这一层：机器清单用 route 拦截喂假数据（不真的去查机器，
 * 也就能稳定造出「在线 opencode/codex + 离线 grok」这种下拉），
 * 保存与清掉走真服务端，最后再用 API 读回来核对。不跑 agent。
 */
const FAKE_WORKERS = [
  {
    workerId: 'fake-online',
    label: '在线机器',
    origin: 'remote',
    state: 'online',
    agentIds: ['opencode', 'codex'],
    agentModels: [
      { agentId: 'opencode', models: ['fake-opencode-1', 'fake-opencode-2'], defaultModel: 'fake-opencode-1' },
      { agentId: 'codex', models: ['fake-codex-1'], defaultModel: 'fake-codex-1' }
    ]
  },
  { workerId: 'fake-offline', label: '离线机器', origin: 'remote', state: 'offline', agentIds: ['grok'], agentModels: [{ agentId: 'grok', models: ['grok-4'] }] }
];

const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });

/** 没有单项目 GET（只有列表与画布），从列表里挑出来：核对保存真的落到了服务端。 */
async function projectAgent(
  page: Page,
  projectId: string
): Promise<{ runtime: string; model: string; options: Record<string, string | boolean> } | null> {
  const list = (await (await page.request.get('/api/projects')).json()) as {
    id: string;
    defaultAgent?: { runtime: string; model: string; options: Record<string, string | boolean> } | null;
  }[];
  const project = list.find((item) => item.id === projectId);
  return project?.defaultAgent ?? null;
}

test('项目默认 Agent 能保存 / 清掉，任务上配了就覆盖项目（390px 不溢出）', async ({ page, baseURL }, testInfo) => {
  await page.route('**/api/workers', (route) => route.fulfill({ json: FAKE_WORKERS }));
  await loginByApi(page);

  const run = Date.now().toString(36);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 默认 Agent ${run}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-default-agent-')) },
      headers
    })
  ).json()) as { id: string };
  const taskTitle = `默认 Agent 任务 ${run}`;
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: taskTitle }, headers })
  ).json()) as { id: string };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '项目设置' }).click();
  await page.getByRole('button', { name: '返回设置目录' }).click();
  await page.getByRole('link', { name: '项目默认 Agent', exact: true }).click();

  const box = page.getByTestId('project-default-agent');
  await expect(box).toBeVisible();
  // 回落顺序写在脸上：会话 > 任务 > 项目 > 团队默认 > 运行时默认
  await expect(box).toContainText('任务有自己的默认 Agent 时，优先用任务的设置');
  await expect(box).toContainText('模型留空时，先用该运行时的团队默认模型；没设则用运行时默认');

  // 运行时候选来自各台机器：离线的 grok 也列出来，但标一下
  const runtime = box.getByTestId('pda-runtime');
  await expect(runtime.locator('option', { hasText: 'OpenCode' })).toHaveCount(1);
  await expect(runtime.locator('option', { hasText: 'Grok（离线）' })).toHaveCount(1);

  await runtime.selectOption('opencode');
  await box.getByTestId('pda-model').fill('fake-opencode-2');
  await expect(box.getByTestId('pda-saved-dirty')).toBeVisible();
  await box.getByTestId('pda-save').click();
  await expect(box.getByTestId('pda-saved')).toHaveText(/已保存/);
  expect(await projectAgent(page, project.id)).toMatchObject({ runtime: 'opencode', model: 'fake-opencode-2' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('project-default-agent-390.png') });

  // 清掉默认：界面回到「没配」，服务端也真的空了
  await box.getByTestId('pda-clear').click();
  await expect(box.getByTestId('pda-runtime')).toHaveValue('');
  await expect(box.getByTestId('pda-clear')).toBeDisabled();
  expect(await projectAgent(page, project.id)).toBeNull();
  await page.getByRole('button', { name: '返回应用' }).click();
  await expect(box).toBeHidden();
  await expect(page).toHaveURL(`${baseURL}/#/p/${project.id}/canvas`);

  // 390px 下画布被侧栏盖着，换成桌面宽度再点任务卡（手机上点的是同一颗「日志」按钮）
  await page.setViewportSize({ width: 1280, height: 900 });

  // 任务上没配 → 「跟随项目」
  await expect(taskNode(page, taskTitle)).toBeVisible();
  await taskNode(page, taskTitle).hover();
  await taskNode(page, taskTitle).getByRole('button', { name: '日志' }).click();
  const drawer = page.getByTestId('task-detail');
  await expect(drawer.getByTestId('task-default-agent-value')).toHaveText('跟随项目');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // 任务上配了 → 显示任务自己的那份，与项目无关
  expect(
    (
      await page.request.patch(`/api/tasks/${task.id}/default-agent`, {
        data: { defaultAgent: { runtime: 'codex', model: 'fake-codex-1', options: { effort: 'high' } } },
        headers
      })
    ).ok()
  ).toBe(true);
  await page.reload();
  await expect(taskNode(page, taskTitle)).toBeVisible();
  await taskNode(page, taskTitle).hover();
  await taskNode(page, taskTitle).getByRole('button', { name: '日志' }).click();
  const value = page.getByTestId('task-detail').getByTestId('task-default-agent-value');
  await expect(value).toContainText('Codex');
  await expect(value).toContainText('fake-codex-1');
  await expect(value).toContainText('思考');

  // 展开就能改：三件套都在，运行时是任务自己那份
  await page.getByTestId('task-default-agent').getByRole('button', { name: '改' }).click();
  const editor = page.getByTestId('task-default-agent');
  await expect(editor.getByTestId('tda-runtime')).toHaveValue('codex');
  await expect(editor.getByTestId('tda-model')).toHaveValue('fake-codex-1');
  await editor.getByTestId('tda-model').fill('fake-codex-1');
  await editor.getByTestId('tda-clear').click();
  await expect(editor.getByTestId('task-default-agent-value')).toHaveText('跟随项目');
  // 任务上清掉之后服务端也是 null（回落靠项目 / 团队）
  const tasks = (await (await page.request.get(`/api/projects/${project.id}/canvas`)).json()) as {
    tasks: { id: string; defaultAgent?: unknown }[];
  };
  expect(tasks.tasks.find((item) => item.id === task.id)?.defaultAgent ?? null).toBeNull();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('task-detail').getByTestId('task-default-agent')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-default-agent-390.png') });
});

test('清掉默认 Agent 要真的落库（项目 + 任务）', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 清默认 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-default-clear-')) },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `清默认 ${Date.now().toString(36)}` }, headers })
  ).json()) as { id: string };
  const agent = { runtime: 'codex', model: 'm', options: {} };
  expect((await page.request.patch(`/api/projects/${project.id}`, { data: { defaultAgent: agent }, headers })).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${task.id}/default-agent`, { data: { defaultAgent: agent }, headers })).ok()).toBe(true);
  expect((await page.request.patch(`/api/projects/${project.id}`, { data: { defaultAgent: null }, headers })).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${task.id}/default-agent`, { data: { defaultAgent: null }, headers })).ok()).toBe(true);
  expect(await projectAgent(page, project.id)).toBeNull();
  const tasks = (await (await page.request.get(`/api/projects/${project.id}/canvas`)).json()) as {
    tasks: { id: string; defaultAgent?: unknown }[];
  };
  expect(tasks.tasks.find((item) => item.id === task.id)?.defaultAgent ?? null).toBeNull();
});
