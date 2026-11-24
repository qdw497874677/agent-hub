import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { expectNoHorizontalOverflow } from './hitbox.ts';

/**
 * 复制这件事只有两种诚实结果：原生剪贴板真的写进去了，或明说写不进去、把同一段文字选中。
 * 普通 HTTP 部署（tailnet / 内网 IP）下 navigator.clipboard 常常整个不存在，权限被拒时 writeText 也会 reject。
 * 这里用 390px 覆盖两类真实入口：令牌 / MCP 片段，和添加机器的安装命令。
 */
test('令牌与 MCP：原生可用才显示已复制；不可用或被拒时改为手动选中同一段', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '访问令牌' }).click();
  const dialog = page.getByRole('dialog', { name: '访问令牌' });
  await dialog.getByTestId('token-name').fill(`e2e-clip-${Date.now().toString(36)}`);
  await dialog.getByTestId('token-create').click();

  const value = dialog.getByTestId('token-value');
  await expect(value).toContainText('••••');
  const masked = ((await value.textContent()) ?? '').trim();
  expect(masked).toMatch(/^ahp_/);
  // 先点「显示」拿到真值，再遮回去：之后整页文字里不该出现明文。
  await dialog.getByTestId('token-reveal').click();
  await expect(value).not.toContainText('••••');
  const token = ((await value.textContent()) ?? '').trim();
  expect(token).toMatch(/^ahp_/);
  expect(token).not.toBe(masked);
  await dialog.getByTestId('token-reveal').click();
  await expect(value).toContainText('••••');
  expect(await page.locator('body').innerText()).not.toContain(token);

  // —— 1. 原生剪贴板可用：只有真写成功才显示「已复制」 ——
  const copy = dialog.getByTestId('token-copy');
  await copy.click();
  await expect(copy).toHaveText('已复制');
  await expect(copy).toHaveAttribute('data-state', 'copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await expect(dialog.getByRole('status').filter({ hasText: '已复制' })).toBeAttached();

  // —— 2. 权限被拒 / 普通 HTTP：不冒充成功，先提示令牌还遮着 ——
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }
    });
  });
  await copy.click();
  await expect(copy).toHaveText('复制');
  await expect(copy).toHaveAttribute('data-state', 'manual');
  const maskedHint = dialog.getByTestId('token-manual-masked');
  await expect(maskedHint).toBeVisible();
  await expect(maskedHint).toContainText('没法写入剪贴板');
  await expect(dialog.getByRole('status').filter({ hasText: '没法写入剪贴板' })).toBeAttached();
  expect(await page.locator('body').innerText()).not.toContain(token);

  // 点「显示」后才把同一段令牌摊成只读、已选中的文本，让人自己复制。
  await dialog.getByTestId('token-reveal').click();
  const manual = dialog.getByTestId('token-manual-text');
  await expect(manual).toHaveValue(token);
  await expect(manual).toHaveAttribute('readonly', '');
  await expect(dialog.getByLabel(/没法写入剪贴板，下面是同一段令牌/)).toBeFocused();
  const selection = await manual.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    return { start: area.selectionStart, end: area.selectionEnd };
  });
  expect(selection).toEqual({ start: 0, end: token.length });

  // —— 3. MCP 片段同一条路：失败时摊开的是完全一致的片段，且不含明文令牌 ——
  const snippet = await dialog.getByTestId('mcp-guide-snippet').innerText();
  expect(snippet).not.toContain(token);
  const mcpCopy = dialog.getByTestId('mcp-guide-copy');
  await mcpCopy.click();
  await expect(mcpCopy).toHaveText('复制这段');
  await expect(dialog.getByTestId('mcp-guide-manual-text')).toHaveValue(snippet);

  // —— 4. 同一块面板换片段：上一段的手动字段收起，也不自动选中新内容 ——
  const cursorTab = dialog.getByTestId('mcp-guide-tab').filter({ hasText: 'Cursor' });
  await cursorTab.click();
  const cursorSnippet = await dialog.getByTestId('mcp-guide-snippet').innerText();
  expect(cursorSnippet).not.toBe(snippet);
  await expect(mcpCopy).toHaveText('复制这段');
  await expect(mcpCopy).toHaveAttribute('data-state', 'idle');
  await expect(dialog.getByTestId('mcp-guide-manual')).toHaveCount(0);
  await expect(cursorTab).toBeFocused();

  // —— 5. 旧片段的一次迟到成功不能落到新片段上 ——
  await page.evaluate(() => {
    const holder = window as Window & { __resolveCopy?: () => void };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            holder.__resolveCopy = () => resolve();
          })
      }
    });
  });
  await mcpCopy.click();
  const codexTab = dialog.getByTestId('mcp-guide-tab').filter({ hasText: 'Codex' });
  await codexTab.click();
  await page.evaluate(() => {
    const holder = window as Window & { __resolveCopy?: () => void };
    holder.__resolveCopy?.();
  });
  // 给过期的 Promise 一点时间落回来，再确认新片段仍是干净状态。
  await page.waitForTimeout(150);
  await expect(mcpCopy).toHaveText('复制这段');
  await expect(mcpCopy).toHaveAttribute('data-state', 'idle');
  await expect(dialog.getByTestId('mcp-guide-manual')).toHaveCount(0);
  await expect(dialog.getByText('已复制', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('添加机器：没有剪贴板接口时选中命令并说明，不显示已复制', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // 部署在普通 HTTP 的非 loopback 地址上时，navigator.clipboard 根本不存在
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('link', { name: /^机器：/ }).first().click();
  await page.getByTestId('machines-add').click();
  const dialog = page.getByRole('dialog', { name: '添加机器' });
  const command = dialog.getByLabel('安装命令');
  await expect(command).toContainText('HUB_PAIR=ahw_pair_');
  const text = (await command.innerText()).replace(/\s+/g, ' ').trim();

  const copy = dialog.getByTestId('copy-command');
  await expect(copy).toHaveAccessibleName('复制命令');
  await copy.click();
  await expect(dialog.getByTestId('copy-command-manual')).toBeVisible();
  await expect(dialog.getByTestId('copy-command-manual')).toContainText('没法写入剪贴板');
  await expect(copy).toHaveText('复制命令');
  await expect(copy).not.toHaveText('已复制');

  // 至少选中了同一条命令，长按 / 快捷键就能复制
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.replace(/\s+/g, ' ').trim()).toBe(text);
  await expectNoHorizontalOverflow(page);
});
