import { expect, type Page } from '@playwright/test';

type Tool = 'files' | 'changes' | 'preview' | 'details';

/** Choose the currently visible navigation, including after a viewport resize. */
export async function openSessionTool(page: Page, tool: Tool) {
  const host = page.locator('[data-focus-view]');
  await expect(host).toBeVisible({ timeout: 10_000 });
  const button = page.getByTestId(`session-tab-${tool}`);
  // ResizeObserver may not have applied the compact navigation on the first render.
  await expect.poll(async () => {
    const width = await host.evaluate((element) => element.getBoundingClientRect().width);
    return width > 0 && (await button.count()) === (width < 420 ? 0 : 1);
  }, { timeout: 10_000 }).toBe(true);
  if (await button.count()) {
    if (await button.getAttribute('aria-pressed', { timeout: 10_000 }) !== 'true') await button.click({ timeout: 10_000 });
    await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  } else {
    const panel = page.getByTestId('session-tool-panel');
    const active = await panel.count() ? await panel.getAttribute('data-active-tool', { timeout: 10_000 }) : null;
    if (active !== tool) {
      await page.getByTestId('session-more-trigger').click({ timeout: 10_000 });
      await page.getByTestId(`session-more-tool-${tool}`).click({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('session-back-to-chat')).toBeVisible({ timeout: 10_000 });
}

export async function backToChat(page: Page) {
  await page.getByTestId('session-back-to-chat').click();
  await expect(page.getByRole('log', { name: '会话记录' })).toBeVisible();
}
