// 单独设置: each video with it on has its own settings in the panel, the
// page keeps its own, and switching it off drops the video's changes.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.resolve(root, "verification");
const work = path.resolve(root, "verification/work");
fs.mkdirSync(work, { recursive: true });
const testDir = fs.mkdtempSync(path.join(work, "job-settings-"));
const inputs = ["第一段.mp4", "第二段.mp4"].map((n) => path.join(testDir, n));
for (const input of inputs)
  execFileSync(require("./engines.cjs").ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=1",
    "-c:v",
    "libx264",
    input,
  ]);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(testDir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1280, 900);
    w.showInactive();
  });
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  await expect
    .poll(async () => (await state()).located, { timeout: 60000 })
    .toBe(true);
  await page.evaluate(
    (paths) => window.encoder.invoke("add", { paths }),
    inputs,
  );
  await expect
    .poll(async () => (await state()).jobs.every((j) => j.status !== "probing"))
    .toBe(true);
  const rows = page.locator(".job-row .job-select");
  const toggle = page.getByRole("checkbox", { name: "单独设置" });
  const container = page.locator("#container");
  const page0 = (await state()).settings.container;
  const other = page0 === "mkv" ? "mov" : "mkv";

  // First video on its own: its container changes, the page's does not.
  await rows.nth(0).click();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator(".job-preset-note")).toBeVisible();
  await container.selectOption(other);
  await expect
    .poll(async () => (await state()).jobs[0].ownSettings?.container)
    .toBe(other);
  assert.equal((await state()).settings.container, page0);
  await expect(page.locator(".job-target")).toHaveCount(1);
  await expect(page.locator(".job-target")).toContainText(other.toUpperCase());

  // The second video shows the page's settings; back to the first, its own.
  await rows.nth(1).click();
  await expect(toggle).not.toBeChecked();
  await expect(container).toHaveValue(page0);
  await rows.nth(0).click();
  await expect(toggle).toBeChecked();
  await expect(container).toHaveValue(other);
  await page.screenshot({ path: path.join(evidence, "job-settings.png") });

  // Off drops the first video's changes; on again starts from the page.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(async () => (await state()).jobs[0].ownSettings)
    .toBeUndefined();
  await expect(container).toHaveValue(page0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect
    .poll(async () => (await state()).jobs[0].ownSettings?.container)
    .toBe(page0);
  await expect(container).toHaveValue(page0);
  assert.equal((await state()).settings.container, page0);
  console.log("Desktop job settings PASS");
  passed = true;
} finally {
  await app.close();
  if (passed) fs.rmSync(testDir, { recursive: true, force: true });
}
