// Actual App/service/tools workflow with an explicit offline-release adapter.
// The adapter pauses requests so busy controls and retry can be observed without
// downloading or changing any tools in the user's installation.
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/engine-flow-"));
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({
    version: require("../package.json").version,
    main: "main.cjs",
  }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `
const {createRequire}=require('node:module'),native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});
const service=native('../backend/service.cjs'),create=service.createService;
global.engineCalls=[];global.pendingToolCheck=null;
service.createService=options=>create({...options,toolOptions:{resolveReleases:()=>new Promise((resolve,reject)=>{global.pendingToolCheck={resolve,reject};})}});
const updates=native('../backend/update.cjs');updates.checkForUpdate=async current=>({current,latest:current,newer:false,url:updates.RELEASES_URL});
const {ipcMain}=native('electron'),handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{global.engineCalls.push({action,payload:args[0]??null});return listener(event,action,...args);});
native('./main.cjs');
`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_TEST_TOOLS_ROOT: "",
    MMD_ENCODER_TOOLS_ROOT: "",
    MMD_ENCODER_TOOLS: "",
    MMD_ENCODER_ENGINES: "",
  },
  timeout: 60000,
});
const checks = [];
const focus = [];
try {
  const page = await app.firstWindow();
  const rememberFocus = async (step) => {
    await page.waitForTimeout(30);
    focus.push({
      step,
      ...(await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName,
          id: el?.id?.startsWith("radix-") ? "radix" : el?.id,
          label: el?.getAttribute("aria-label"),
          text: el?.tagName === "BUTTON" ? el.textContent?.trim() : "",
        };
      })),
    });
  };
  const engine = page.getByRole("dialog", { name: "编码引擎", exact: true });
  await expect(engine).toBeVisible();
  await rememberFocus("auto-open");
  const rootInput = engine.locator("#tools-root");
  const initialRoot = await rootInput.inputValue();
  assert.ok(initialRoot.startsWith(process.env.MMD_TEST_ISOLATED));
  const size = await engine.boundingBox();
  assert.ok(
    Math.abs(
      size.height - Math.min(752, await page.evaluate(() => innerHeight - 50)),
    ) < 2,
  );
  await expect(
    engine.getByText("尚未安装编码工具", { exact: true }),
  ).toBeVisible();
  const before = await engine.innerText();
  checks.push("first-use-auto-prompt-and-fixed-height");
  await page.keyboard.press("Escape");
  await expect(engine).toBeHidden();
  await rememberFocus("auto-close");
  await page.getByRole("button", { name: /个可用编码器|检测编码器/ }).click();
  await expect(engine).toBeVisible();
  await rememberFocus("manual-open");
  await page.keyboard.press("Escape");
  await expect(engine).toBeHidden();
  await rememberFocus("manual-close");
  await page.getByRole("button", { name: /个可用编码器|检测编码器/ }).click();
  await expect(engine).toBeVisible();
  checks.push("manual-reopen-after-one-time-prompt");
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  const changesBefore = await app.evaluate(
    () => global.engineCalls.filter((x) => x.action === "setToolsRoot").length,
  );
  await engine.getByRole("button", { name: "更改位置", exact: true }).click();
  await expect(rootInput).toHaveValue(initialRoot);
  assert.equal(
    await app.evaluate(
      () =>
        global.engineCalls.filter((x) => x.action === "setToolsRoot").length,
    ),
    changesBefore,
  );
  checks.push("cancel-directory-keeps-install-location");
  const nextRoot = path.join(dir, "tools-next");
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, nextRoot);
  await engine.getByRole("button", { name: "更改位置", exact: true }).click();
  await expect(rootInput).toHaveValue(nextRoot);
  await expect(
    engine.getByRole("button", { name: "更改位置", exact: true }),
  ).toBeEnabled();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "data/tools-location.json")))
      .root,
    nextRoot,
  );
  await engine.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(rootInput).toHaveValue(initialRoot);
  assert.equal(
    fs.existsSync(path.join(dir, "data/tools-location.json")),
    false,
  );
  checks.push("change-and-reset-use-existing-service-persistence");
  await engine
    .getByRole("button", { name: "检查工具更新", exact: true })
    .click();
  await expect(
    engine.getByRole("button", { name: "正在处理…", exact: true }),
  ).toBeDisabled();
  await expect(
    engine.getByRole("button", { name: "更改位置", exact: true }),
  ).toBeDisabled();
  await expect(
    engine.getByRole("button", { name: "检查工具更新", exact: true }),
  ).toBeDisabled();
  await app.evaluate(() =>
    global.pendingToolCheck.reject(
      Error("Engine fixture offline: 原始{detail}"),
    ),
  );
  await expect(
    engine.getByRole("button", { name: "重试下载并安装", exact: true }),
  ).toBeEnabled();
  await expect(engine.getByRole("alert").first()).toContainText(
    "Engine fixture offline: 原始{detail}",
  );
  await engine
    .getByRole("button", { name: "重试下载并安装", exact: true })
    .click();
  await expect(
    engine.getByRole("button", { name: "正在处理…", exact: true }),
  ).toBeDisabled();
  await app.evaluate(() =>
    global.pendingToolCheck.reject(Error("Engine fixture retry: preserved")),
  );
  await expect(
    engine.getByRole("button", { name: "重试下载并安装", exact: true }),
  ).toBeEnabled();
  checks.push("check-busy-failure-and-install-retry");
  await engine.getByText("引擎位置", { exact: true }).click();
  await expect(
    engine.getByText("未找到", { exact: true }).first(),
  ).toBeVisible();
  await engine
    .getByRole("button", { name: "检测日志与版本", exact: true })
    .click();
  const logs = page.getByRole("dialog", { name: "任务日志", exact: true });
  await expect(logs).toBeVisible();
  await expect(engine).toBeHidden();
  await rememberFocus("engine-to-log");
  const text = await page.evaluate(() =>
    window.encoder.invokeResult("logs", {}),
  );
  await expect(logs.locator(".log-view")).toHaveText(
    text || "此任务暂无编码日志。",
  );
  await page.keyboard.press("Escape");
  await expect(logs).toBeHidden();
  await rememberFocus("log-close");
  await page.getByRole("button", { name: /个可用编码器|检测编码器/ }).click();
  await expect(engine).toBeVisible();
  checks.push("detection-log-handoff-and-reopen");
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.showInactive();
    return (await w.webContents.capturePage()).toPNG().toString("base64");
  });
  fs.writeFileSync(
    path.join(dir, "engine.png"),
    Buffer.from(screenshot, "base64"),
  );
  const actions = (await app.evaluate(() => global.engineCalls)).filter((x) =>
    [
      "pickDirectory",
      "setToolsRoot",
      "checkTools",
      "installTools",
      "logs",
    ].includes(x.action),
  );
  assert.deepEqual(
    actions.map((x) => x.action),
    [
      "pickDirectory",
      "pickDirectory",
      "setToolsRoot",
      "setToolsRoot",
      "checkTools",
      "installTools",
      "logs",
      "logs",
    ],
  );
  assert.equal(actions[0].payload.title, "选择编码工具安装位置");
  assert.equal(actions[2].payload.root, nextRoot);
  assert.equal(actions[3].payload.root, "");
  assert.deepEqual(actions[6].payload, {});
  if (process.argv[2] === "--baseline") {
    const baseline = JSON.parse(
      fs.readFileSync(path.resolve(process.argv[3]), "utf8"),
    );
    assert.equal(
      before,
      baseline.before,
      "engine dialog text remains unchanged",
    );
    const observedFocus = (items) =>
      items.map(({ step, tag, id, label, text }) => ({
        step,
        tag: tag || "BODY",
        id: id || "",
        label: label || null,
        text: text || "",
      }));
    assert.deepEqual(
      observedFocus(focus),
      observedFocus(baseline.focus),
      "existing focus transitions remain unchanged",
    );
    assert.deepEqual(
      actions.map((x) => x.action),
      baseline.actions.map((x) => x.action),
    );
  }
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      { checks, before, actions, focus, initialRoot, nextRoot, size },
      null,
      2,
    ),
  );
  console.log("Engine management workflow PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        actions: await app.evaluate(() => global.engineCalls),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
