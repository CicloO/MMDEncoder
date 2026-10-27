import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/modal-focus-"));
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({
    version: require("../package.json").version,
    main: "main.cjs",
  }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `const{createRequire}=require('node:module');const native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});const u=native('../backend/update.cjs');u.checkForUpdate=async current=>({current,latest:current,newer:false,url:u.RELEASES_URL});native('./main.cjs');`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TOOLS_ROOT: path.join(dir, "no-tools"),
  },
  timeout: 60000,
});
const checks = [];
try {
  const page = await app.firstWindow();
  const engine = page.getByRole("dialog", { name: "编码引擎", exact: true });
  await expect(engine).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(engine).toBeHidden();
  const engineOpener = page.getByRole("button", {
    name: /个可用编码器|检测编码器/,
  });
  await engineOpener.click();
  await expect(engine).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(engineOpener).toBeFocused();
  checks.push("manual-engine-close-restores-opener");
  await engineOpener.press("Enter");
  await expect(engine).toBeVisible();
  await engine
    .getByRole("button", { name: "检测日志与版本", exact: true })
    .click();
  const logs = page.getByRole("dialog", { name: "任务日志", exact: true });
  await expect(logs).toBeVisible();
  await expect(
    logs.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(engineOpener).toBeFocused();
  checks.push("dialog-handoff-keeps-new-focus-and-returns-to-external-opener");
  const aboutOpener = page.getByRole("button", {
    name: "关于与语言 · Language",
    exact: true,
  });
  await aboutOpener.click();
  const about = page.getByRole("dialog", { name: "关于", exact: true });
  await expect(about).toBeVisible();
  await about.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(aboutOpener).toBeFocused();
  checks.push("about-close-button-restores-opener");
  const saveAs = page.getByRole("button", { name: "另存为预设", exact: true });
  await saveAs.click();
  const save = page.getByRole("dialog", { name: "保存当前配置", exact: true });
  await expect(save.locator("#preset-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(saveAs).toBeFocused();
  checks.push("save-input-initial-focus-and-return");
  const presetOpener = page.getByRole("button", {
    name: "预设管理",
    exact: true,
  });
  await presetOpener.click();
  const manager = page.getByRole("dialog", { name: "预设管理", exact: true });
  await expect(manager).toBeVisible();
  const deletion = page.getByRole("dialog", {
    name: "删除个人预设",
    exact: true,
  });
  const remove = manager
    .locator(".preset-item")
    .first()
    .getByRole("button", { name: /^删除预设 / });
  await remove.click();
  await expect(
    deletion.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await deletion.getByRole("button", { name: "取消", exact: true }).click();
  await expect(remove).toBeFocused();
  checks.push("nested-delete-focuses-cancel-and-restores-parent-control");
  await remove.click();
  await expect(
    deletion.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await deletion.getByRole("button", { name: "删除预设", exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(
    manager.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  checks.push("removed-opener-falls-back-inside-surviving-parent-dialog");
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  await page.keyboard.press("Escape");
  await expect(presetOpener).toBeFocused();
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks,
        focus: await page.evaluate(() => document.activeElement?.outerHTML),
      },
      null,
      2,
    ),
  );
  console.log("Shared modal focus PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        active: await page.evaluate(() => document.activeElement?.outerHTML),
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
