// Main-process picker contract + real ZIP extraction / executable verification,
// all in an isolated tool root. Never changes the user's installed tools.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/tools-local-"));
const toolRoot = path.join(dir, "tools");
const archive = path.join(dir, "User NVEncC 工具包.zip");
const invalid = path.join(dir, "User invalid.zip");
const { nv, engineDir } = require("./engines.cjs");
const seven = path.join(root, "assets/7za.exe");
if (process.argv[2]) fs.copyFileSync(process.argv[2], archive);
else
  execFileSync(seven, ["a", "-tzip", "-mx=1", archive, nv], { stdio: "pipe" });
fs.writeFileSync(path.join(dir, "readme.txt"), "not an encoder package");
execFileSync(seven, ["a", "-tzip", invalid, path.join(dir, "readme.txt")], {
  stdio: "pipe",
});
const oldHash = require("node:crypto")
  .createHash("sha256")
  .update(fs.readFileSync(archive))
  .digest("hex");
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: toolRoot,
    MMD_ENCODER_ENGINES: engineDir,
  },
  timeout: 60000,
});
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  await expect
    .poll(
      async () => {
        const s = await state();
        return s.located && !s.detecting;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  if (!(await page.getByRole("dialog", { name: "编码工具管理" }).count()))
    await page.getByRole("button", { name: /个可用编码器/ }).click();
  const install = page.getByRole("button", {
    name: "从压缩包安装",
    exact: true,
  });
  await expect(install).toBeEnabled();
  await app.evaluate(({ dialog }) => {
    globalThis.localArchiveChoice = null;
    globalThis.localArchiveOptions = [];
    dialog.showOpenDialog = async (_win, options) => {
      globalThis.localArchiveOptions.push(options);
      return {
        canceled: !globalThis.localArchiveChoice,
        filePaths: globalThis.localArchiveChoice
          ? [globalThis.localArchiveChoice]
          : [],
      };
    };
  });
  await install.click();
  await expect(install).toBeEnabled();
  assert.deepEqual((await state()).tools.installed, {});
  await app.evaluate(
    (_e, file) => (globalThis.localArchiveChoice = file),
    invalid,
  );
  await install.click();
  await expect.poll(async () => (await state()).tools.phase).toBe("error");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "未找到 FFmpeg 或 NVEncC" })
      .first(),
  ).toBeVisible();
  assert.deepEqual((await state()).tools.installed, {});
  checks.push("cancel-preserves-state-invalid-archive-visible-error-and-retry");
  await expect(install).toBeEnabled({ timeout: 60000 });
  await app.evaluate(
    (_e, file) => (globalThis.localArchiveChoice = file),
    archive,
  );
  await install.click();
  await expect
    .poll(async () => (await state()).tools.installed.nvencc?.version, {
      timeout: 120000,
    })
    .toBeTruthy();
  await expect(install).toBeEnabled({ timeout: 120000 });
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.encoder.invoke("state"));
        return !state.detecting && !state.tools.busy;
      },
      { timeout: 120000 },
    )
    .toBe(true);
  const after = await state();
  await expect(page.getByText(/nvencc.*（本地安装）/)).toBeVisible();
  assert.deepEqual(
    (
      await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
    [],
  );
  assert.equal(after.tools.root, toolRoot);
  assert.equal(after.tools.installed.nvencc.verifiedHash, false);
  assert.equal(after.tools.installed.nvencc.sha256, oldHash);
  assert.equal(after.tools.installed.nvencc.source, "local");
  assert.ok(after.engineInfo.nvencc.startsWith(toolRoot));
  assert.match(
    execFileSync(after.engineInfo.nvencc, ["--version"], { encoding: "utf8" }),
    /NVEncC/,
  );
  assert.ok(
    !fs.readdirSync(toolRoot).some((name) => name.startsWith("staging-")),
  );
  const options = await app.evaluate(() => globalThis.localArchiveOptions);
  assert.equal(options.length, 3);
  for (const option of options) {
    assert.equal(option.title, "选择编码工具压缩包");
    assert.deepEqual(option.properties, ["openFile"]);
    assert.deepEqual(option.filters[0].extensions, ["zip", "7z"]);
  }
  checks.push("real-local-nvencc-zip-verified-activated-detected-offline");
  const shot = async (name) => {
    await page.getByRole("dialog", { name: "编码引擎", exact: true }).waitFor();
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
    fs.writeFileSync(path.join(dir, name), Buffer.from(bytes, "base64"));
  };
  await shot("light.png");
  const list = page.getByRole("region", { name: "可用编码器列表" });
  await list.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  checks.push("engine-scroll-region-keyboard-accessible");
  await page.keyboard.press("Escape");
  await page.locator(".theme-toggle").click();
  await page.getByRole("button", { name: /个可用编码器/ }).click();
  await shot("dark.png");
  assert.equal(
    require("node:crypto")
      .createHash("sha256")
      .update(fs.readFileSync(archive))
      .digest("hex"),
    oldHash,
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        installed: after.tools.installed,
        archiveSha256: oldHash,
      },
      null,
      2,
    ),
  );
  console.log("Local tools desktop PASS", dir);
} finally {
  await app.close();
}
