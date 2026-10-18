import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.resolve(root, "verification");
fs.mkdirSync(evidence, { recursive: true });
const testDir = fs.mkdtempSync(
  path.join(
    (fs.mkdirSync(path.resolve(root, "verification/work"), { recursive: true }),
    path.resolve(root, "verification/work")),
    "desktop-",
  ),
);
const input = path.join(testDir, "MMD 舞台测试 60fps.mkv");
execFileSync(require("./engines.cjs").ff, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=640x360:r=60:d=1,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a=128",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=1",
  "-c:v",
  "ffv1",
  "-c:a",
  "pcm_s16le",
  "-shortest",
  input,
]);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(testDir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const shot = async (name) => {
    const data = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    if (data)
      fs.writeFileSync(path.join(evidence, name), Buffer.from(data, "base64"));
    else
      await page.screenshot({
        path: path.join(evidence, name),
        timeout: 15000,
      });
  };
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("heading", { name: "视频队列" })
    .waitFor({ timeout: 30000 });
  await shot("01-empty.png");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换到黑夜模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "切换到白天模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "音频", exact: true }).click();
  await page.selectOption("#audioBitrate", "128");
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.encoder.invoke("state")).settings.audioBitrate,
      ),
    )
    .toBe(128);
  await shot("05-day-audio.png");
  const lightAxe = await new AxeBuilder({ page }).setLegacyMode().analyze();
  fs.writeFileSync(
    path.join(evidence, "day-accessibility.json"),
    JSON.stringify(lightAxe.violations, null, 2),
  );
  assert.equal(lightAxe.violations.length, 0);
  await page.selectOption("#audio", "flac");
  await expect(page.locator("#audioBitrate")).toBeDisabled();
  await page.selectOption("#audio", "aac");
  await page.getByRole("button", { name: "切换到黑夜模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "画质", exact: true }).click();

  await page.evaluate(async (input) => {
    await window.encoder.invoke("add", { paths: [input] });
  }, input);
  await page.waitForFunction(() =>
    document.body.textContent.includes("60 FPS"),
  );
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () => !(await window.encoder.invoke("state")).detecting,
        ),
      { timeout: 90000 },
    )
    .toBe(true);

  await page.selectOption("#resizeMode", "custom");
  await expect(page.getByLabel("保持宽高比")).toBeChecked();
  await page.locator("#width").fill("320");
  await expect(page.locator("#height")).toHaveValue("180");
  await page.getByLabel("保持宽高比").uncheck();
  await expect(page.locator("#height")).toHaveValue("180");
  await page.locator("#height").fill("200");
  await expect(page.locator("#width")).toHaveValue("320");
  await page.getByLabel("保持宽高比").check();
  await expect(page.locator("#width")).toHaveValue("356");
  await page.locator("#width").fill("320");
  await expect(page.locator("#height")).toHaveValue("180");
  await page.selectOption("#fps", "30");
  await page.getByRole("button", { name: "透明通道", exact: true }).click();

  await page.selectOption("#alphaMode", "preserve");
  await expect(
    page.getByRole("alert").getByText("保留 Alpha 请选择", { exact: false }),
  ).toBeVisible();
  await page.selectOption("#alphaMode", "split");
  await page.getByRole("button", { name: "输出", exact: true }).click();
  await page.selectOption("#outputMode", "source");
  await page.selectOption("#outputMode", "encoded");
  await page.getByRole("button", { name: "另存为预设", exact: true }).click();
  await page.getByLabel("预设名称").fill("测试 · 30帧遮罩");
  await page.getByRole("button", { name: "保存预设", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await new Promise((r) => setTimeout(r, 800));
  const settingsPath = path.join(testDir, "data", "settings.json");
  const idleMtime = fs.statSync(settingsPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(
    fs.statSync(settingsPath).mtimeMs,
    idleMtime,
    "idle UI must not rewrite settings continuously",
  );
  await page.getByRole("button", { name: "高级", exact: true }).click();
  await page.getByRole("button", { name: "复制命令", exact: true }).click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /fps=30/);
  assert.match(copied, /w=320:h=180/);
  await page.getByRole("button", { name: "画质", exact: true }).click();
  await shot("02-ready.png");
  await page.getByRole("button", { name: "开始压制", exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () => (await window.encoder.invoke("state")).jobs[0]?.status,
        ),
      { timeout: 90000 },
    )
    .toBe("done");
  const state = await page.evaluate(() => window.encoder.invoke("state"));
  fs.writeFileSync(
    path.join(evidence, "debug-state.json"),
    JSON.stringify(state, null, 2),
  );
  assert.ok(fs.existsSync(state.jobs[0].output));
  assert.ok(fs.existsSync(state.jobs[0].maskOutput));
  await shot("03-complete.png");
  console.log("Encoded and captured, testing preset removal");
  await page.getByRole("button", { name: "预设管理", exact: true }).click();
  await page
    .getByRole("button", { name: "删除预设 测试 · 30帧遮罩", exact: true })
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  console.log("Deletion cancelled");
  await page
    .getByRole("button", { name: "删除预设 测试 · 30帧遮罩", exact: true })
    .click();
  await page.getByRole("button", { name: "删除预设", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除个人预设", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("dialog", { name: "预设管理", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  console.log("Preset deleted");
  await page.setViewportSize({ width: 700, height: 800 });
  await page.getByRole("button", { name: "音频", exact: true }).click();
  await shot("04-narrow.png");
  await page.keyboard.press("Tab");
  assert.ok(
    await page.evaluate(() => document.activeElement?.tagName !== "BODY"),
  );
  const axe = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  fs.writeFileSync(
    path.join(evidence, "accessibility.json"),
    JSON.stringify(axe.violations, null, 2),
  );
  assert.equal(
    axe.violations.length,
    0,
    JSON.stringify(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ),
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(evidence, "desktop-test.json"),
    JSON.stringify(
      {
        passed: true,
        testDir,
        output: state.jobs[0].output,
        mask: state.jobs[0].maskOutput,
        engines: state.engines.map((e) => e.id),
        errors,
        checks: [
          "empty",
          "file probe",
          "30FPS",
          "alpha",
          "preset save/delete/cancel",
          "output modes",
          "copy command",
          "real encode",
          "keyboard",
          "narrow",
          "axe",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Desktop flow PASS", state.jobs[0].output);
} finally {
  await app.close();
}
