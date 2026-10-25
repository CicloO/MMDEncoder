// Test resources are built separately and never enter dist/ or a portable app.
import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/locale-ui-"));
const outDir = path.join(dir, "fixture-dist");
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
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      await BrowserWindow.getAllWindows()[0].loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/index.html"),
  );
  await page.getByRole("radiogroup", { name: "背景颜色" }).waitFor();
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
  await page.screenshot({ path: path.join(dir, "pseudo-background.png") });
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
