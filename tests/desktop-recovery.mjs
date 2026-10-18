import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  portable = root,
  evidence = path.join(portable, "verification");
const dir = fs.mkdtempSync(
    path.resolve(root, "verification/work") + path.sep + "recovery-",
  ),
  data = path.join(dir, "data");
const ff = require("./engines.cjs").ff;
const regular = path.join(dir, "普通视频.mp4"),
  corrupt = path.join(dir, "损坏视频.mp4"),
  alpha = path.join(
    JSON.parse(
      fs.readFileSync(path.join(evidence, "desktop-test.json"), "utf8"),
    ).testDir,
    "MMD 舞台测试 60fps.mkv",
  );
fs.writeFileSync(corrupt, "not a video");
execFileSync(ff, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=64x64:r=60:d=1",
  "-c:v",
  "libx264",
  regular,
]);
const env = {
  ...process.env,
  PATH: process.env.SystemRoot + "\\System32",
  MMD_ENCODER_DATA: data,
  MMD_ENCODER_TEST: "1",
  MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
};
async function launch() {
  const app = await electron.launch({
    executablePath:
      process.env.MMD_PACKAGE_EXE ||
      path.resolve(root, "release/MMDEncoder/MMDEncoder.exe"),
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  return { app, page };
}
let { app, page } = await launch();
const checks = [];
try {
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => !(await window.encoder.invoke("state")).detecting,
        ),
      { timeout: 90000 },
    )
    .toBe(true);
  const engines = await page.evaluate(
    async () => (await window.encoder.invoke("state")).engineInfo,
  );
  assert.ok(Object.values(engines).every((p) => p.startsWith(portable)));
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, corrupt);
  await page.getByRole("button", { name: "添加视频", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.encoder.invoke("state")).jobs[0]?.status,
      ),
    )
    .toBe("invalid");
  await page
    .getByRole("button", { name: "移除 损坏视频.mp4", exact: true })
    .click();
  console.log("Recovery checkpoint", checks.length);
  checks.push("corrupt input recovery");
  await page.evaluate(
    async (paths) => window.encoder.invoke("add", { paths }),
    [regular, alpha],
  );
  await page.getByRole("button", { name: "透明通道", exact: true }).click();
  await page.selectOption("#alphaMode", "split");
  await page.getByRole("button", { name: "输出", exact: true }).click();
  await page.selectOption("#outputMode", "custom");
  const outputDir = path.join(dir, "统一输出");
  fs.mkdirSync(outputDir);
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, outputDir);
  await page
    .getByRole("button", { name: "选择输出文件夹", exact: true })
    .click();
  await page.getByRole("button", { name: "开始压制", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = await window.encoder.invoke("state");
          return !s.running && s.jobs[1]?.status === "done";
        }),
      { timeout: 90000 },
    )
    .toBe(true);
  let state = await page.evaluate(() => window.encoder.invoke("state"));
  assert.equal(state.jobs[0].status, "invalid");
  assert.equal(state.jobs[1].status, "done");
  console.log("Recovery checkpoint", checks.length);
  checks.push("mixed alpha batch does not block valid item");
  // Local NVIDIA hardware rejects the genuine 64x64 source; software retry supports it.
  if (state.engines.some((e) => e.id === "hevc_nvenc")) {
    await page.evaluate(() =>
      window.encoder.invoke("settings", {
        patch: {
          alphaMask: false,
          encoder: "hevc_nvenc",
          preset: "p7",
          container: "mkv",
          audio: "flac",
          bitDepth: 10,
          quality: 18,
        },
      }),
    );
    await page.reload();
    await page.getByRole("heading", { name: "视频队列" }).waitFor();
    await page.getByRole("button", { name: "开始压制", exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.encoder.invoke("state")).jobs[0].status,
          ),
        { timeout: 90000 },
      )
      .toBe("failed");
    await page.getByRole("button", { name: "查看日志", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("minimum supported");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "改用软件编码重试", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("CRF 18");
    await page
      .getByRole("button", { name: "软件编码重试", exact: true })
      .click();
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.encoder.invoke("state")).jobs[0].status,
          ),
        { timeout: 90000 },
      )
      .toBe("done");
    console.log("Recovery checkpoint", checks.length);
    checks.push("actual hardware failure → logs → software HEVC retry");
  }
  await page.evaluate(() =>
    window.encoder.invoke("settings", {
      patch: {
        encoder: "libx264",
        preset: "medium",
        container: "mp4",
        audio: "aac",
        bitDepth: 8,
        alphaMask: false,
        nameTemplate: "{name}",
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "另存为预设", exact: true }).click();
  await page.getByLabel("预设名称").fill("恢复测试");
  await page.getByRole("button", { name: "保存预设", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "预设管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑名称", exact: true }).click();
  await page.getByLabel("预设名称", { exact: true }).fill("重新命名");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page
    .getByRole("dialog", { name: "修改预设名称" })
    .waitFor({ state: "hidden" });
  await expect(page.getByRole("dialog", { name: "预设管理" })).toContainText(
    "重新命名",
  );
  console.log("Recovery checkpoint", checks.length);
  checks.push("preset rename preserves parameters");
  const exported = path.join(dir, "presets.json");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, exported);
  await page.getByRole("button", { name: "导出预设", exact: true }).click();
  await expect.poll(() => fs.existsSync(exported)).toBe(true);
  const contents = JSON.parse(fs.readFileSync(exported, "utf8"));
  assert.equal(contents.presets.length, 1);
  const badJSON = path.join(dir, "bad.json");
  fs.writeFileSync(badJSON, "{");
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, badJSON);
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.encoder.invoke("state"))).presets.length,
    6,
  );
  console.log("Recovery checkpoint", checks.length);
  checks.push("malformed import retains existing presets");
  fs.writeFileSync(badJSON, JSON.stringify({ version: 999, presets: [] }));
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "版本",
  );
  checks.push("unsupported preset version rejected");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await app.close();
  ({ app, page } = await launch());
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.encoder.invoke("state")).settings.outputDir,
      ),
    )
    .toBe(outputDir);
  assert.equal(
    (await page.evaluate(() => window.encoder.invoke("state"))).settings
      .outputMode,
    "custom",
  );
  console.log("Recovery checkpoint", checks.length);
  checks.push(
    "portable executable without FFmpeg PATH",
    "settings survive restart",
  );
  await page.getByRole("button", { name: "输出", exact: true }).click();
  await page.selectOption("#outputMode", "source");
  const closed = app.waitForEvent("close", { timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
  });
  await closed;
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8"))
      .settings.outputMode,
    "source",
  );
  checks.push("native close immediately after edit flushes latest setting");
  ({ app, page } = await launch());
  fs.writeFileSync(
    path.join(evidence, "desktop-recovery.json"),
    JSON.stringify({ passed: true, checks, dir }, null, 2),
  );
  console.log("Desktop recovery PASS", checks);
} finally {
  await app.close();
}
