import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { currentRun } from "./run-id.ts";
import { loginByApi } from "./login.ts";

const RUN = currentRun();
const NAME = `picker-${RUN}`;
const MANAGED = `/tmp/agent-hub/${NAME}`;
const SCRATCH = `/tmp/agent-hub-e2e-pick-${RUN}`;

async function openPickerFor(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("navigation").getByTitle("新建项目").click();
  const panel = page.getByLabel("新建项目");
  await panel.getByLabel("项目名").fill(name);
  // 起点按打开时的项目名算：收起再打开
  await panel.getByRole("button", { name: "收起" }).click();
  await panel.getByRole("button", { name: "浏览…" }).click();
  return { panel, picker: page.getByLabel("目录选择器") };
}

// 三段放在一条用例里只登录一次：登录接口有频率限制，整套 e2e 已经登录很多次了
test("目录选择器：托管目录、新建文件夹、单击进入、git 标记、手机全屏", async ({
  page,
}) => {
  await loginByApi(page);
  await test.step("一键建托管目录、就地新建文件夹、单击进入、底部「使用」", () =>
    managedAndCreate(page));
  await test.step("托管目录已存在就从那里开始；git 仓库带标记；面包屑止于 root", () =>
    startsInManaged(page));
  await test.step("手机上全屏", () => mobileFullScreen(page));
});

async function managedAndCreate(page: Page) {
  const { panel, picker } = await openPickerFor(page, NAME);
  // 托管目录还不存在：给一键创建
  await picker
    .getByRole("button", { name: `创建项目目录 agent-hub/${NAME}` })
    .click();
  await expect(picker.getByLabel("路径").getByRole("button").last()).toHaveText(
    NAME,
  );
  expect(existsSync(MANAGED)).toBe(true);

  // 名字带斜杠：拒，并说明
  await picker.getByRole("button", { name: "＋ 新建文件夹" }).click();
  await picker.getByLabel("新文件夹名").fill("a/b");
  await picker.getByRole("button", { name: "创建", exact: true }).click();
  await expect(picker).toContainText("斜杠");
  await picker.getByLabel("新文件夹名").fill("sub");
  await picker.getByRole("button", { name: "创建", exact: true }).click();
  await expect(picker.getByLabel("路径").getByRole("button").last()).toHaveText(
    "sub",
  );
  expect(existsSync(`${MANAGED}/sub`)).toBe(true);

  // 面包屑回到上一层，单击进入（不是双击），底部「使用」
  await picker.getByLabel("路径").getByRole("button", { name: NAME }).click();
  await picker.getByRole("button", { name: /^▸\s*sub/ }).click();
  await picker.getByRole("button", { name: "使用", exact: true }).click();
  await expect(panel.getByLabel("目录", { exact: true })).toHaveValue(
    `${MANAGED}/sub`,
  );
  await panel.getByRole("button", { name: "取消" }).click();
}

async function startsInManaged(page: Page) {
  mkdirSync(`${SCRATCH}/repo/.git`, { recursive: true });
  mkdirSync(`${SCRATCH}/plain`, { recursive: true });
  mkdirSync(MANAGED, { recursive: true });
  const { panel, picker } = await openPickerFor(page, NAME);
  await expect(picker.getByLabel("路径").getByRole("button").last()).toHaveText(
    NAME,
  );
  // 面包屑的第一节就是 root（/tmp），没有更上面
  await expect(
    picker.getByLabel("路径").getByRole("button").first(),
  ).toHaveText("tmp");

  await picker.getByRole("button", { name: "输入路径" }).click();
  await picker.getByLabel("当前目录").fill(SCRATCH);
  await picker.getByLabel("当前目录").press("Enter");
  await expect(picker.getByRole("button", { name: /repo/ })).toContainText("⎇");
  await expect(picker.getByRole("button", { name: /plain/ })).not.toContainText(
    "⎇",
  );

  await panel.getByRole("button", { name: "取消" }).click();
}

async function mobileFullScreen(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("navigation").getByTitle("新建项目").click();
  const panel = page.getByLabel("新建项目");
  const picker = page.getByLabel("目录选择器");
  // 手机上先看到表单，点「浏览…」选择器才全屏盖上来
  await expect(picker).toHaveCount(0);
  await panel.getByLabel("项目名").fill(NAME);
  await panel.getByRole("button", { name: "浏览…" }).click();
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.height)).toBe(844);
  await expect(picker.getByLabel("路径").getByRole("button").last()).toHaveText(
    NAME,
  );
  await expect(
    picker.getByRole("button", { name: "使用", exact: true }),
  ).toBeInViewport();
  await picker.getByRole("button", { name: "关闭" }).click();
  await expect(picker).toHaveCount(0);
}
