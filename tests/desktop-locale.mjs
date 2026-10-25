// Test resources are built separately and never enter dist/ or a portable app.
import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/locale-ui-"));
const outDir = path.join(dir, "fixture-dist");
const shortAudio = path.join(dir, "short.wav");
execFileSync(require("./engines.cjs").ff, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=d=0.2:r=24000",
  shortAudio,
]);
await build({
  root,
  base: "./",
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/index.html") },
  },
});
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  const screenshot = async (file) => {
    const bytes = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    assert.ok(bytes.length > 100, "Electron returned an empty screenshot");
    fs.writeFileSync(file, Buffer.from(bytes, "base64"));
  };
  await page
    .getByRole("heading", { name: "视频队列" })
    .waitFor({ timeout: 30000 });
  // Real preload and IPC, with an unsupported value falling back to Chinese.
  const chosen = await page.evaluate(() =>
    window.encoder.invokeResult("setLocale", { locale: "not-supported" }),
  );
  assert.equal(chosen.locale, "zh-CN");
  assert.equal(chosen.settings.locale, undefined);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const state = await window.encoder.invoke("state");
          return state.located && !state.detecting;
        }),
      { timeout: 30000 },
    )
    .toBe(true);
  // The ordinary app uses the structured MMD action path and real encoder.
  await page.getByRole("button", { name: "MMD 导出", exact: true }).click();
  const mmdDialog = page.getByRole("dialog", { name: "MMD 导出", exact: true });
  await expect(
    mmdDialog.getByRole("button", { name: "测试编码", exact: true }),
  ).toBeEnabled();
  await mmdDialog
    .getByRole("button", { name: "测试编码", exact: true })
    .click();
  await expect(mmdDialog.getByText(/测试编码通过/)).toBeVisible({
    timeout: 60000,
  });
  const result = await page.evaluate(
    async () => (await window.encoder.invoke("state")).mmd.test,
  );
  assert.equal(result.code, "MMD_TEST_PASSED");
  assert.equal(typeof result.params.seconds, "number");
  await page.keyboard.press("Escape");
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      await BrowserWindow.getAllWindows()[0].loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/index.html"),
  );
  await page.getByRole("radiogroup", { name: "背景颜色" }).waitFor();
  const workerError = await page.evaluate(async (file) => {
    try {
      await window.localeFixture.invoke("alignRun", {
        reference: file,
        target: file,
      });
    } catch (error) {
      return { code: error.code, params: error.params, message: error.message };
    }
  }, shortAudio);
  assert.equal(workerError.code, "ALIGN_TOO_SHORT");
  assert.deepEqual(workerError.params, { seconds: 1 });
  assert.match(workerError.message, /至少需要 1 秒/);
  await page
    .getByRole("textbox", { name: "draft", exact: true })
    .fill("unsaved draft");
  await expect
    .poll(() => page.evaluate(() => window.localeFixture.mounts()))
    .toBe(1);
  const labels = await page.evaluate(() => window.localeFixture.pseudo);
  await page.evaluate(() => window.localeFixture.choose("en-XA"));
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  await expect(page).toHaveTitle(labels["app.title"]);
  await expect(
    page.getByRole("radio", { name: labels["background.green"], exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("textbox", {
      name: labels["background.hexLabel"],
      exact: true,
    }),
  ).toHaveValue("#00FF00");
  await expect(page.getByLabel("自选背景颜色", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "draft", exact: true }),
  ).toHaveValue("unsaved draft");
  assert.equal(await page.evaluate(() => window.localeFixture.mounts()), 1);
  await page.setViewportSize({ width: 680, height: 760 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page
    .getByRole("radio", { name: labels["background.black"], exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("radio", { name: labels["background.black"], exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  await screenshot(path.join(dir, "pseudo-background.png"));
  await page.evaluate(() => window.localeFixture.openMmd());
  const longDialog = page.getByRole("dialog", {
    name: labels["mmd.title"],
    exact: true,
  });
  await expect(longDialog).toBeVisible();
  await expect(
    longDialog.getByLabel(labels["mmd.follow"], { exact: false }),
  ).toBeChecked();
  await expect(
    longDialog.getByLabel(labels["mmd.mask"], { exact: true }),
  ).toBeVisible();
  const box = await longDialog.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 681);
  await screenshot(path.join(dir, "pseudo-mmd-dialog.png"));
  await longDialog
    .getByRole("button", { name: labels["mmd.test"], exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    longDialog.getByRole("button", { name: labels["mmd.test"], exact: true }),
  ).toBeVisible();
  await screenshot(path.join(dir, "pseudo-mmd-actions.png"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.localeFixture.choose("unknown"));
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("MMDEncoder · 视频压制");
  await expect(
    page.getByRole("radio", { name: "黑", exact: true }),
  ).toBeChecked();
  assert.equal(await page.evaluate(() => window.localeFixture.mounts()), 1);
  console.log("Desktop locale PASS", dir);
} finally {
  await app.close();
}
