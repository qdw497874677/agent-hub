import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { loginByApi } from "./login.ts";
import { currentRun } from "./run-id.ts";

const ROOT = "/tmp/agent-hub-e2e-data/worker-assets";
const skill = (name: string, body: string) =>
  Buffer.from(`---\nname: ${name}\ndescription: e2e 技能 ${name}\n---\n\n${body}\n`);

/** 资产中心：上传技能 → 装到本机 → 落盘 → 新版本看差异后确认升级 → 删除后机器上也没了。 */
test("上传技能、装到本机、看差异升级、删除，机器上的目录跟着变", async ({ page }) => {
  const name = `e2e-skill-${currentRun()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const onDisk = `${ROOT}/skills/${name}/SKILL.md`;
  await loginByApi(page);
  await page.goto("/#/admin/assets");
  await expect(page.getByRole("heading", { name: "资产", exact: true })).toBeVisible();

  await page.getByTestId("asset-add").click();
  await page.getByTestId("asset-files").setInputFiles([
    { name: "SKILL.md", mimeType: "text/markdown", buffer: skill(name, "第一版：说 PINEAPPLE。") },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("附注") }
  ]);
  await page.getByTestId("asset-upload").click();
  const item = page.getByTestId("asset-item").filter({ hasText: name });
  await expect(item).toContainText("2 个文件");

  try {
    // 装到本机：芯片变成按下，机器同步后文件落在独立目录里
    const chip = item.getByTestId("asset-worker").filter({ hasText: "本机" });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => existsSync(onDisk) && readFileSync(onDisk, "utf8")).toContain("第一版");
    await expect(page.getByTestId("asset-sync").filter({ hasText: "本机" })).toContainText("已同步");

    // 新版本：先不生效，看差异、确认后才升级
    await item.getByTestId("asset-revision-files").setInputFiles([
      { name: "SKILL.md", mimeType: "text/markdown", buffer: skill(name, "第二版：说 MANGO。") }
    ]);
    await expect(item.getByTestId("asset-upgrade")).toBeVisible();
    expect(readFileSync(onDisk, "utf8")).toContain("第一版");
    await item.getByTestId("asset-upgrade").click();
    const diff = page.getByTestId("asset-diff");
    await expect(diff).toContainText("+第二版：说 MANGO。");
    await expect(diff).toContainText("notes.md");
    await page.getByTestId("asset-pin").click();
    await expect(item.getByTestId("asset-upgrade")).toHaveCount(0);
    await expect.poll(() => existsSync(onDisk) && readFileSync(onDisk, "utf8")).toContain("第二版");
    expect(existsSync(`${ROOT}/skills/${name}/notes.md`)).toBe(false);
  } finally {
    page.once("dialog", (dialog) => void dialog.accept());
    await item.getByRole("button", { name: "删除" }).click();
    await expect(item).toHaveCount(0);
  }
  await expect.poll(() => existsSync(`${ROOT}/skills/${name}`)).toBe(false);
});
