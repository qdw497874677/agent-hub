import {
  test,
  expect,
  request as apiRequest,
  type Page,
} from "@playwright/test";
import { TEST_EMAIL, loginByApi, openRegistration, verifyByApi } from "./login.ts";
import { currentRun } from "./run-id.ts";

/** 把设置恢复成默认（e2e 数据目录跨 run 保留，上次失败可能留下关着的注册）。 */
async function resetSettings(page: Page): Promise<void> {
  const csrf =
    (await page.context().cookies()).find(
      (cookie) => cookie.name === "hub_csrf",
    )?.value ?? "";
  const response = await page.request.put("/api/admin/settings", {
    headers: { "x-hub-csrf": csrf },
    data: { openRegistration: true, membersCanAddMachines: true },
  });
  expect(response.ok()).toBe(true);
}

/** 运营后台：主人从账号菜单进入，管用户、看机器、改设置，每一步都进审计。 */
test("主人在后台停用并启用一个成员、关开注册，审计里都有记录", async ({
  page,
  baseURL,
}) => {
  await loginByApi(page);
  await resetSettings(page);
  const memberEmail = `admin-e2e-${currentRun()}@example.com`;
  const member = await apiRequest.newContext({ baseURL });
  // 自助注册（ADR 0011）：202 + 去邮箱；得到自己的空团队，不会自动登录
  expect(
    (
      await member.post("/api/auth/register", {
        data: { email: memberEmail, password: "e2e password 123" },
      })
    ).status(),
  ).toBe(202);
  const memberLogin = () =>
    member.post("/api/auth/login", { data: { email: memberEmail, password: "e2e password 123" } });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "账号" }).click();
    await page.getByRole("link", { name: "运营后台" }).click();
    await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
    await expect(page.getByText("在线机器")).toBeVisible();

    // 用户：搜到新成员，停用后他的会话立刻失效
    await page
      .getByRole("navigation", { name: "后台分页" })
      .getByRole("link", { name: "用户" })
      .click();
    await page.getByLabel("搜索用户").fill(memberEmail);
    const row = page.getByTestId("admin-user").filter({ hasText: memberEmail });
    await expect(row).toContainText("其他团队");
    // 别的团队的人不能被授权用 hub 本机
    await expect(row.getByRole("button", { name: "允许使用本机" })).toHaveCount(0);
    // 新人还没验证邮箱：hub 管理员可以手动标记
    await expect(row).toContainText("未验证邮箱");
    await row.getByRole("button", { name: "标记已验证" }).click();
    await expect(row).not.toContainText("未验证邮箱");
    expect((await memberLogin()).ok()).toBe(true);
    // 新团队是空的：看不到 hub 团队的项目，机器列表里也没有 hub 本机
    expect(await (await member.get("/api/projects")).json()).toEqual([]);
    expect(await (await member.get("/api/workers")).json()).toEqual([]);
    expect((await member.get("/api/admin/overview")).status()).toBe(403);
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "停用" }).click();
    await expect(row).toContainText("已停用");
    expect((await member.get("/api/projects")).status()).toBe(401);
    await row.getByRole("button", { name: "启用" }).click();
    await expect(row).not.toContainText("已停用");

    // 自己那行没有「停用」
    await page.getByLabel("搜索用户").fill(TEST_EMAIL);
    await expect(
      page
        .getByTestId("admin-user")
        .filter({ hasText: TEST_EMAIL })
        .getByRole("button", { name: "停用" }),
    ).toHaveCount(0);

    // 机器：本机在列
    await page.getByRole("link", { name: "机器" }).click();
    await expect(page.getByTestId("admin-worker").first()).toContainText(
      "本机",
    );
    // 版本：本机和 hub 同一份代码，不显示过期；点「更新」是一次演练，回「无需更新」
    const local = page.getByTestId("admin-worker").filter({ hasText: "本机" });
    await expect(page.getByTestId("hub-version")).toContainText(/hub v\S+ · [0-9a-f]{7}/);
    await expect(local.getByTestId("worker-version")).toContainText(/v\S+ · [0-9a-f]{7}/);
    await expect(local.getByTestId("worker-outdated")).toHaveCount(0);
    await local.getByRole("button", { name: "更新" }).click();
    await expect(local.getByTestId("worker-update")).toContainText("无需更新");

    // harness 就绪：本机列出各 harness；「重新检测」真的发到 Worker（202），不报「不在线」
    await expect(local.getByTestId("worker-harnesses")).toContainText("pi");
    const probed = page.waitForResponse((r) => /\/api\/workers\/[^/]+\/probe$/.test(r.url()));
    await local.getByTestId("harness-recheck").click();
    expect((await probed).status()).toBe(202);
    await expect(local.getByTestId("harness-recheck")).toBeEnabled({ timeout: 10_000 });
    await expect(local.getByTestId("worker-harnesses")).not.toContainText("不在线");

    // 设置：关注册 → 新人注册被服务端拒；再打开
    await page.getByRole("link", { name: "设置" }).click();
    const open = page.getByRole("switch", { name: /开放注册/ });
    await expect(open).toBeChecked();
    await open.click();
    await expect(open).not.toBeChecked();
    const stranger = await apiRequest.newContext({ baseURL });
    const refused = await stranger.post("/api/auth/register", {
      data: {
        email: `late-${currentRun()}@example.com`,
        password: "e2e password 123",
      },
    });
    expect(refused.status()).toBe(409);
    await open.click();
    await expect(open).toBeChecked();

    await page.getByRole("link", { name: "审计" }).click();
    const audit = page.getByTestId("audit-entry");
    await expect(audit.first()).toContainText("改设置");
    await expect(
      page.getByTestId("audit-entry").filter({ hasText: "更新机器" }),
    ).not.toHaveCount(0);
    await expect(
      page.getByTestId("audit-entry").filter({ hasText: "停用用户" }),
    ).not.toHaveCount(0);
    await stranger.dispose();
  } finally {
    await resetSettings(page);
    await member.dispose();
  }
});

test("自助注册的团队主人进不了后台：页面提示、接口 403", async ({ page, baseURL }) => {
  await openRegistration(baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const email = `member-e2e-${currentRun()}@example.com`;
  expect(
    (
      await page.request.post("/api/auth/register", {
        data: { email, password: "e2e password 123" },
      })
    ).status(),
  ).toBe(202);
  await verifyByApi(page.request, email);
  expect(
    (await page.request.post("/api/auth/login", { data: { email, password: "e2e password 123" } })).ok(),
  ).toBe(true);
  expect((await page.request.get("/api/admin/overview")).status()).toBe(403);
  await page.goto(`${baseURL}/#/admin/users`);
  await expect(page.getByText("只有 hub 管理员能进运营后台")).toBeVisible();
});
