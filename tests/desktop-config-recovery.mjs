// Actual App/service/settings I/O, with only copyFileSync failure and CPU
// detection controlled. This never changes the user's configuration folder.
import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/config-recovery-")),
  data = path.join(dir, "data"),
  file = path.join(data, "settings.json"),
  raw = "User original unreadable {raw}";
fs.mkdirSync(data);
fs.writeFileSync(file, raw);
const registry = {
    ...require("../locales/registry.json"),
    locales: [
      ...require("../locales/registry.json").locales,
      { id: "en-XA", name: "Test English", file: "test-only.json" },
    ],
  },
  registryFile = path.join(dir, "registry.json"),
  outDir = path.join(dir, "fixture-dist");
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
const {createRequire}=require('node:module'),native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))}),fs=require('node:fs'),copy=fs.copyFileSync;global.backupDenied=true;global.backupAttempts=[];fs.copyFileSync=(from,to,...rest)=>{if(from===${JSON.stringify(file)}){global.backupAttempts.push(to);if(global.backupDenied)throw Object.assign(Error('fixture EACCES {diagnostic}'),{code:'EACCES'});}return copy(from,to,...rest);};
const detectors=native('../backend/detect.cjs'),createDetector=detectors.createDetector,core=native('../backend/core.cjs');detectors.createDetector=options=>({...createDetector(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const service=native('../backend/service.cjs'),create=service.createService;service.createService=options=>create({...options,localeRegistry:${JSON.stringify(registry)}});const u=native('../backend/update.cjs');u.checkForUpdate=async current=>({current,latest:current,newer:false,url:u.RELEASES_URL});native('./main.cjs');`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: data,
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible();
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.showInactive();
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await expect(page.locator(".error-banner")).toContainText(
    "原配置备份失败，本次设置尚未保存",
  );
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  await page
    .getByRole("button", { name: "关于与语言 · Language", exact: true })
    .click();
  const about = page.getByRole("dialog");
  await expect(about).toHaveAccessibleName("关于");
  await about.locator("#about-locale").selectOption("en-XA");
  await expect(about.getByRole("alert")).toContainText("本次设置尚未保存");
  await expect(about.locator("#about-locale")).toHaveValue("system");
  assert.equal(
    await page.evaluate(() => document.documentElement.lang),
    "zh-CN",
  );
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  assert.equal(
    fs.readdirSync(data).filter((n) => n.includes(".unreadable-")).length,
    0,
  );
  await app.evaluate(() => (global.backupDenied = false));
  await about.locator("#about-locale").selectOption("en-XA");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe("en-XA");
  await expect(about.locator("#about-locale")).toHaveValue("en-XA");
  await expect(about.getByRole("alert")).toHaveCount(0);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")),
    state = await page.evaluate(() => window.encoder.invokeResult("state"));
  assert.equal(saved.preferences.locale, "en-XA");
  assert.equal(state.noticeData.code, "SETTINGS_UNREADABLE");
  const backups = fs
    .readdirSync(data)
    .filter((n) => n.includes(".unreadable-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(data, backups[0]), "utf8"), raw);
  await page.keyboard.press("Escape");
  await expect(page.locator(".toast")).toContainText(backups[0]);
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks: [
          "actual-autosave-and-preference-write-preserve-original-while-backup-denied",
          "language-stays-saved-choice-on-failure",
          "retry-creates-exact-backup-before-saving-and-refreshes-notice",
        ],
        backup: backups[0],
        attempts: await app.evaluate(() => global.backupAttempts),
        notice: state.noticeData,
      },
      null,
      2,
    ),
  );
  console.log("Configuration backup recovery desktop PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
