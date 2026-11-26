import { expect, type Locator, type Page } from '@playwright/test';

export async function showSessionOptions(scope: Page | Locator): Promise<void> {
  const trigger = scope.getByTestId('session-options-trigger');
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}

export async function hideSessionOptions(scope: Page | Locator): Promise<void> {
  const trigger = scope.getByTestId('session-options-trigger');
  if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
}

export async function showSessionHandoff(page: Page, compact: boolean): Promise<Locator> {
  if (compact) {
    await page.getByTestId('session-more-trigger').click();
    await page.getByTestId('session-more-actions').click();
  }
  return page.getByTestId('agent-handoff-trigger');
}
