// Actual App shell and IPC with controlled terminal/running states. Real process
// failure/retry and actual close/save are covered separately by desktop-recovery.
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/shell-locale-")),
  outDir = path.join(dir, "fixture-dist"),
  registry = {
    ...require("../locales/registry.json"),
    locales: [
      ...require("../locales/registry.json").locales,
      { id: "en-XA", name: "Test English", file: "test-only.json" },
    ],
  };
const registryFile = path.join(dir, "registry.json");
fs.writeFileSync(registryFile, JSON.stringify(registry));
await build({
  root,
  base: "./",
  resolve: {
    alias: [
      {
        find: /^(?:\.\.\/)+locales\/registry\.json$/,
        replacement: registryFile,
      },
    ],
  },
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/app.html") },
  },
});
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
const core=native('../backend/core.cjs'),detector=native('../backend/detect.cjs'),createDetector=detector.createDetector;detector.createDetector=options=>({...createDetector(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const updates=native('../backend/update.cjs');updates.checkForUpdate=async current=>({current,latest:current,newer:false,url:updates.RELEASES_URL});
const service=native('../backend/service.cjs'),create=service.createService;global.shellMode={running:false,trimRunning:false,job:null,failSave:false,retryError:false};global.shellCalls=[];global.quitRequests=0;global.pauseState=false;global.pendingStates=[];
const project=s=>({...s,running:global.shellMode.running,trim:{...s.trim,running:global.shellMode.trimRunning},jobs:global.shellMode.job?[...s.jobs,global.shellMode.job]:s.jobs});
service.createService=options=>{const svc=create({...options,localeRegistry:${JSON.stringify(registry)},onUpdate:s=>{if(!global.pauseState)options.onUpdate(project(s));}}),invoke=svc.invoke.bind(svc);
 global.shellService=svc;global.publish=()=>options.onUpdate(project(svc.uiState()));global.releaseState=()=>{global.pauseState=false;for(const done of global.pendingStates.splice(0))done(project(svc.uiState()));};
 global.setFailed=encoder=>{global.shellMode.job={id:'controlled-failed',name:'User 失败 {source}.mov',path:'C:/source/User 失败 {source}.mov',status:'failed',progress:0,settings:{...core.DEFAULTS,encoder},meta:{width:1920,height:1080,fps:30,fpsText:'30/1',duration:1,size:1,codec:'h264',pixFmt:'yuv420p',bitDepth:8,hasAlpha:false},softwareRetry:true,error:'Foreign failure {raw}'};global.publish();};
 svc.invoke=async(action,payload)=>{global.shellCalls.push({action,payload:payload??null});if(action==='state'&&global.pauseState)return new Promise(resolve=>global.pendingStates.push(resolve));if(action==='settings'&&global.shellMode.failSave)throw Object.assign(Error('Foreign save failure {raw}'),{code:'FIXTURE_SAVE_ERROR',params:{}});if(action==='retry'){if(global.shellMode.retryError)throw Object.assign(Error('Foreign retry failure {raw}'),{code:'FIXTURE_RETRY_ERROR',params:{}});global.shellMode.job=null;return project(svc.uiState());}const r=await invoke(action,payload);return r?.jobs?project(r):r;};return svc;};
const {ipcMain}=native('electron'),handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{if(action==='quit'){global.quitRequests++;return null;}return listener(event,action,...args);});
native('./main.cjs');`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
const source = require("../locales/zh-CN.json"),
  checks = [],
  layouts = [];
let lang = "zh-CN",
  pseudo;
const text = (key, params = {}) =>
  (lang === "zh-CN" ? source : pseudo)[key].replace(/\{(\w+)\}/g, (token, k) =>
    Object.hasOwn(params, k) ? String(params[k]) : token,
  );
try {
  const page = await app.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible();
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      global.pauseState = true;
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1360, 1000);
      w.showInactive();
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await expect(page.locator(".startup")).toContainText(source["app.loading"]);
  await app.evaluate(() => global.releaseState());
  await expect(page.locator(".app-shell")).toBeVisible();
  pseudo = await page.evaluate(() => window.appAboutFixture.pseudo);
  const choose = async (locale) => {
    await page.evaluate(
      (locale) => window.encoder.invokeResult("setLocale", { locale }),
      locale,
    );
    lang = locale;
    await expect
      .poll(() => page.evaluate(() => document.documentElement.lang))
      .toBe(locale);
  };
  const dialog = (key) =>
    page.getByRole("dialog", { name: text(key), exact: true });
  const state = () => page.evaluate(() => window.encoder.invokeResult("state"));
  const requests = () =>
    app.evaluate(() =>
      global.shellCalls.filter((x) =>
        ["retry", "settings", "start", "cancel", "trimCancel"].includes(
          x.action,
        ),
      ),
    );
  const closeWindow = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
  const measure = async (key, label) => {
    for (const width of [1360, 650]) {
      const content = await app.evaluate(({ BrowserWindow }, width) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(width, 1000);
        return w.getContentBounds().width;
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(content);
      const box = await dialog(key).evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      assert.ok(box.scroll <= box.client + 1);
      layouts.push({ label, width, ...box });
      if (width === 650) {
        const png = await app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
            .toPNG()
            .toString("base64"),
        );
        fs.writeFileSync(
          path.join(dir, label + "-650.png"),
          Buffer.from(png, "base64"),
        );
      }
    }
  };
  checks.push("pending-state-shows-loading-and-release-keeps-actual-app");
  await page
    .getByRole("button", { name: source["app.theme.dark"], exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const before = await state();
  await page.evaluate(
    () => (window.shellNode = document.querySelector(".app-shell")),
  );
  await choose("en-XA");
  await expect(page.locator(".theme-toggle")).toHaveAttribute(
    "aria-label",
    pseudo["app.theme.light"],
  );
  await expect(page.locator(".theme-toggle")).toHaveAttribute(
    "title",
    pseudo["app.theme.light"],
  );
  await expect(page.locator(".brand p")).toHaveText(pseudo["app.tagline"]);
  assert.equal(
    await page.evaluate(
      () => window.shellNode === document.querySelector(".app-shell"),
    ),
    true,
  );
  assert.deepEqual((await state()).settings, before.settings);
  assert.deepEqual((await state()).presets, before.presets);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mmd-color-theme")),
    "dark",
  );
  await page
    .getByRole("button", { name: pseudo["app.theme.light"], exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const workspace of ["media", "trim", "encode"]) {
    await page
      .getByRole("button", {
        name: text("app.workspace." + workspace),
        exact: true,
      })
      .click();
    const transfer = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["x"], "sample.mp4", { type: "video/mp4" }));
      return d;
    });
    await page
      .locator(".app-shell")
      .dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(page.locator(".drop-overlay")).toHaveText(
      text("app.drop." + workspace),
    );
    await page.locator(".app-shell").dispatchEvent("dragleave", {
      dataTransfer: transfer,
      relatedTarget: null,
    });
    await expect(page.locator(".drop-overlay")).toHaveCount(0);
  }
  checks.push(
    "shell-theme-nav-drag-labels-refresh-without-resetting-settings-or-mount",
  );
  for (const [encoder, expected] of [
    ["hevc_nvenc", "HEVC · libx265"],
    ["av1_nvenc", "AV1 · libsvtav1"],
    ["h264_nvenc", "H.264 · libx264"],
  ]) {
    await choose("zh-CN");
    await app.evaluate((_e, encoder) => global.setFailed(encoder), encoder);
    // Adding the first selected task schedules the existing preview autosave.
    // Let it finish before measuring requests caused by a locale change.
    await expect
      .poll(() =>
        app.evaluate(() =>
          global.shellCalls.some(
            (x) =>
              x.action === "preview" && x.payload.id === "controlled-failed",
          ),
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: source["queue.softwareRetry"], exact: true })
      .click();
    await expect(dialog("queue.softwareRetry.title")).toContainText(expected);
    await expect(dialog("queue.softwareRetry.title")).toContainText(
      encoder.startsWith("av1") ? "预设 6" : "medium",
    );
    await page.evaluate(
      () => (window.retryNode = document.querySelector('[role="dialog"]')),
    );
    const calls = await requests();
    await choose("en-XA");
    assert.equal(
      await page.evaluate(
        () => window.retryNode === document.querySelector('[role="dialog"]'),
      ),
      true,
    );
    assert.deepEqual(await requests(), calls);
    await expect(dialog("queue.softwareRetry.title")).toContainText(expected);
    await expect(dialog("queue.softwareRetry.title")).toContainText(
      encoder.startsWith("av1")
        ? pseudo["queue.softwareRetry.av1Preset"]
        : "medium",
    );
    if (encoder === "av1_nvenc")
      await measure("queue.softwareRetry.title", "software-retry-long");
    await dialog("queue.softwareRetry.title")
      .getByRole("button", { name: text("common.cancel"), exact: true })
      .click();
    assert.deepEqual(await requests(), calls);
  }
  // First failure keeps the same pending task and readable unknown diagnostic.
  await app.evaluate(() => {
    global.shellMode.retryError = true;
    global.setFailed("hevc_nvenc");
  });
  await page
    .getByRole("button", { name: text("queue.softwareRetry"), exact: true })
    .click();
  await dialog("queue.softwareRetry.title")
    .getByRole("button", {
      name: text("queue.softwareRetry.confirm"),
      exact: true,
    })
    .click();
  await expect(
    dialog("queue.softwareRetry.title").getByRole("alert"),
  ).toHaveText("Foreign retry failure {raw}");
  await choose("zh-CN");
  await expect(
    dialog("queue.softwareRetry.title").getByRole("alert"),
  ).toHaveText("Foreign retry failure {raw}");
  await app.evaluate(() => (global.shellMode.retryError = false));
  await dialog("queue.softwareRetry.title")
    .getByRole("button", {
      name: text("queue.softwareRetry.confirm"),
      exact: true,
    })
    .click();
  await expect(dialog("queue.softwareRetry.title")).toBeHidden();
  assert.deepEqual(
    (await requests())
      .filter((x) => x.action === "retry")
      .map((x) => x.payload),
    [
      { id: "controlled-failed", software: true },
      { id: "controlled-failed", software: true },
    ],
  );
  checks.push(
    "three-software-variants-keep-task-payload-cancel-and-failed-retry-recovery",
  );
  await app.evaluate(() => {
    global.shellMode.running = true;
    global.publish();
  });
  await closeWindow();
  await expect(dialog("app.close.title")).toBeVisible();
  await expect(
    dialog("app.close.title").getByRole("button", {
      name: text("app.close.continue"),
      exact: true,
    }),
  ).toBeFocused();
  await choose("en-XA");
  await measure("app.close.title", "close-long");
  await dialog("app.close.title")
    .getByRole("button", { name: text("app.close.continue"), exact: true })
    .click();
  assert.equal(await app.evaluate(() => global.quitRequests), 0);
  await app.evaluate(() => {
    global.shellMode.running = false;
    global.shellMode.trimRunning = true;
    global.publish();
  });
  await closeWindow();
  await expect(dialog("app.close.title")).toBeVisible();
  await page.keyboard.press("Escape");
  assert.equal(await app.evaluate(() => global.quitRequests), 0);
  await app.evaluate(() => (global.shellMode.failSave = true));
  await closeWindow();
  await dialog("app.close.title")
    .getByRole("button", { name: text("app.close.quit"), exact: true })
    .click();
  await expect(dialog("app.closeSave.title")).toBeVisible();
  await expect(dialog("app.closeSave.title").getByRole("alert")).toHaveText(
    "Foreign save failure {raw}",
  );
  await expect(
    dialog("app.closeSave.title").getByRole("button", {
      name: text("app.closeSave.return"),
      exact: true,
    }),
  ).toBeFocused();
  await choose("zh-CN");
  await expect(dialog("app.closeSave.title").getByRole("alert")).toHaveText(
    "Foreign save failure {raw}",
  );
  await choose("en-XA");
  await measure("app.closeSave.title", "close-save-error-long");
  await dialog("app.closeSave.title")
    .getByRole("button", { name: text("app.closeSave.return"), exact: true })
    .click();
  assert.equal(await app.evaluate(() => global.quitRequests), 0);
  await closeWindow();
  await dialog("app.close.title")
    .getByRole("button", { name: text("app.close.quit"), exact: true })
    .click();
  await expect(dialog("app.closeSave.title")).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  const pendingCalls = await requests();
  await dialog("app.closeSave.title")
    .getByRole("button", { name: text("app.closeSave.discard"), exact: true })
    .click();
  await expect.poll(() => app.evaluate(() => global.quitRequests)).toBe(1);
  assert.deepEqual(
    await requests(),
    pendingCalls,
    "discard does not retry persistence",
  );
  checks.push(
    "native-close-video-or-trim-cancel-save-failure-return-and-explicit-discard",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks,
        layouts,
        requests: await requests(),
        quitRequests: await app.evaluate(() => global.quitRequests),
      },
      null,
      2,
    ),
  );
  console.log("Application shell locale PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        calls: await app.evaluate(() => global.shellCalls),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
