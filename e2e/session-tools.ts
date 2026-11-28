import { expect, type Page } from '@playwright/test';

type Tool = 'files' | 'changes' | 'preview';

/** Choose the currently visible navigation, including after a viewport resize. */
export async function openSessionTool(page: Page, tool: Tool) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByTestId('session-more-trigger').click();
    await page.getByTestId(`session-more-${tool}`).click();
    await expect(page.getByTestId('session-back-to-chat')).toBeVisible();
  } else {
    await page.getByTestId(`session-tab-${tool}`).click();
    await expect(page.getByTestId(`session-tab-${tool}`)).toHaveAttribute('aria-selected', 'true');
  }
}

export async function backToChat(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByTestId('session-back-to-chat').click();
  } else {
    await page.getByTestId('session-tab-chat').click();
    await expect(page.getByTestId('session-tab-chat')).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByRole('log', { name: '会话记录' })).toBeVisible();
}
