// Actual App/preset/IPC owner, with a test-only locale registry and CPU probe.
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pseudoCatalog } from "./fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/preset-locale-")),
  outDir = path.join(dir, "fixture-dist"),
  data = path.join(dir, "data");
fs.mkdirSync(data);
const core = require("../backend/core.cjs"),
  source = require("../locales/zh-CN.json"),
  pseudo = pseudoCatalog(source),
  catalogFile = path.join(dir, "test-only.json");
fs.writeFileSync(catalogFile, JSON.stringify(pseudo));
const registry = {
  ...require("../locales/registry.json"),
  locales: [
    ...require("../locales/registry.json").locales,
    { id: "en-XA", name: "Test English", file: catalogFile },
  ],
};
const registryFile = path.join(dir, "registry.json");
fs.writeFileSync(registryFile, JSON.stringify(registry));
fs.writeFileSync(
  path.join(data, "settings.json"),
  JSON.stringify({
    version: 1,
    settings: core.DEFAULTS,
    presets: [
      { id: "user-a", name: "User 原名 {a}", settings: core.DEFAULTS },
      { id: "user-b", name: "User 原名 {b}", settings: core.DEFAULTS },
    ],
    builtins: {
      "builtin-alpha": {
        name: "User old {c}",
        settings: core.BUILTINS.find((p) => p.id === "builtin-alpha").settings,
        base: "older-definition",
      },
    },
  }),
);
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
const reg=native('../locales/registry.json');reg.locales=${JSON.stringify(registry.locales)};
const detector=native('../backend/detect.cjs'),create=detector.createDetector,core=native('../backend/core.cjs');detector.createDetector=options=>({...create(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const update=native('../backend/update.cjs');update.checkForUpdate=async current=>({current,latest:current,newer:false,url:update.RELEASES_URL});
const {ipcMain,dialog}=native('electron'),handle=ipcMain.handle.bind(ipcMain);global.presetCalls=[];global.pickers=[];global.nextOpen={canceled:true};global.nextSave={canceled:true};
ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{global.presetCalls.push({action,payload:args[0]??null});return listener(event,action,...args);});
dialog.showOpenDialog=async(_w,options)=>{global.pickers.push({kind:'open',...options});return global.nextOpen;};dialog.showSaveDialog=async(_w,options)=>{global.pickers.push({kind:'save',...options});return global.nextSave;};
native('./main.cjs');`,
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
const checks = [],
  layouts = [];
let language = "zh-CN";
const text = (key, params = {}) =>
  (language === "zh-CN" ? source : pseudo)[key].replace(
    /\{(\w+)\}/g,
    (token, key) => (Object.hasOwn(params, key) ? String(params[key]) : token),
  );
try {
  const page = await app.firstWindow(),
    dialog = (key) =>
      page.getByRole("dialog", { name: text(key), exact: true });
  const state = () => page.evaluate(() => window.encoder.invokeResult("state"));
  const calls = () =>
    app.evaluate(() =>
      global.presetCalls.filter((x) => /Preset/.test(x.action)),
    );
  const authority = async () => {
    const s = await state();
    return {
      settings: s.settings,
      presets: s.presets,
      conflicts: s.presetConflicts,
    };
  };
  const choose = async (locale) => {
    await page.evaluate(
      (locale) => window.encoder.invokeResult("setLocale", { locale }),
      locale,
    );
    language = locale;
    await expect
      .poll(() => page.evaluate(() => document.documentElement.lang))
      .toBe(locale);
  };
  const layout = async (key, label) => {
    for (const width of [1360, 650]) {
      const contentWidth = await app.evaluate(({ BrowserWindow }, width) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(width, 1000);
        return w.getContentBounds().width;
      }, width);
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(contentWidth);
      const box = await dialog(key).evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        height: el.getBoundingClientRect().height,
      }));
      assert.ok(box.scroll <= box.client + 1, label + " horizontal overflow");
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
  await expect(dialog("preset.conflicts.title")).toBeVisible();
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1360, 1000);
      w.showInactive();
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await expect(dialog("preset.conflicts.title")).toBeVisible();
  await choose("en-XA");
  await expect(dialog("preset.conflicts.title")).toContainText("User old {c}");
  await layout("preset.conflicts.title", "conflicts-long");
  await dialog("preset.conflicts.title")
    .getByRole("button", { name: text("preset.conflicts.keep"), exact: true })
    .click();
  await expect(dialog("preset.conflicts.title")).toBeHidden();
  await expect.poll(async () => !(await state()).detecting).toBe(true);
  checks.push("conflict-default-label-refresh-and-user-name-preserved");
  await choose("zh-CN");
  await page
    .getByRole("button", { name: source["preset.manager.title"], exact: true })
    .click();
  await expect(dialog("preset.manager.title")).toBeVisible();
  const before = await authority(),
    beforeCalls = await calls();
  await page.evaluate(
    () => (window.presetNode = document.querySelector('[role="dialog"]')),
  );
  await choose("en-XA");
  assert.equal(
    await page.evaluate(
      () => window.presetNode === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  assert.deepEqual(await authority(), before);
  assert.deepEqual(await calls(), beforeCalls);
  await layout("preset.manager.title", "manager-long");
  // Real drag events use the existing grip and service reorder action.
  const rows = dialog("preset.manager.title").locator(".preset-item"),
    from = rows.first(),
    to = rows.nth(1),
    ids = (await state()).presets.map((p) => p.id);
  await from.locator(".drag-handle").dispatchEvent("pointerdown");
  await expect(from).toHaveAttribute("draggable", "true");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent("dragstart", { dataTransfer: transfer });
  await to.dispatchEvent("dragover", { dataTransfer: transfer });
  await to.dispatchEvent("drop", { dataTransfer: transfer });
  await from.dispatchEvent("dragend", { dataTransfer: transfer });
  await expect
    .poll(async () => (await state()).presets.map((p) => p.id).join(","))
    .toBe([ids[1], ids[0], ...ids.slice(2)].join(","));
  checks.push(
    "locale-keeps-dialog-data-order-and-requests-and-grip-reorder-still-works",
  );
  await dialog("preset.manager.title")
    .getByRole("button", { name: text("preset.new"), exact: true })
    .click();
  const input = () => dialog("preset.save.title").locator("#preset-name");
  await input().fill("User 未保存 {draft}");
  await input().evaluate((el) => {
    window.presetInput = el;
    el.setSelectionRange(5, 8);
  });
  const saveCalls = await calls();
  await choose("zh-CN");
  await expect(input()).toHaveValue("User 未保存 {draft}");
  await expect(input()).toBeFocused();
  assert.equal(await input().evaluate((el) => el === window.presetInput), true);
  assert.equal(await input().evaluate((el) => el.selectionStart), 5);
  assert.deepEqual(await calls(), saveCalls);
  await input().fill("User 原名 {a}");
  await dialog("preset.save.title")
    .getByRole("button", { name: text("preset.save"), exact: true })
    .click();
  await expect(
    dialog("preset.save.title").getByRole("alert").first(),
  ).toContainText(source["error.PRESET_DUPLICATE"]);
  await expect(dialog("preset.save.title").getByRole("alert")).toHaveCount(1);
  await choose("en-XA");
  await expect(
    dialog("preset.save.title").getByRole("alert").first(),
  ).toContainText(pseudo["error.PRESET_DUPLICATE"]);
  await expect(dialog("preset.save.title").getByRole("alert")).toHaveCount(1);
  await expect(input()).toHaveValue("User 原名 {a}");
  await layout("preset.save.title", "save-error-long");
  await input().fill("User 新存 {d}");
  await dialog("preset.save.title")
    .getByRole("button", { name: text("preset.save"), exact: true })
    .click();
  await expect(dialog("preset.save.title")).toBeHidden();
  await expect(page.locator(".toast")).toContainText(
    pseudo["message.PRESET_SAVED"],
  );
  await choose("zh-CN");
  await expect(page.locator(".toast")).toContainText(
    source["message.PRESET_SAVED"],
  );
  checks.push(
    "save-draft-caret-focus-and-error-refresh-without-remount-and-success-notice-refresh",
  );
  await page
    .getByRole("button", { name: text("preset.manager.title"), exact: true })
    .click();
  const userRow = () =>
    dialog("preset.manager.title")
      .locator(".preset-item")
      .filter({ has: page.getByText("User 原名 {a}", { exact: true }) });
  await userRow()
    .getByRole("button", { name: text("preset.rename"), exact: true })
    .click();
  await dialog("preset.rename.title")
    .locator("#rename-preset")
    .fill("User 改名草稿 {e}");
  await choose("en-XA");
  await expect(
    dialog("preset.rename.title").locator("#rename-preset"),
  ).toHaveValue("User 改名草稿 {e}");
  await layout("preset.rename.title", "rename-long");
  await dialog("preset.rename.title")
    .getByRole("button", { name: text("common.cancel"), exact: true })
    .click();
  await userRow()
    .getByRole("button", {
      name: text("preset.deleteName", { name: "User 原名 {a}" }),
      exact: true,
    })
    .click();
  await expect(
    dialog("preset.delete.title").getByRole("button", {
      name: text("common.cancel"),
      exact: true,
    }),
  ).toBeFocused();
  await expect(dialog("preset.delete.title")).toContainText(
    text("preset.delete.personal", { name: "User 原名 {a}" }),
  );
  await layout("preset.delete.title", "delete-long");
  await dialog("preset.delete.title")
    .getByRole("button", { name: text("common.cancel"), exact: true })
    .click();
  checks.push("rename-draft-and-delete-cancel-preserve-user-names");
  // Capture actual picker options without opening an OS-owned native dialog.
  for (const locale of ["zh-CN", "en-XA"]) {
    await choose(locale);
    const stable = await authority();
    await dialog("preset.manager.title")
      .getByRole("button", { name: text("preset.import"), exact: true })
      .click();
    await expect
      .poll(
        async () => (await app.evaluate(() => global.pickers)).at(-1)?.title,
      )
      .toBe(text("dialog.preset.import"));
    await dialog("preset.manager.title")
      .getByRole("button", { name: text("preset.export"), exact: true })
      .click();
    await expect
      .poll(
        async () => (await app.evaluate(() => global.pickers)).at(-1)?.title,
      )
      .toBe(text("dialog.preset.export"));
    const pickers = await app.evaluate(() => global.pickers.slice(-2));
    assert.equal(pickers[0].filters[0].name, text("dialog.preset.json"));
    assert.deepEqual(pickers[0].filters[0].extensions, ["json"]);
    assert.equal(pickers[1].defaultPath, "MMDEncoder-presets.json");
    assert.deepEqual(
      await authority(),
      stable,
      "native cancellation preserves all data",
    );
  }
  const invalid = path.join(dir, "bad.json");
  fs.writeFileSync(invalid, "{bad");
  await app.evaluate(
    (_electron, file) =>
      (global.nextOpen = { canceled: false, filePaths: [file] }),
    invalid,
  );
  await dialog("preset.manager.title")
    .getByRole("button", { name: text("preset.import"), exact: true })
    .click();
  await expect(dialog("preset.manager.title").getByRole("alert")).toContainText(
    pseudo["error.PRESET_FILE_UNREADABLE"],
  );
  await choose("zh-CN");
  await expect(dialog("preset.manager.title").getByRole("alert")).toContainText(
    source["error.PRESET_FILE_UNREADABLE"],
  );
  fs.writeFileSync(invalid, JSON.stringify({ version: 2, presets: [] }));
  await dialog("preset.manager.title")
    .getByRole("button", { name: text("preset.import"), exact: true })
    .click();
  await expect(dialog("preset.manager.title").getByRole("alert")).toContainText(
    source["error.PRESET_FILE_VERSION"],
  );
  fs.writeFileSync(
    invalid,
    JSON.stringify({
      version: 1,
      presets: [{ name: "Bad params", settings: { quality: "bad" } }],
    }),
  );
  await dialog("preset.manager.title")
    .getByRole("button", { name: text("preset.import"), exact: true })
    .click();
  await expect(dialog("preset.manager.title").getByRole("alert")).toContainText(
    "quality",
  );
  await choose("en-XA");
  await expect(dialog("preset.manager.title").getByRole("alert")).toContainText(
    text("error.PRESET_SETTINGS_INVALID", {
      detail: text("error.SETTINGS_FIELD_INVALID", { field: "quality" }),
    }),
  );
  checks.push(
    "native-picker-title-filter-cancel-and-actual-read-version-schema-failures-refresh",
  );
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  await page.keyboard.press("Escape");
  await choose("zh-CN");
  await page.selectOption("#fps", "24");
  await page.selectOption("#preset-select", "builtin-4k");
  await expect(dialog("preset.switch.title")).toBeVisible();
  await choose("en-XA");
  await layout("preset.switch.title", "switch-long");
  await expect(
    dialog("preset.switch.title").getByRole("button", {
      name: text("preset.switch.keep"),
      exact: true,
    }),
  ).toBeFocused();
  await dialog("preset.switch.title")
    .getByRole("button", { name: text("preset.switch.keep"), exact: true })
    .click();
  await expect(page.locator("#fps")).toHaveValue("24");
  checks.push(
    "switch-confirmation-keeps-edits-and-cancel-focus-after-locale-refresh",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks,
        layouts,
        pickers: await app.evaluate(() => global.pickers),
        actions: await calls(),
      },
      null,
      2,
    ),
  );
  console.log("Preset locale workflow PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        calls: await app.evaluate(() => global.presetCalls),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
