// Separate alignment / metadata / media modes; test resources stay outside dist.
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
  if (process.argv[2] === "media") {
    const longOutputName = "User " + "保存后的长文件名".repeat(12) + " (2).wav";
    await page.evaluate(() => window.alignLocale.showMedia());
    await page.getByLabel("操作", { exact: true }).selectOption("merge");
    await page.getByLabel("输出音频", { exact: true }).selectOption("opus");
    await page.getByLabel("音频码率", { exact: true }).selectOption("256");
    await page.getByLabel("输出音频", { exact: true }).selectOption("flac");
    await page
      .getByLabel("Hi-Res 音频（24-bit，低于 48 kHz 时升到 2 倍采样率）", {
        exact: false,
      })
      .check();
    await page.getByLabel("输出格式", { exact: true }).selectOption("mkv");
    await page.getByLabel("输出位置", { exact: true }).selectOption("encoded");
    await page.getByLabel("选择音频后自动对齐", { exact: false }).uncheck();
    await page
      .locator(".job-select")
      .filter({ hasText: "User failed.mov" })
      .click();
    await page
      .getByRole("button", { name: "移除 User failed.mov", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "文件不在列表中" }),
    ).toBeVisible();
    await page.getByText("实际命令与日志", { exact: true }).click();
    const before = await page.evaluate(() =>
      localStorage.getItem("mmd-media-options"),
    );
    await page.evaluate(() => window.alignLocale.choose("en-XA"));
    await expect(
      page.getByRole("heading", {
        name: labels["media.queue"] + " 4",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#media-operation")).toHaveValue("merge");
    await expect(page.locator("#media-format")).toHaveValue("flac");
    await expect(page.locator("#media-container")).toHaveValue("mkv");
    await expect(page.locator("#media-location")).toHaveValue("encoded");
    await expect(
      page.locator('.job-select[aria-pressed="true"] strong'),
    ).toHaveText("User failed.mov");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: labels["error.MEDIA_JOB_MISSING"] }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: labels["error.MEDIA_COPY_ALIGN"] }),
    ).toBeVisible();
    await expect(page.locator(".media-log")).toHaveText(
      "Foreign diagnostic stays exact",
    );
    await expect(page.locator(".output-file-name")).toHaveText(longOutputName);
    await expect(page.locator(".output-file-name")).toHaveAttribute(
      "title",
      "C:/output/" + longOutputName,
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("mmd-media-options")),
      before,
    );
    const dimensions = [];
    for (const width of [1280, 680]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => ({
        viewport: innerHeight,
        bottom: document
          .querySelector(".page > .output-strip")
          .getBoundingClientRect().bottom,
        scroll: document.documentElement.scrollWidth,
        width: document.documentElement.clientWidth,
      }));
      assert.ok(
        Math.abs(metrics.viewport - metrics.bottom) <= 1,
        JSON.stringify(metrics),
      );
      assert.ok(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
      dimensions.push({ width, ...metrics });
      await screenshot(path.join(dir, `pseudo-media-${width}.png`));
      if (width === 680) {
        const file = page.locator(".output-file-name");
        await file.scrollIntoViewIfNeeded();
        const lead = await file
          .locator(".output-file-lead")
          .evaluate((node) => ({
            width: node.clientWidth,
            scroll: node.scrollWidth,
          }));
        assert.ok(lead.scroll > lead.width, JSON.stringify(lead));
        await expect(file.locator(".output-file-tail")).toBeVisible();
        await screenshot(path.join(dir, "pseudo-media-filename-narrow.png"));
      }
    }
    fs.writeFileSync(
      path.join(dir, "media-results.json"),
      JSON.stringify(
        {
          options: JSON.parse(before),
          dimensions,
          checks: [
            "open-locale-refresh",
            "selection-and-options-preserved",
            "structured-action-and-job-errors",
            "external-log-exact",
            "wide-narrow-footer-and-overflow",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Desktop media locale PASS", dir);
  } else if (process.argv[2] === "metadata") {
    await page.evaluate(
      (file) => window.encoder.invoke("mediaAdd", { paths: [file] }),
      audio,
    );
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            !!(await window.encoder.invoke("state")).mediaJobs[0]?.meta,
        ),
      )
      .toBe(true);
    const data = await page.evaluate(async () => {
      const job = (await window.encoder.invoke("state")).mediaJobs[0];
      const details = await window.encoder.invoke("details", {
        id: job.id,
        media: true,
      });
      window.alignLocale.showMetadata({ meta: job.meta, details });
      return { meta: job.meta, details };
    });
    let dialog = page.getByRole("dialog", { name: "文件详情", exact: true });
    await expect(
      dialog.getByText("尚未生成文件", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.alignLocale.choose("en-XA"));
    dialog = page.getByRole("dialog", {
      name: labels["details.title"],
      exact: true,
    });
    await expect(
      dialog.getByText(labels["meta.audioOnly"], { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(labels["details.before"], { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(labels["error.DETAILS_OUTPUT_MISSING"], { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".path-text")).toHaveText(audio);
    await dialog.locator("details > summary").click();
    assert.deepEqual(
      JSON.parse(await dialog.locator("pre").innerText()),
      data.details.before,
    );
    await dialog.locator("details > summary").click();
    for (const width of [1280, 680]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await dialog.evaluate((node) => ({
        scroll: node.scrollWidth,
        width: node.clientWidth,
      }));
      assert.ok(
        overflow.scroll <= overflow.width + 1,
        JSON.stringify(overflow),
      );
      await screenshot(path.join(dir, `pseudo-metadata-${width}.png`));
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    fs.writeFileSync(
      path.join(dir, "metadata-results.json"),
      JSON.stringify(
        {
          data,
          checks: [
            "metadata-label-refresh",
            "structured-missing-output",
            "actual-ffprobe-json-unchanged",
            "user-path-exact",
            "wide-narrow-overflow",
            "escape",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Desktop metadata locale PASS", dir);
  } else {
    await page.evaluate(
      (file) =>
        window.alignLocale.open({
          targetPath: file,
          initial: {
            reference: file,
            offset: 0.125,
            trim: true,
            shiftFrames: 2,
          },
          frameShift: true,
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
    await expect(dialog.getByText(/目标开头多出 0\.0593 秒/)).toBeVisible();
    await expect(
      dialog.getByLabel("音频偏移（帧）", { exact: true }),
    ).toHaveValue("2");
    await expect(
      dialog.getByText(/参考仅有音频，按 30 FPS 计算/),
    ).toBeVisible();
    await page.evaluate(() => window.alignLocale.choose("en-XA"));
    dialog = page.getByRole("dialog", {
      name: labels["align.title"],
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#align-step")).toHaveValue("0.001");
    await expect(
      dialog.locator('#align-step option[value="0.001"]'),
    ).toHaveText(labels["align.step1ms"]);
    await expect(
      dialog.getByRole("checkbox", { name: labels["align.trim"] }),
    ).not.toBeChecked();
    await expect(dialog.locator(".path-text")).toHaveText("User 音频.wav");
    await expect(
      dialog.getByText(labels["align.trimHead"].replace("{seconds}", "0.0593")),
    ).toBeVisible();
    await expect(
      dialog.getByLabel(labels["align.shiftFrames"], { exact: true }),
    ).toHaveValue("2");
    await expect(
      dialog.getByText(labels["align.shiftAudioFallback"]),
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
      assert.ok(
        overflow.scroll <= overflow.width + 1,
        JSON.stringify(overflow),
      );
      await screenshot(path.join(dir, `pseudo-align-${width}.png`));
    }
    await dialog
      .getByRole("button", { name: labels["align.apply"], exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const applied = await page.evaluate(() => window.alignLocale.applied());
    assert.equal(applied.reference, audio);
    assert.ok(Math.abs(applied.offset - 0.126) < 1e-12);
    assert.equal(applied.trim, false);
    assert.equal(applied.shiftFrames, 2);
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
    await screenshot(path.join(dir, "pseudo-align-error.png"));
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
  }
} finally {
  await app.close();
}
