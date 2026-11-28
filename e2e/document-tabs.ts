import { expect, type Locator, type Page } from '@playwright/test';

/** Tight hosts put the New action inside the tab picker sheet. */
export async function openDocumentNewMenu(page: Page, host: Locator, { touch = false, compact = false } = {}) {
  const target = host.getByTestId(compact ? 'session-tab-trigger' : 'session-tab-add');
  await expect(target).toBeVisible();
  if (touch) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await target.click();
  if (compact) {
    await page.getByTestId('session-tab-picker').getByTestId('session-tab-add').click();
    await expect(page.getByTestId('session-tab-add-sheet')).toBeVisible();
  }
}
