import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 三个「本地反馈」的回归：都用假 ACP agent，证据落在文件/API 上，不靠 sleep 猜。
 *
 * - 改模型：请求在飞时写「切换中…」，不先显示目标值；回执落库后才换，
 *   而且旧画布响应晚到也盖不掉刚确认的配置。
 * - 停止：回执只证明请求送到了，提示「已请求停止」，行状态仍是「运行中」；
 *   真正结束要等运行时吐完这一轮，最终是「完成」而不是「已停止」。
 * - 归档/恢复：任务投影直接用接口回执，旧画布还在飞时也能立刻更新，晚到的旧响应不把它盖回去。
 *
 * 终端状态用 fake agent 的 gate：`please-hold:<key>` 卡住这一轮，写 `hold-<key>.go` 才结束；
 * fake 不处理 session/cancel，所以停止之后这一轮仍会跑完——正好区分「已请求」与「已停止」。
 */
const STOP_KEY = 'confirmed-feedback-stop';

type Deferred = { readonly promise: Promise<void>; fire: () => void };

function deferred(): Deferred {
  let fire = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    fire = resolvePromise;
  });
  return { promise, fire };
}

test.afterAll(() => stopFakeWorker());

async function seed(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };

  const gate = mkdtempSync(join(tmpdir(), 'hub-e2e-confirmed-gate-'));
  let dir: string | null = null;
  try {
    // 和别的假 worker 用例共用登记/启动/清理；只多给假 agent 一个 gate 目录。
    const workerId = await ensureFakeWorker(page, baseURL, 'fakeacp', { agentArgs: ['--gate-dir', gate] });

    dir = mkdtempSync(join(tmpdir(), 'e2e-confirmed-dir-'));
    const tag = Date.now().toString(36);
    const project = (await (
      await page.request.post('/api/projects', {
        data: { name: `e2e 确认反馈 ${tag}`, rootPath: dir, workerId },
        headers
      })
    ).json()) as { id: string };
    const archiveTask = (await (
      await page.request.post('/api/tasks', { data: { projectId: project.id, title: `待归档任务-${tag}` }, headers })
    ).json()) as { id: string };
    const stopTask = (await (
      await page.request.post('/api/tasks', { data: { projectId: project.id, title: `待停止任务-${tag}` }, headers })
    ).json()) as { id: string };

    const derive = async (taskId: string, title: string) => {
      const response = await page.request.post('/api/sessions/derive', {
        data: { taskId, agentId: 'fakeacp', model: '' },
        headers
      });
      expect(response.ok(), await response.text()).toBe(true);
      const session = (await response.json()) as { id: string };
      const named = await page.request.put(`/api/sessions/${session.id}/title`, { data: { title }, headers });
      expect(named.ok(), await named.text()).toBe(true);
      return session.id;
    };
    const archiveSession = await derive(archiveTask.id, `待归档会话-${tag}`);
    const stopSession = await derive(stopTask.id, `待停止会话-${tag}`);

    // 归档只接受停下来的会话；这里等画布真的确认，而不是凭中断接口的 2xx 猜。
    expect((await page.request.post(`/api/sessions/${archiveSession}/interrupt`, { data: {}, headers })).ok()).toBe(true);
    await expect
      .poll(
        async () => {
          const canvas = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
            sessions: Array<{ id: string; status: string }>;
          };
          return canvas.sessions.find((item) => item.id === archiveSession)?.status;
        },
        { timeout: 30_000 }
      )
      .not.toBe('running');

    return {
      gate,
      dir,
      headers,
      projectId: project.id,
      archiveTaskId: archiveTask.id,
      archiveTaskTitle: `待归档任务-${tag}`,
      stopTitle: `待停止会话-${tag}`,
      stopTaskTitle: `待停止任务-${tag}`,
      stopSession
    };
  } catch (failure) {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    rmSync(gate, { recursive: true, force: true });
    stopFakeWorker();
    throw failure;
  }
}

test('配置、归档和停止都在回执后立刻反馈，不被旧画布或请求回执骗成已完成', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const seeded = await seed(page, baseURL!);
  const { gate, dir, headers, projectId, archiveTaskId, archiveTaskTitle, stopTitle, stopTaskTitle, stopSession } = seeded;
  const listUrl = `/#/p/${projectId}/list`;

  // 画布 GET 的闸：先把服务端真正返回的旧响应抓下来，再按住不交给页面。
  // 这样放行时页面收到的确实是「改之前」的投影，而不是一个还没到服务端的空请求。
  type CanvasPayload = {
    sessions: Array<{ id: string; options?: Record<string, string>; optionSpec?: Array<{ id: string; current?: string }> }>;
    tasks: Array<{ id: string; archivedAt: number | null }>;
  };
  type HeldCanvas = { payload: CanvasPayload; settled: boolean };
  const heldCanvases: HeldCanvas[] = [];
  const openCanvases = new Set<HeldCanvas>();
  let holdCanvas = false;
  const canvasGates: Deferred[] = [];
  await page.route('**/api/projects/*/canvas', async (route) => {
    if (!holdCanvas) {
      await route.continue().catch(() => undefined);
      return;
    }
    let response;
    try {
      response = await route.fetch();
    } catch {
      return; // 页面已经把请求取消了（cancelQueries）
    }
    const body = await response.text();
    const payload = JSON.parse(body) as CanvasPayload;
    const gateForRequest = deferred();
    const entry: HeldCanvas = { payload, settled: false };
    heldCanvases.push(entry);
    openCanvases.add(entry);
    canvasGates.push(gateForRequest);
    await gateForRequest.promise;
    try {
      await route.fulfill({ response, body });
    } catch {
      /* 页面取消后路由已经关了，旧响应没地方送——正是这里要证明的情况 */
    }
    openCanvases.delete(entry);
    entry.settled = true;
  });
  const holdNextCanvas = async (): Promise<HeldCanvas> => {
    const before = heldCanvases.length;
    holdCanvas = true;
    await page.getByTestId('list-refresh').click();
    await expect.poll(() => heldCanvases.length, { timeout: 10_000 }).toBeGreaterThan(before);
    return heldCanvases[heldCanvases.length - 1]!;
  };
  const releaseCanvas = async () => {
    holdCanvas = false;
    for (const gateForRequest of canvasGates.splice(0)) gateForRequest.fire();
    await expect.poll(() => openCanvases.size).toBe(0);
  };

  const canvasStatus = async (sessionId: string) => {
    const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`, { headers })).json()) as {
      sessions: Array<{ id: string; status: string }>;
    };
    return canvas.sessions.find((item) => item.id === sessionId)?.status;
  };

  try {
    await page.goto(listUrl);
    await expect(page.getByTestId('list-task-group').filter({ hasText: archiveTaskTitle })).toBeVisible();

    // —— 换模型：按住一份真正从服务端取回的旧画布和 options 回执，先看到「切换中…」；回执到了才换到 B。
    const heldModelCanvas = await holdNextCanvas();
    const heldModelSession = heldModelCanvas.payload.sessions.find((item) => item.id === stopSession);
    expect(heldModelSession?.optionSpec?.find((option) => option.id === 'model')?.current, '按住的旧画布还是 A').toBe('a');
    await page.getByTestId('list-session-row').filter({ hasText: stopTitle }).click();
    await expect(page.getByLabel('发送消息')).toBeVisible();

    const modelButton = page.getByTestId('session-model-trigger');
    await expect(modelButton).toHaveAttribute('aria-label', /^模型：.+ · A$/);
    const sheet = page.getByRole('dialog');

    let optionGate: Deferred | null = null;
    await page.route('**/api/sessions/*/options', async (route) => {
      optionGate = deferred();
      await optionGate.promise;
      await route.continue().catch(() => undefined);
    });
    await modelButton.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('option').filter({ hasText: 'B' }).first().click();
    await expect(modelButton).toContainText('切换中…');
    await expect(modelButton).toHaveAttribute('aria-busy', 'true');
    await expect(modelButton).toHaveAttribute('aria-label', /切换中…/);
    expect(heldModelCanvas.settled, '旧画布还按着').toBe(false);

    expect(optionGate).not.toBeNull();
    optionGate!.fire();
    await expect(modelButton).toHaveAttribute('aria-label', / · B$/);
    await expect(modelButton).not.toHaveAttribute('aria-busy', 'true');

    // 旧画布这才会放行：它带的是改之前的数据，不能把刚确认的 B 盖回 A。
    await releaseCanvas();
    await expect(modelButton).toHaveAttribute('aria-label', / · B$/);
    await page.unroute('**/api/sessions/*/options');

    // 回执可能仍是旧值（agent 超时没确认）：界面只认回执，不显示刚点过的目标 A。
    const confirmed = (await (await page.request.get(`/api/sessions/${stopSession}`, { headers })).json()) as Record<string, unknown>;
    await page.route('**/api/sessions/*/options', (route) =>
      route.fulfill({ status: 200, json: { state: 'unconfirmed', session: confirmed } })
    );
    const staleAck = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/options')
    );
    await modelButton.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('option').filter({ hasText: 'A' }).first().click();
    await staleAck;
    await expect(modelButton).toHaveAttribute('aria-label', / · B$/);
    await expect(modelButton).not.toContainText('切换中…');
    await page.unroute('**/api/sessions/*/options');

    // —— 停止：先让这一轮真的跑起来并卡在 gate 里。
    const log = page.getByRole('log', { name: '会话记录' });
    await page.getByLabel('发送消息').fill(`please-hold:${STOP_KEY}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(() => existsSync(join(gate, `hold-${STOP_KEY}.started`)), { timeout: 30_000, message: '这一轮没有进运行时' })
      .toBe(true);
    await expect(log.getByText(`hold:${STOP_KEY} 开始`)).toBeVisible({ timeout: 30_000 });

    // 不撤画布路由：holdCanvas 已关，整页加载会正常放行；后面归档还要用它按住旧响应。
    await page.goto(listUrl);
    const stopRow = page.getByTestId('list-session-row').filter({ hasText: stopTitle });
    await expect(stopRow).toContainText('运行中');
    await expect.poll(() => canvasStatus(stopSession)).toBe('running');

    await page.getByRole('button', { name: `会话「${stopTitle}」的操作` }).click();
    await page.getByTestId('list-session-menu-interrupt').click();
    const toast = page.getByTestId('list-action-toast');
    await expect(toast).toContainText(`已请求停止「${stopTitle}」`);
    await expect(toast).not.toContainText(`已停止「${stopTitle}」`);
    // 回执不是终态：运行时还没结束，行仍是运行中。
    await expect(stopRow).toContainText('运行中');
    expect(await canvasStatus(stopSession)).toBe('running');

    // 放开这一轮才真正结束——此时才该离开「运行中」，而且是正常完成（不是「已停止」）。
    writeFileSync(join(gate, `hold-${STOP_KEY}.go`), 'go\n');
    await expect.poll(() => canvasStatus(stopSession), { timeout: 30_000 }).toBe('done');
    await expect(stopRow).toContainText('完成', { timeout: 30_000 });

    // —— 归档：旧画布按着，任务详情也要立刻出现「已归档」。
    const heldArchiveCanvas = await holdNextCanvas();
    expect(heldArchiveCanvas.payload.tasks.find((task) => task.id === archiveTaskId)?.archivedAt, '按住的旧画布还没归档').toBeNull();
    await page.getByRole('button', { name: `任务详情：${archiveTaskTitle}` }).click();
    const detail = page.getByTestId('task-detail');
    await expect(detail).toBeVisible();
    await page.getByTestId('task-archive').click();
    await expect(page.getByTestId('task-archived')).toBeVisible();
    await releaseCanvas();
    await expect(page.getByTestId('task-archived')).toBeVisible();
    await page.getByTestId('task-detail').getByRole('button', { name: '关闭' }).click();
    await expect(page.getByTestId('list-task-group').filter({ hasText: archiveTaskTitle })).toHaveCount(0);
    await expect(page.getByTestId('list-archived')).toContainText('1 个任务');

    // —— 恢复对称：同样不等整张画布，旧响应晚到也不把归档区又填回来。
    const heldRestoreCanvas = await holdNextCanvas();
    expect(heldRestoreCanvas.payload.tasks.find((task) => task.id === archiveTaskId)?.archivedAt, '按住的旧画布已经归档').not.toBeNull();
    await page.getByTestId('list-archived').getByRole('button', { name: /已归档/ }).click();
    await page.getByTestId('list-archived-restore').click();
    await expect(page.getByTestId('list-archived')).toHaveCount(0);
    await expect(page.getByTestId('list-task-group').filter({ hasText: archiveTaskTitle })).toBeVisible();
    await expect(page.getByTestId('list-action-toast')).toContainText(`已恢复「${archiveTaskTitle}」`);
    await releaseCanvas();
    await expect(page.getByTestId('list-archived')).toHaveCount(0);
    await expect(page.getByTestId('list-task-group').filter({ hasText: archiveTaskTitle })).toBeVisible();

    // 页面上还留着“待停止任务”的组，确认这条会话没被误归到别处。
    await expect(page.getByTestId('list-task-group').filter({ hasText: stopTaskTitle })).toBeVisible();
  } finally {
    for (const gateForRequest of canvasGates.splice(0)) gateForRequest.fire();
    stopFakeWorker();
    rmSync(gate, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
