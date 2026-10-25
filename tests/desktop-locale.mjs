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
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
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
  await page.evaluate(() => window.localeFixture.failPreset());
  await expect(page.getByRole("alert")).toHaveText("预设名称须为 1–80 字符");
  const presetChoice = page.locator("#preset-select");
  await presetChoice.selectOption("builtin-prores422");
  await page.evaluate(() => window.localeFixture.choose("en-XA"));
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  await expect(page).toHaveTitle(labels["app.title"]);
  await expect(page.getByRole("alert")).toHaveText(
    labels["error.PRESET_NAME_INVALID"],
  );
  await expect(
    page.getByRole("combobox", { name: labels["preset.choice"], exact: true }),
  ).toHaveValue("builtin-prores422");
  await expect(presetChoice.locator('option[value="builtin-4k"]')).toHaveText(
    labels["preset.default4kHardware"],
  );
  await expect(
    presetChoice.locator('option[value="test-preset-policy"]'),
  ).toHaveText("User name 用户名称");
  await expect(page.locator('#audio-fixture option[value="none"]')).toHaveText(
    labels["presentation.audio.none"],
  );
  await expect(page.locator('#fade-fixture option[value="0"]')).toHaveText(
    labels["presentation.fadeOff"],
  );
  await expect(page.getByLabel("status fixture")).toHaveText(
    labels["presentation.status.cancelled"],
  );
  await expect(page.getByLabel("unknown fixture")).toHaveText(
    labels["presentation.unknown"],
  );
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
  await page.evaluate(() => window.localeFixture.openPresets());
  const presetDialog = page.getByRole("dialog", {
    name: "preset fixture",
    exact: true,
  });
  await expect(presetDialog).toBeVisible();
  await expect(
    presetDialog.getByRole("button", {
      name: labels["preset.deleteName"].replace(
        "{name}",
        labels["preset.default4kHardware"],
      ),
      exact: true,
    }),
  ).toHaveCount(1);
  const presetBox = await presetDialog.boundingBox();
  assert.ok(presetBox.x >= 0 && presetBox.x + presetBox.width <= 681);
  await page
    .getByRole("button", { name: labels["preset.rename"], exact: true })
    .last()
    .scrollIntoViewIfNeeded();
  await screenshot(path.join(dir, "pseudo-presets.png"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.localeFixture.openMmd());
  const longDialog = page.getByRole("dialog", {
    name: labels["mmd.title"],
    exact: true,
  });
  await expect(longDialog).toBeVisible();
  await expect(
    longDialog.locator('option[value="test-preset-policy"]'),
  ).toBeDisabled();
  await expect(
    longDialog.locator('option[value="test-preset-policy"]'),
  ).toContainText("User name 用户名称");
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
  await page.evaluate(() => window.localeFixture.choose("zh-CN"));
  await expect(
    page
      .getByRole("dialog", { name: "MMD 导出", exact: true })
      .locator('option[value="test-preset-policy"]'),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.localeFixture.choose("unknown"));
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("MMDEncoder · 视频压制");
  await expect(presetChoice).toHaveValue("builtin-prores422");
  await expect(page.getByRole("alert")).toHaveText("预设名称须为 1–80 字符");
  await expect(
    page.getByRole("radio", { name: "黑", exact: true }),
  ).toBeChecked();
  assert.equal(await page.evaluate(() => window.localeFixture.mounts()), 1);
  // The migrated video surface uses the real components and the same locale
  // root. Keep edits, selected task and stage/progress while text refreshes.
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.evaluate(() => window.localeFixture.openVideo());
  await page.locator("#fps").selectOption("custom");
  await page.locator("#custom-fps").fill("30000/1001");
  const videoBefore = await page.evaluate(() =>
    window.localeFixture.videoSnapshot(),
  );
  await page.getByRole("button", { name: "清除已完成", exact: true }).click();
  await expect(page.getByLabel("video notification")).toHaveText(
    "已移除完成项，输出文件保留",
  );
  await page.evaluate(() => window.localeFixture.choose("en-XA"));
  await expect(page.getByLabel("video notification")).toHaveText(
    labels["message.VIDEO_CLEARED"],
  );
  await expect(page.locator('#fps option[value="source"]')).toHaveText(
    labels["video.fpsSource"],
  );
  await expect(page.locator('#fps option[value="24000/1001"]')).toContainText(
    "23.976",
  );
  await expect(
    page.getByLabel(labels["video.customFPS"], { exact: true }),
  ).toHaveValue("30000/1001");
  await expect(page.locator(".job-status.encoding")).toContainText(
    labels["stage.video_encoding_with_mask"],
  );
  await expect(
    page.getByRole("button", { name: labels["output.start"], exact: true }),
  ).toBeDisabled();
  assert.deepEqual(
    await page.evaluate(() => window.localeFixture.videoSnapshot()),
    videoBefore,
  );
  await screenshot(path.join(dir, "pseudo-video-settings.png"));
  await page
    .getByRole("button", { name: labels["video.tab.rtx"], exact: true })
    .click();
  await page.locator("#vfg").check();
  await expect(
    page.getByText(labels["rtx.changed"], { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: labels["rtx.check"], exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(path.join(dir, "pseudo-video-rtx.png"));
  await page
    .locator(".job-select")
    .filter({ hasText: "User partial.mov" })
    .click();
  await expect(page.locator(".detail-card .inline-error")).toContainText(
    labels["error.AUDIO_BITRATE_INVALID"],
  );
  await expect(page.locator(".detail-card .inline-error")).toContainText(
    "Foreign diagnostic stays exact",
  );
  await expect(
    page.getByRole("button", {
      name: labels["message.COMPAT_ENCODER_FIX"],
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 680, height: 760 });
  await page
    .getByRole("button", { name: labels["video.tab.output"], exact: true })
    .click();
  await expect(page.locator("#nameTemplate")).toHaveValue("{name}_User名");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#nameTemplate").scrollIntoViewIfNeeded();
  await screenshot(path.join(dir, "pseudo-video-narrow.png"));
  const dismiss = page.getByRole("button", {
    name: labels["video.closeHint"],
    exact: true,
  });
  const dismissBox = await dismiss.boundingBox();
  assert.ok(
    dismissBox.width >= 30 &&
      dismissBox.x >= 0 &&
      dismissBox.x + dismissBox.width <= 680,
  );
  const videoChanged = await page.evaluate(() =>
    window.localeFixture.videoSnapshot(),
  );
  await page.evaluate(() => window.localeFixture.choose("zh-CN"));
  await expect(page.locator("#nameTemplate")).toHaveValue("{name}_User名");
  await expect(page.locator(".detail-card .inline-error")).toContainText(
    "音频码率无效，请选择列表中的码率",
  );
  assert.deepEqual(
    await page.evaluate(() => window.localeFixture.videoSnapshot()),
    videoChanged,
  );
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(page.locator(".error-banner")).toHaveCount(0);
  console.log("Desktop locale PASS", dir);
} finally {
  await app.close();
}
