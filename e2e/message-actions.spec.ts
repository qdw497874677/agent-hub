import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

const question = 'please-test-message-actions\n用户正文';
const reply = '**第一行**\n\n`第二行`';
const shots = process.env['E2E_SCREENSHOTS'];

for (const width of [1280, 390]) {
  test.describe(`消息操作 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 600, isMobile: width < 600 });

    test('复制正文原文，复制不可用时手动选择，引用不发送且不覆盖草稿', async ({ page, baseURL }) => {
      const dir = mkdtempSync(join(tmpdir(), 'e2e-message-actions-'));
      try {
        await loginByApi(page);
        const workerId = await ensureFakeWorker(page, baseURL!);
        const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')!.value;
        const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
        const post = async (url: string, data: object) => {
          const response = await page.request.post(url, { data, headers });
          expect(response.ok(), await response.text()).toBe(true);
          return response.json();
        };
        const project = await post('/api/projects', { name: `消息操作 ${width}`, rootPath: dir, workerId }) as { id: string };
        const task = await post('/api/tasks', { projectId: project.id, title: '复制与引用' }) as { id: string };
        const session = await post('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }) as { id: string };
        const promptPath = `/api/sessions/${session.id}/prompt`;
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
        await page.goto(`/#/p/${project.id}/focus/${session.id}`);
        await post(promptPath, { text: question, briefing: false });

        const log = page.getByRole('log', { name: '会话记录' });
        const user = log.getByTestId('msg-user').filter({ hasText: '用户正文' });
        const assistant = log.getByTestId('msg-assistant').filter({ hasText: '第一行' });
        const userCopy = user.getByTestId('message-copy');
        const assistantCopy = assistant.getByTestId('message-copy');
        const assistantActions = assistant.getByTestId('message-actions');
        const mobileMenu = page.getByRole('menu', { name: '消息操作' });
        const userTrigger = user.getByTestId('message-actions-trigger');
        const assistantTrigger = assistant.getByTestId('message-actions-trigger');
        await expect(assistant.getByText('第二行', { exact: true })).toBeVisible();
        const before = await assistant.boundingBox();
        const assistantLastLine = (await assistant.getByText('第二行', { exact: true }).boundingBox())!;
        expect(before!.y + before!.height - assistantLastLine.y - assistantLastLine.height, '正文末尾没有专用操作行').toBeLessThan(22);
        if (width < 600) {
          const box = await userTrigger.boundingBox();
          expect(box?.width).toBeGreaterThanOrEqual(44);
          expect(box?.height).toBeGreaterThanOrEqual(44);
          await expect(userCopy).toHaveCount(0);
          await userTrigger.tap();
          await expect(mobileMenu.getByTestId('message-copy')).toBeFocused();
          await page.keyboard.press('ArrowDown');
          await expect(mobileMenu.getByTestId('message-quote')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(mobileMenu).toHaveCount(0);
          await expect(userTrigger).toBeFocused();
          await userTrigger.tap();
          await mobileMenu.getByTestId('message-copy').tap();
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(question);
          await assistantTrigger.tap();
          if (shots) await page.screenshot({ path: join(shots, `message-actions-menu-${width}.png`) });
          await mobileMenu.getByTestId('message-copy').tap();
        } else {
          await userCopy.focus();
          await expect(user.getByTestId('message-actions')).toHaveCSS('opacity', '1');
          await page.keyboard.press('Enter');
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(question);
          await assistant.hover();
          await expect(assistantActions).toHaveCSS('opacity', '1');
          await assistantCopy.click();
        }
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
        await expect(assistantActions).toHaveAttribute('data-state', 'copied');
        expect((await assistant.boundingBox())?.height).toBe(before?.height);
        if (shots) await page.screenshot({ path: join(shots, `message-actions-${width}.png`) });

        const draft = page.getByRole('textbox', { name: '发送消息' });
        await draft.fill('原来的草稿');
        const promptRequests: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === promptPath) promptRequests.push(request.url());
        });
        const quote = assistant.getByTestId('message-quote');
        if (width < 600) { await assistantTrigger.tap(); await mobileMenu.getByTestId('message-quote').tap(); }
        else { await quote.focus(); await page.keyboard.press('Enter'); }
        await expect(draft).toHaveValue('原来的草稿\n\n> **第一行**\n> \n> `第二行`\n');
        if (width < 600) await expect(draft).not.toBeFocused();
        await expect(log.getByTestId('msg-user')).toHaveCount(1);
        expect(promptRequests).toEqual([]);

        // 让同一个真实页面的剪贴板不可用，验证 HTTP/权限失败的回退而非伪成功。
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
        if (width < 600) { await assistantTrigger.tap(); await mobileMenu.getByTestId('message-copy').tap(); }
        else { await assistantCopy.focus(); await page.keyboard.press('Enter'); }
        const manual = page.getByTestId('message-copy-manual');
        const manualText = manual.getByTestId('message-copy-manual-text');
        await expect(manualText).toHaveValue(reply);
        await expect(manualText).toBeFocused();
        await expect.poll(() => manualText.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd))).toBe(reply);
        await expect(assistantActions).toHaveAttribute('data-state', 'manual');
        await page.getByTestId('message-copy-manual-close').click();
        await expect(manual).toBeHidden();
        await expect(width < 600 ? assistantTrigger : assistantCopy).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      } finally {
        stopFakeWorker();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
