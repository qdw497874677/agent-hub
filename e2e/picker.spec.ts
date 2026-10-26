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
test("目录选择器：路径框 + 键盘、模糊筛、就地新建、git 标记、手机全屏", async ({
  page,
}) => {
  await loginByApi(page);
  await test.step("一键建托管目录；打名字出现「新建文件夹」；Enter 进入、Backspace 回上一级、⌘↵ 使用", () =>
    managedAndCreate(page));
  await test.step("托管目录已存在就从那里开始；模糊筛；Tab 补全；git 标记；止于 root", () =>
    startsInManaged(page));
  await test.step("常驻「新建文件夹」按钮：桌面 1280", () => newFolderButton(page, 1280, "desktop"));
  await test.step("常驻「新建文件夹」按钮：手机 390", () => newFolderButton(page, 390, "mobile"));
  await test.step("手机上全屏、能点", () => mobileFullScreen(page));
});

const pathBox = (picker: ReturnType<Page["getByLabel"]>) =>
  picker.getByRole("combobox", { name: "路径" });

async function managedAndCreate(page: Page) {
  const { panel, picker } = await openPickerFor(page, NAME);
  const input = pathBox(picker);
  await picker
    .getByRole("option", { name: `创建项目目录 agent-hub/${NAME}` })
    .click();
  await expect(input).toHaveValue(`${MANAGED}/`);
  expect(existsSync(MANAGED)).toBe(true);

  // 名字带斜杠打不出来（斜杠就是进下一层）；打个不存在的名字 → 新建
  await input.pressSequentially("sub");
  await expect(picker.getByRole("option", { name: "新建文件夹 “sub”" })).toHaveAttribute("data-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveValue(`${MANAGED}/sub/`);
  expect(existsSync(`${MANAGED}/sub`)).toBe(true);

  // 空片段 Backspace 回上一级；Enter 进入选中的文件夹
  await input.press("Backspace");
  await expect(input).toHaveValue(`${MANAGED}/`);
  await input.pressSequentially("su");
  await input.press("Enter");
  await expect(input).toHaveValue(`${MANAGED}/sub/`);
  await input.press("Control+Enter");
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
  const input = pathBox(picker);
  await expect(input).toHaveValue(`${MANAGED}/`);

  await input.fill(`${SCRATCH}/`);
  await expect(picker.getByRole("option", { name: /repo/ })).toContainText("⎇");
  await expect(picker.getByRole("option", { name: /plain/ })).not.toContainText("⎇");
  // 模糊筛：pln 命中 plain，repo 被筛掉；Tab 补全进入
  await input.pressSequentially("pln");
  await expect(picker.getByRole("option", { name: /repo/ })).toHaveCount(0);
  await input.press("Tab");
  await expect(input).toHaveValue(`${SCRATCH}/plain/`);

  // 一路 Backspace 到 root（/tmp）就停住，没有「上一级」
  await input.fill("/tmp/");
  await expect(picker.getByRole("option", { name: /使用 \/tmp\b/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: "上一级" })).toHaveCount(0);
  await input.press("Backspace");
  await expect(input).toHaveValue("/tmp/");
  await panel.getByRole("button", { name: "取消" }).click();
}

async function mobileFullScreen(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("navigation").getByTitle("新建项目").click();
  const panel = page.getByLabel("新建项目");
  const picker = page.getByLabel("目录选择器");
  await expect(picker).toHaveCount(0);
  await panel.getByLabel("项目名").fill(NAME);
  await panel.getByRole("button", { name: "浏览…" }).click();
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.height)).toBe(844);
  await expect(pathBox(picker)).toHaveValue(`${MANAGED}/`);
  // 行高够手指点
  const row = await picker.getByRole("option").first().boundingBox();
  expect(row!.height).toBeGreaterThanOrEqual(44);
  await expect(
    picker.getByRole("button", { name: "使用", exact: true }),
  ).toBeInViewport();
  await picker.getByRole("button", { name: "关闭" }).click();
  await expect(picker).toHaveCount(0);
}

async function newFolderButton(page: Page, width: number, tag: string) {
  await page.setViewportSize({ width, height: 844 });
  mkdirSync(`${MANAGED}/sub`, { recursive: true });
  let panel, picker;
  if (width < 768) {
    // 手机上选择器默认收起，直接点「浏览…」
    await page.goto("/");
    await page.getByRole("navigation").getByTitle("新建项目").click();
    panel = page.getByLabel("新建项目");
    picker = page.getByLabel("目录选择器");
    await panel.getByLabel("项目名").fill(NAME);
    await panel.getByRole("button", { name: "浏览…" }).click();
  } else ({ panel, picker } = await openPickerFor(page, NAME));
  const input = pathBox(picker);
  await expect(input).toHaveValue(`${MANAGED}/`);
  const button = picker.getByRole("button", { name: "新建文件夹" });
  await expect(button).toBeInViewport();
  if (width < 768) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Esc 取消
  await button.click();
  const name = picker.getByLabel("新文件夹名");
  await expect(name).toBeFocused();
  await name.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(picker).toBeVisible();

  // 同名 / 空名：就地报错
  await button.click();
  await name.fill("sub");
  await name.press("Enter");
  await expect(picker.getByRole("alert")).toHaveText("这里已经有同名文件夹");
  await name.fill("");
  await name.press("Enter");
  await expect(picker.getByRole("alert")).toHaveText("名字不能为空");

  // ↵ 建好、进入、「使用」选中它
  const folder = `new-${tag}`;
  await name.fill(folder);
  await page.screenshot({ path: `/workspace/screenshots/picker-new-folder-${tag}.png` });
  await name.press("Enter");
  await expect(input).toHaveValue(`${MANAGED}/${folder}/`);
  expect(existsSync(`${MANAGED}/${folder}`)).toBe(true);
  await expect(picker.getByRole("option", { name: new RegExp(`使用 .*${folder}`) })).toHaveAttribute("data-selected", "true");
  if (width < 768) await picker.getByRole("button", { name: "关闭" }).click();
  else await panel.getByRole("button", { name: "取消" }).click();
}
