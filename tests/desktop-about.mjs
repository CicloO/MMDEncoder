import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { appError, serializeError } = require("../backend/errors.cjs");
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/about-"));
const outDir = path.join(dir, "fixture-dist");
await build({
  root,
  base: "./",
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/about.html") },
  },
});
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  const info = await page.evaluate(() => window.encoder.invoke("aboutInfo"));
  assert.deepEqual(info, { version: require("../package.json").version });
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1360, 1000);
      w.showInactive();
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/about.html"),
  );
  const dialog = page.getByRole("dialog", { name: "关于", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".release-notes")).toHaveCount(0);
  await expect(dialog.locator("#about-locale")).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "本版更新日志" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "发行说明", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "发行说明", exact: true }).click();
  assert.deepEqual(
    (await page.evaluate(() => window.aboutFixture.calls())).at(-1),
    { name: "openReleasePage", payload: { url: "" } },
  );
  const url = "https://github.com/CicloO/MMDEncoder/releases/tag/v9.9.0";
  await page.evaluate(
    (url) =>
      window.aboutFixture.change({
        checking: false,
        current: "1.6.1",
        latest: "9.9.0",
        newer: true,
        canInstall: true,
        assets: { kind: "app", size: 4096 },
        url,
      }),
    url,
  );
  await expect(
    dialog.getByRole("button", { name: "下载并更新", exact: true }),
  ).toBeEnabled();
  const smallSize = new Intl.NumberFormat("zh-CN", {
    style: "unit",
    unit: "kilobyte",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(4);
  await expect(
    dialog.getByText("程序包 · 下载大小 " + smallSize, { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "打开下载页", exact: true }).click();
  assert.deepEqual(
    (await page.evaluate(() => window.aboutFixture.calls())).at(-1),
    { name: "openReleasePage", payload: { url } },
  );
  await page.evaluate(
    (url) =>
      window.aboutFixture.change({
        checking: false,
        current: "1.6.1",
        latest: "9.9.0",
        newer: true,
        canInstall: false,
        url,
        installBlocked: "Fixture manual install reason",
      }),
    url,
  );
  await expect(
    dialog.getByRole("button", { name: "下载并更新", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Fixture manual install reason", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "打开下载页", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.aboutFixture.change({
      checking: false,
      current: "1.6.1",
      latest: "9.9.0",
      newer: true,
      canInstall: true,
    });
    window.aboutFixture.progress({
      phase: "downloading",
      received: 1536,
      total: 4096,
      error: "",
    });
    window.aboutNode = document.querySelector('[role="dialog"]');
  });
  const actionsBefore = await page.evaluate(() => window.aboutFixture.calls());
  for (const locale of ["en-XA", "unsupported", "zh-CN"]) {
    await page.evaluate((locale) => window.aboutFixture.choose(locale), locale);
    const expected = await page.evaluate(
      (locale) =>
        locale === "en-XA"
          ? window.aboutFixture.pseudo["about.downloading"]
          : "正在下载…",
      locale,
    );
    await expect(page.locator(".about-status")).toContainText("9.9.0");
    await expect(
      page
        .locator('[role="dialog"]')
        .getByRole("button", { name: expected, exact: true }),
    ).toBeDisabled();
    assert.equal(
      await page.evaluate(
        () => window.aboutNode === document.querySelector('[role="dialog"]'),
      ),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.aboutFixture.calls()),
      actionsBefore,
    );
  }
  await page.evaluate(() =>
    window.aboutFixture.progress({
      phase: "failed",
      received: 1536,
      total: 4096,
      error: "Foreign diagnostic stays exact",
    }),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Foreign diagnostic stays exact",
  );
  await page.evaluate(() => window.aboutFixture.choose("en-XA"));
  await expect(page.getByRole("alert")).toContainText(
    "Foreign diagnostic stays exact",
  );
  const failure = serializeError(
    appError("UPDATE_EXTRACT_FAILED", { detail: "7-Zip ERROR: 舞台{a}.zip" }),
  );
  await page.evaluate(
    (errorData) =>
      window.aboutFixture.progress({
        phase: "failed",
        received: 1536,
        total: 4096,
        error: errorData.message,
        errorData,
      }),
    JSON.parse(JSON.stringify(failure)),
  );
  for (const locale of ["en-XA", "zh-CN", "en-XA"]) {
    await page.evaluate((locale) => window.aboutFixture.choose(locale), locale);
    const expected = await page.evaluate(
      ({ locale, detail }) =>
        locale === "en-XA"
          ? window.aboutFixture.pseudo["error.UPDATE_EXTRACT_FAILED"].replace(
              "{detail}",
              detail,
            )
          : "解压失败：" + detail,
      { locale, detail: failure.params.detail },
    );
    await expect(page.getByRole("alert")).toContainText(expected);
  }
  const fallbackData = serializeError(appError("UPDATE_CHECKSUM_MISMATCH"));
  await page.evaluate(
    (fallbackData) =>
      window.aboutFixture.progress({
        phase: "downloading",
        received: 4096,
        total: 8192,
        error: "",
        errorData: null,
        packageKind: "full",
        fallbackData,
      }),
    fallbackData,
  );
  await page.evaluate(() => window.aboutFixture.choose("zh-CN"));
  const fullSize = new Intl.NumberFormat("zh-CN", {
    style: "unit",
    unit: "kilobyte",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(8);
  await expect(
    dialog.getByText("完整包 · 下载大小 " + fullSize, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("程序包未能使用，已改用完整包：" + fallbackData.message, {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => window.aboutFixture.choose("en-XA"));
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.equal(
    await page.evaluate(
      () => window.aboutNode === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(650, 1000),
  );
  const layout = await page
    .locator('[role="dialog"]')
    .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(layout.scroll <= layout.client + 1);
  await page.screenshot({
    path: path.join(dir, "incremental-fallback-long.png"),
  });
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        info,
        checks: [
          "no-changelog",
          "one-formal-locale-hides-language-section",
          "current-release-page",
          "new-version-auto-install",
          "new-version-manual-install",
          "locale-preserves-dialog-progress-and-actions",
          "foreign-update-diagnostic-stays-exact",
          "coded-update-error-reformats-and-preserves-extractor-diagnostic",
          "selected-package-size-and-fallback-full-size",
          "fallback-cause-and-unknown-diagnostics-remain-readable",
        ],
        calls: await page.evaluate(() => window.aboutFixture.calls()),
      },
      null,
      2,
    ),
  );
  console.log("About update states and version-only IPC PASS", dir);
} finally {
  await app.close();
}
