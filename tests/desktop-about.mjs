import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
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
        url,
      }),
    url,
  );
  await expect(
    dialog.getByRole("button", { name: "下载并更新", exact: true }),
  ).toBeEnabled();
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
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        info,
        checks: [
          "no-changelog",
          "current-release-page",
          "new-version-auto-install",
          "new-version-manual-install",
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
