import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url),
  root = path.resolve(import.meta.dirname, ".."),
  evidence = path.join(root, "verification"),
  { ff } = require("./engines.cjs");
fs.mkdirSync(evidence, { recursive: true });
const data = fs.mkdtempSync(path.join(evidence, "tools-ui-"));
const managed =
  process.env.MMD_TEST_TOOLS_ROOT || path.join(evidence, "tools-live");
async function screenshot(instance, name) {
  const encoded = await instance.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0],
      visible = win.isVisible();
    if (!visible) win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = (await win.webContents.capturePage())
      .toPNG()
      .toString("base64");
    if (!visible) win.hide();
    return result;
  });
  fs.writeFileSync(path.join(evidence, name), Buffer.from(encoded, "base64"));
}
async function launch(tools, folder) {
  const instance = await electron.launch({
    executablePath: process.env.MMD_PACKAGE_EXE || require("electron"),
    args: process.env.MMD_PACKAGE_EXE ? [] : [root],
    env: {
      ...process.env,
      MMD_ENCODER_TOOLS_ROOT: tools,
      MMD_ENCODER_ENGINES: "",
      MMD_ENCODER_DATA: folder,
      MMD_ENCODER_TEST: "1",
    },
    timeout: 60000,
  });
  instance
    .process()
    .stderr.on("data", (chunk) =>
      fs.appendFileSync(path.join(evidence, "desktop-tools-stderr.log"), chunk),
    );
  return instance;
}
let app = await launch(
  path.join(data, "empty-tools"),
  path.join(data, "fresh"),
);
try {
  const page = await app.firstWindow();
  await expect(page.getByRole("dialog", { name: "编码引擎" })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "下载并安装最新工具", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("尚未安装编码工具", { exact: true }),
  ).toBeVisible();
  await screenshot(app, "first-install.png");
} finally {
  await app.close();
}
app = await launch(managed, path.join(data, "existing"));
const checks = [];
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = await window.encoder.invoke("state");
          return s.located && !s.detecting;
        }),
      { timeout: 120000 },
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push("installed tools reopen without install prompt");
  await page.selectOption("#encoder", "libx264");
  await page.getByRole("button", { name: "透明通道", exact: true }).click();
  await page.selectOption("#alphaMode", "preserve");
  // HEVC alpha is never offered as a fix; ProRes 4444 is.
  const preferred = false;
  await expect(
    page.getByRole("button", { name: "切换至 8-bit NVEncC HEVC Alpha" }),
  ).toHaveCount(0);
  const label = "切换至 ProRes 4444 Alpha";
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await window.encoder.invoke("state");
        return [
          s.settings.encoder,
          s.settings.alphaMode,
          s.settings.bitDepth,
          s.settings.chroma,
        ];
      }),
    )
    .toEqual(
      preferred
        ? ["nvencc:hevc", "preserve", 8, "420"]
        : ["prores_ks", "preserve", 10, "444"],
    );
  checks.push(
    "one-click Alpha repair atomically persists full compatible settings",
  );
  const stored = JSON.parse(
    fs.readFileSync(path.join(data, "existing/settings.json"), "utf8"),
  ).settings;
  assert.equal(stored.alphaMode, "preserve");
  assert.equal(stored.encoder, preferred ? "nvencc:hevc" : "prores_ks");
  assert.equal(stored.bitDepth, preferred ? 8 : 10);
  assert.equal(stored.chroma, preferred ? "420" : "444");
  assert.equal(stored.fps, "source");
  assert.equal(stored.outputMode, "encoded");
  const fixture = path.join(data, "input.mkv");
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "flac",
    "-shortest",
    fixture,
  ]);
  await page.evaluate(
    (p) => window.encoder.invoke("add", { paths: [p] }),
    fixture,
  );
  await page.getByRole("button", { name: "文件详情", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("尚未生成文件", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("640 × 360", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  checks.push("details show real source and absent output");
  await page
    .getByRole("button", { name: "音视频提取与合并", exact: true })
    .click();
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [values.input],
      });
    },
    { input: fixture },
  );
  await page.getByRole("button", { name: "添加文件", exact: true }).click();
  const name = path.basename(fixture);
  const mediaQueue = page.getByRole("region", { name: "媒体队列" });
  await expect(mediaQueue.locator(".job-row").first()).toContainText(name);
  // Default location is the source folder; the name is generated automatically.
  const first = path.join(
    path.dirname(fixture),
    path.parse(fixture).name + ".wav",
  );
  await expect(page.locator(".output-path").first()).toHaveText(first);
  await page.getByRole("button", { name: "开始处理", exact: true }).click();
  await expect(mediaQueue.locator(".job-status.done")).toContainText(
    "已完成 · 用时",
  );
  await expect(mediaQueue.locator(".output-file-name")).toHaveText(
    path.basename(first),
  );
  await expect(mediaQueue.locator(".output-file-name")).toHaveAttribute(
    "title",
    first,
  );
  assert.ok(fs.existsSync(first));
  checks.push("media queue item completes with an automatic same-folder name");
  await page
    .getByRole("button", { name: "重新导出 " + name, exact: true })
    .click();
  await expect(mediaQueue.locator(".job-status.ready")).toHaveText("等待处理");
  await expect(mediaQueue.locator(".output-file-name")).toHaveCount(0);
  await page.getByRole("button", { name: "开始处理", exact: true }).click();
  await expect(mediaQueue.locator(".job-status.done")).toContainText(
    "已完成 · 用时",
  );
  await expect(mediaQueue.locator(".output-file-name")).toHaveText(
    path.parse(fixture).name + " (2).wav",
  );
  await expect(mediaQueue.locator(".output-file-name")).toHaveAttribute(
    "title",
    path.join(path.dirname(fixture), path.parse(fixture).name + " (2).wav"),
  );
  assert.ok(
    fs.existsSync(
      path.join(path.dirname(fixture), path.parse(fixture).name + " (2).wav"),
    ),
  );
  assert.ok(fs.existsSync(first));
  checks.push("media re-export numbers the new file instead of overwriting");
  await page.selectOption("#media-location", "encoded");
  await page
    .getByRole("button", { name: "重新导出 " + name, exact: true })
    .click();
  await expect(page.locator(".output-path").first()).toHaveText(
    path.join(
      path.dirname(fixture),
      "Encoded",
      path.parse(fixture).name + ".wav",
    ),
  );
  await page.getByRole("button", { name: "移除 " + name, exact: true }).click();
  await page.getByRole("button", { name: "添加文件", exact: true }).click();
  await page.getByRole("button", { name: "开始处理", exact: true }).click();
  await expect(mediaQueue.locator(".job-status.done")).toContainText(
    "已完成 · 用时",
  );
  await expect(mediaQueue.locator(".output-file-name")).toHaveAttribute(
    "title",
    path.join(
      path.dirname(fixture),
      "Encoded",
      path.parse(fixture).name + ".wav",
    ),
  );
  await page.getByRole("button", { name: "清除已完成", exact: true }).click();
  await expect(page.getByText("把音视频放进来", { exact: true })).toBeVisible();
  checks.push("Encoded location, remove and clear completed");
  await page.setViewportSize({ width: 700, height: 900 });
  await screenshot(app, "media-narrow.png");
  const axe = await new AxeBuilder({ page }).setLegacyMode().analyze();
  assert.deepEqual(axe.violations, []);
  checks.push("media narrow viewport and accessibility");
  // About: version, release page and support links; updates no
  // longer live in the engine dialog.
  await page.getByRole("button", { name: /关于/ }).click();
  const about = page.getByRole("dialog", { name: "关于" });
  await expect(about.locator(".about-version strong")).toHaveText(
    require("../package.json").version,
  );
  await expect(about.locator(".release-notes")).toHaveCount(0);
  await expect(
    about.getByRole("button", { name: "发行说明", exact: true }),
  ).toBeVisible();
  await expect(about.getByRole("button", { name: "问题反馈" })).toBeVisible();
  const aboutHeight = (await about.boundingBox()).height;
  await expect(about).not.toHaveClass(/modal-fixed/);
  const fixedHeight = Math.min(
    752,
    await page.evaluate(() => innerHeight - 50),
  );
  assert.ok(
    aboutHeight < fixedHeight,
    "Chinese About fits its content without the old empty log area",
  );
  await screenshot(app, "about-adaptive.png");
  const aboutAxe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(aboutAxe.violations, []);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /个可用编码器|检测编码器/ }).click();
  await expect(page.getByRole("dialog", { name: "编码引擎" })).toBeVisible();
  assert.ok(
    Math.abs(
      (await page.getByRole("dialog").boundingBox()).height - fixedHeight,
    ) < 2,
  );
  await expect(page.getByRole("region", { name: "软件更新" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  checks.push("about dialog: version, release page, support, accessibility");
  await page.getByRole("button", { name: "视频压制", exact: true }).click();
  await page.getByRole("button", { name: "超分补帧", exact: true }).click();
  await page.selectOption("#upscaler", "artcnn");
  await expect(page.getByText(/保留原有颗粒质感/)).toBeVisible();
  await page.selectOption("#artcnnModel", "C4F32");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.encoder.invoke("state")).settings.artcnnModel,
      ),
    )
    .toBe("C4F32");
  // The 1080p pre-scale option was removed after testing (it lost detail).
  await expect(page.locator("#prescale1080")).toHaveCount(0);
  checks.push("ArtCNN upscaler and model choice");
  await screenshot(app, "upscale-artcnn.png");
  await page.selectOption("#upscaler", "vsr");
  await page.selectOption("#vsrQuality", "16");
  await expect(page.locator("#vsrQuality")).toHaveValue("16");
  await expect(page.getByText("本机验证")).toBeVisible();
  checks.push("RTX controls and detail restoration semantics");
  await screenshot(app, "rtx-settings.png");
  fs.writeFileSync(
    path.join(evidence, "desktop-tools.json"),
    JSON.stringify({ date: new Date().toISOString(), checks, data }, null, 2),
  );
  console.log("Desktop tools PASS", checks);
  passed = true;
} finally {
  await app.close();
  // Keep the working folder only when something failed.
  if (passed) fs.rmSync(data, { recursive: true, force: true });
}
