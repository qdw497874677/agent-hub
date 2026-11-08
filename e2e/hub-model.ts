import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 真 Pi 的 E2E 可选模型。形如 hub-<标识>/<模型>。
 * 未设置时返回空串：派生仍是「用 agent 自己的默认」，和以前一样。
 * 这不是 PI_DEFAULT_MODEL，也不会写进 worker 的原生模型清单。
 */
export function e2eHubModel(): string {
  return process.env['E2E_HUB_MODEL']?.trim() ?? '';
}

/** 真 Pi / 用在线 Pi 的消息角色要带的模型。假 ACP、Hermes 自建网关不要用这个。 */
export function piModel(): string {
  return e2eHubModel();
}

export function parseE2eHubModel(value: string): { slug: string; modelId: string } | null {
  const match = /^hub-([a-z0-9][a-z0-9-]{0,30})\/(\S+)$/.exec(value.trim());
  if (!match?.[1] || !match[2] || /\s/.test(match[2])) return null;
  return { slug: match[1], modelId: match[2] };
}

/** 全站作用域：空库上的测试账号是集群管理员，后面邀请出来的成员和别的团队也能用。 */
export function hubProviderBody(spec: { slug: string; modelId: string }, baseUrl: string, apiKey: string) {
  return {
    slug: spec.slug,
    name: 'E2E Hub 模型',
    protocol: 'openai-chat' as const,
    baseUrl,
    models: [spec.modelId],
    routing: 'direct' as const,
    scope: 'hub' as const,
    enabled: true,
    apiKey
  };
}

export function hubProviderBaseUrl(): string {
  return process.env['E2E_HUB_PROVIDER_BASE_URL']?.trim() || 'https://open.bigmodel.cn/api/coding/paas/v4';
}

let pending: Promise<void> | null = null;

/** 登录之后调用。未设置 E2E_HUB_MODEL 时什么都不做。密钥只出现在这一次 POST 的正文里。 */
export async function ensureHubProvider(page: Page): Promise<void> {
  if (!e2eHubModel()) return;
  if (!pending) {
    pending = seed(page).catch((error) => {
      pending = null;
      throw error;
    });
  }
  await pending;
}

async function seed(page: Page): Promise<void> {
  const raw = e2eHubModel();
  const spec = parseE2eHubModel(raw);
  if (!spec) throw new Error('E2E_HUB_MODEL 要写成 hub-<标识>/<模型>，例如 hub-cn-glm-flash/glm-5.3-flash');
  const apiKey = process.env['ZAI_CODING_CN_API_KEY'] ?? '';
  if (!apiKey) throw new Error('设置了 E2E_HUB_MODEL，但测试进程没有 ZAI_CODING_CN_API_KEY。不要把这个变量放进 hub 或 worker 的环境。');
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { 'x-hub-csrf': csrf };
  const listed = await page.request.get('/api/providers');
  if (!listed.ok()) throw new Error(`读供应商失败：HTTP ${listed.status()}`);
  const providers = ((await listed.json()) as { providers?: Array<{ slug?: string; models?: Array<{ id?: string }> }> }).providers ?? [];
  const existing = providers.find((provider) => provider.slug === spec.slug);
  if (existing) {
    if (!existing.models?.some((model) => model.id === spec.modelId)) {
      throw new Error(`已有供应商 ${spec.slug}，但没有模型 ${spec.modelId}。换一个新的 E2E_DATA_DIR 再种。`);
    }
    return;
  }
  const created = await page.request.post('/api/providers', { headers, data: hubProviderBody(spec, hubProviderBaseUrl(), apiKey) });
  const text = await created.text();
  if (text.includes(apiKey)) throw new Error(`创建供应商失败：HTTP ${created.status()}（响应里出现了密钥，已不打印正文）`);
  if (!created.ok()) throw new Error(`创建供应商失败：HTTP ${created.status()} ${text.slice(0, 300)}`);
}

/** 画布「开始」之前，用对话框里的模型控件选中 Hub 模型。未设置时不点。 */
export async function chooseHubModel(dialog: Locator): Promise<void> {
  const model = e2eHubModel();
  if (!model) return;
  const control = dialog.locator('#derive-model');
  await expect(control).toBeVisible();
  const tag = await control.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    await expect(control.locator('option', { hasText: model })).toHaveCount(1);
    await control.selectOption(model);
    return;
  }
  await control.click();
  const sheet = dialog.page().getByRole('dialog', { name: '选择模型' });
  await sheet.getByLabel('搜索模型').fill(model);
  await sheet.getByRole('option', { name: model }).click();
}
