import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/** 删除项目：GitHub 式确认（输对项目名才能点），删掉记录、磁盘目录原样保留；桌面和 390px 都能用。 */
for (const viewport of [{ width: 1280, height: 800, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }]) {
  test(`删除项目：输名确认、目录保留（${viewport.tag}）`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const dir = mkdtempSync(join(tmpdir(), 'e2e-delete-'));
    const name = `e2e 删除 ${viewport.tag} ${Date.now().toString(36)}`;
    const made = await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers });
    expect(made.status(), await made.text()).toBe(201);
    const project = (await made.json()) as { id: string };

    const wrong = await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: 'nope' }, headers });
    expect(wrong.status()).toBe(400);

    await page.goto('/');
    await page.getByRole('button', { name: `删除项目 ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除项目' });
    await expect(dialog.getByText('磁盘上的文件不会动')).toBeVisible();
    const confirm = dialog.getByRole('button', { name: '删除项目' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/输入项目名/).fill(name);
    await expect(confirm).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `delete-project-${viewport.tag}.png`) });
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: `删除项目 ${name}` })).toHaveCount(0);
    expect((await page.request.get(`/api/projects/${project.id}/canvas`)).status()).toBe(404);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
}
