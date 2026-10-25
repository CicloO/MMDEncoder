// Only the alignment surface; pseudo resources stay outside production dist.
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
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/align-locale-"));
const outDir = path.join(dir, "fixture-dist");
const audio = path.join(dir, "User 音频.wav");
const short = path.join(dir, "User short.wav");
for (const [file, duration] of [
  [audio, 3],
  [short, 0.2],
])
  execFileSync(require("./engines.cjs").ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=d=${duration}:r=24000`,
    file,
  ]);
await build({
  root,
  base: "./",
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/align.html") },
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
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const state = await window.encoder.invoke("state");
          return state.located && !state.detecting;
        }),
      { timeout: 60000 },
    )
    .toBe(true);
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      await BrowserWindow.getAllWindows()[0].loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/align.html"),
  );
  await page
    .getByRole("button", { name: "Alignment fixture focus target" })
    .waitFor();
  const labels = await page.evaluate(() => window.alignLocale.pseudo);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(
    (file) =>
      window.alignLocale.open({
        targetPath: file,
        initial: { reference: file, offset: 0.125, trim: true },
      }),
    audio,
  );
  let dialog = page.getByRole("dialog", { name: "音频对齐", exact: true });
  await expect(
    dialog.getByRole("button", { name: "播放", exact: true }),
  ).toBeEnabled();
  await dialog.locator("#align-step").selectOption("0.001");
  await dialog.getByRole("button", { name: "目标左移", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "导出时截到参考的长度（不够时补静音）" })
    .uncheck();
  await expect(dialog.getByText(/目标开头多出 0\.1260 秒/)).toBeVisible();
  await page.evaluate(() => window.alignLocale.choose("en-XA"));
  dialog = page.getByRole("dialog", {
    name: labels["align.title"],
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#align-step")).toHaveValue("0.001");
  await expect(dialog.locator('#align-step option[value="0.001"]')).toHaveText(
    labels["align.step1ms"],
  );
  await expect(
    dialog.getByRole("checkbox", { name: labels["align.trim"] }),
  ).not.toBeChecked();
  await expect(dialog.locator(".path-text")).toHaveText("User 音频.wav");
  await expect(
    dialog.getByText(labels["align.trimHead"].replace("{seconds}", "0.1260")),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: labels["align.play"], exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByLabel(labels["align.targetWave"], { exact: true }),
  ).toBeVisible();
  for (const width of [1280, 680]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await dialog.evaluate((node) => ({
      scroll: node.scrollWidth,
      width: node.clientWidth,
    }));
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
    await page.screenshot({
      path: path.join(dir, `pseudo-align-${width}.png`),
    });
  }
  await dialog
    .getByRole("button", { name: labels["align.apply"], exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const applied = await page.evaluate(() => window.alignLocale.applied());
  assert.equal(applied.reference, audio);
  assert.ok(Math.abs(applied.offset - 0.126) < 1e-12);
  assert.equal(applied.trim, false);
  // A real worker error stays structured while the open dialog changes language.
  await page.evaluate(() => window.alignLocale.choose("zh-CN"));
  await page.evaluate(
    (file) =>
      window.alignLocale.open({ targetPath: file, fixedReference: file }),
    short,
  );
  dialog = page.getByRole("dialog", { name: "音频对齐", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText(
    "自动对齐失败：音频太短，至少需要 1 秒",
  );
  await page.evaluate(() => window.alignLocale.choose("en-XA"));
  dialog = page.getByRole("dialog", {
    name: labels["align.title"],
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toHaveText(
    labels["error.ALIGN_TOO_SHORT"].replace("{seconds}", "1"),
  );
  await expect(
    dialog.getByRole("button", { name: labels["align.auto"], exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: path.join(dir, "pseudo-align-error.png") });
  await dialog
    .getByRole("button", { name: labels["align.cancel"], exact: true })
    .click();
  await expect(dialog).toBeHidden();
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify(
      {
        applied,
        checks: [
          "open-locale-refresh",
          "draft-offset-trim-preserved",
          "technical-values-and-user-path",
          "wide-narrow-overflow",
          "worker-error-reformatted",
          "cancel",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Desktop alignment locale PASS", dir);
} finally {
  await app.close();
}
