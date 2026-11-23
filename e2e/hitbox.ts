import { expect, type Locator, type Page } from '@playwright/test';

export type Box = { x: number; y: number; width: number; height: number };

/** 取可见元素的盒模型；顺带把“元素没渲染”变成一条带名字的断言失败。 */
export async function boxOf(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${label} 应该有可见的盒模型`).not.toBeNull();
  return box!;
}

/** 手机主要触控目标：实际盒模型至少 44×44，且在视口内。 */
export async function expectTouchTarget(locator: Locator, label: string, viewportWidth: number): Promise<Box> {
  const box = await boxOf(locator, label);
  expect(box.width, `${label} 宽度至少 44`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${label} 高度至少 44`).toBeGreaterThanOrEqual(44);
  expect(box.x, `${label} 左边界在视口内`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${label} 右边界在视口内`).toBeLessThanOrEqual(viewportWidth + 0.5);
  return box;
}

export function expectNoOverlap(a: Box, b: Box, label: string): void {
  const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap, `${label} 的触控区域不应相交`).toBe(false);
}

/** 页面本身不能横向滚动；对话框内容溢出单独看。 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, '页面不应横向溢出').toBeLessThanOrEqual(1);
}
