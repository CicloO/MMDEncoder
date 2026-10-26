// The workbench renders the actual TrimTools in the production page containers.
// Real JPEG / indexing / export remain covered by desktop-trim and trim-service.
import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/trim-locale-"));
const outDir = path.join(dir, "fixture-dist");
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
          const s = await window.encoder.invoke("state");
          return s.located && !s.detecting;
        }),
      { timeout: 60000 },
    )
    .toBe(true);
  await app.evaluate(
    async ({ BrowserWindow }, file) =>
      BrowserWindow.getAllWindows()[0].loadFile(file),
    path.join(outDir, "tests/fixtures/i18n/align.html"),
  );
  await page
    .getByRole("button", { name: "Alignment fixture focus target" })
    .waitFor();
  await page.evaluate(() => {
    localStorage.setItem(
      "mmd-trim-options",
      JSON.stringify({
        audioMode: "none",
        mmdFrames: true,
        location: "custom",
        outputDir: "C:/User 目标文件夹",
        kbps: 192,
      }),
    );
    window.alignLocale.showTrim();
  });
  await expect(page.locator(".trim-preview img")).toBeVisible();
  const slider = page.getByRole("slider", { name: "当前帧" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("31");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.alignLocale
            .trimSnapshot()
            .calls.filter((c) => c.action === "trimFrame").length,
      ),
    )
    .toBe(2);
  const input = page.locator("#trim-in");
  await input.fill("437");
  const before = await page.evaluate(() => ({
    snapshot: window.alignLocale.trimSnapshot(),
    options: localStorage.getItem("mmd-trim-options"),
  }));
  const labels = await page.evaluate(() => window.alignLocale.pseudo);
  const measurements = [];
  for (const locale of ["en-XA", "zh-CN", "unsupported", "en-XA"]) {
    await page.evaluate((locale) => window.alignLocale.choose(locale), locale);
    const expanded = locale === "en-XA";
    await expect(
      page.getByRole("heading", {
        name: expanded ? labels["trim.exportSettings"] : "导出设置",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#trim-audio option:checked")).toHaveText(
      expanded ? labels["trim.audioMode.none"] : "无音频",
    );
    await expect(
      page.getByText(
        expanded ? labels["error.TRIM_AUDIO_CODEC_INVALID"] : "音频格式无效",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(input).toHaveValue("437");
    await expect(page.locator(".trim-track input")).toHaveValue("31");
    await expect(
      page.getByText("Foreign diagnostic stays exact", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".trim-editor h3")).toHaveText("User 原片.mp4");
    await expect(
      page.locator(".path-text[title='C:/User 目标文件夹']"),
    ).toHaveText("C:/User 目标文件夹");
  }
  assert.deepEqual(
    await page.evaluate(() => ({
      snapshot: window.alignLocale.trimSnapshot(),
      options: localStorage.getItem("mmd-trim-options"),
    })),
    before,
    "locale changes do not remount, request new frames, apply drafts or rewrite options",
  );
  for (const width of [1360, 700]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const measured = await page.locator(".page-scroll").evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    assert.ok(
      measured.scroll <= measured.width,
      JSON.stringify({ width, measured }),
    );
    const footer = await page.locator("footer").boundingBox();
    assert.ok(
      footer && footer.y + footer.height <= 1001,
      "footer remains in the viewport",
    );
    measurements.push({ width, measured, footer });
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    fs.writeFileSync(
      path.join(dir, `trim-expanded-${width}.png`),
      Buffer.from(png, "base64"),
    );
  }
  fs.writeFileSync(
    path.join(dir, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log("Desktop trim locale PASS", dir);
} finally {
  await app.close();
}
