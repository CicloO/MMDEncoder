// Actual preset service and App/draft workflows. Only the hardware capability
// probe is fixed to CPU so this UI test does not repeat GPU trial encodes.
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ff } = require("./engines.cjs"),
  core = require("../backend/core.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/preset-flow-")),
  data = path.join(dir, "data");
fs.mkdirSync(data);
const alpha = core.BUILTINS.find((p) => p.id === "builtin-alpha");
fs.writeFileSync(
  path.join(data, "settings.json"),
  JSON.stringify({
    version: 1,
    settings: core.DEFAULTS,
    presets: [],
    builtins: {
      "builtin-alpha": {
        name: "User alpha old",
        settings: {
          ...alpha.settings,
          quality: 4,
          presetName: "User alpha old",
        },
        base: "older-definition",
      },
      "builtin-alpha-mask": {
        name: "User mask old",
        settings: {
          ...alpha.settings,
          quality: 25,
          presetName: "User mask old",
        },
        base: "older-definition",
      },
    },
  }),
);
const source = path.join(dir, "source.mkv");
execFileSync(
  ff,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=64x64:r=30:d=0.3",
    "-c:v",
    "ffv1",
    source,
  ],
  { windowsHide: true },
);
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
const detectors=native('../backend/detect.cjs'),original=detectors.createDetector,core=native('../backend/core.cjs');
detectors.createDetector=options=>({...original(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const updates=native('../backend/update.cjs');updates.checkForUpdate=async current=>({current,latest:current,newer:false,url:updates.RELEASES_URL});
const {ipcMain}=native('electron'),handle=ipcMain.handle.bind(ipcMain);global.presetCalls=[];
ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{if(/Preset|^settings$|^setOwn$/.test(action))global.presetCalls.push({action,payload:args[0]??null});return listener(event,action,...args);});
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
  snapshots = [];
try {
  const page = await app.firstWindow();
  const state = () => page.evaluate(() => window.encoder.invokeResult("state"));
  const modal = (name) => page.getByRole("dialog", { name, exact: true });
  const manager = modal("预设管理");
  const openManager = async () => {
    await page.getByRole("button", { name: "预设管理", exact: true }).click();
    await expect(manager).toBeVisible();
  };
  const row = (name) =>
    manager
      .locator(".preset-item")
      .filter({ has: page.getByText(name, { exact: true }) });
  await expect(modal("内置预设已更新")).toBeVisible();
  await modal("内置预设已更新")
    .locator(".preset-item")
    .filter({ hasText: "User alpha old" })
    .getByRole("button", { name: "保留我的版本", exact: true })
    .click();
  await expect.poll(async () => (await state()).presetConflicts.length).toBe(1);
  await modal("内置预设已更新")
    .locator(".preset-item")
    .filter({ hasText: "User mask old" })
    .getByRole("button", { name: "用新版覆盖", exact: true })
    .click();
  await expect(modal("内置预设已更新")).toBeHidden();
  await expect.poll(async () => !(await state()).detecting).toBe(true);
  const kept = (await state()).presets.find(
    (p) => p.name === "User alpha old (Modified)",
  );
  assert.equal(kept.settings.quality, 4);
  assert.equal(
    (await state()).presets.some((p) => p.name === "User mask old (Modified)"),
    false,
  );
  checks.push("resolve-conflicts-keeps-or-drops-only-requested-edits");
  await openManager();
  snapshots.push({ name: "manager", text: await manager.innerText() });
  await manager.getByRole("button", { name: "新建预设", exact: true }).click();
  const save = modal("保存当前配置");
  await expect(save).toBeVisible();
  await save.locator("#preset-name").fill("User saved {a}");
  await save.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(save).toBeHidden();
  const saved = (await state()).presets.find(
    (p) => p.name === "User saved {a}",
  );
  assert.ok(saved && !saved.builtin);
  const settingsBefore = saved.settings;
  checks.push("create-preset-from-current-settings");
  await openManager();
  await row(saved.name)
    .getByRole("button", { name: "编辑名称", exact: true })
    .click();
  const rename = modal("修改预设名称");
  await rename.locator("#rename-preset").fill("Cancelled rename");
  await rename.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    (await state()).presets.find((p) => p.id === saved.id).name,
    saved.name,
  );
  await row(saved.name)
    .getByRole("button", { name: "编辑名称", exact: true })
    .click();
  await expect(rename.locator("#rename-preset")).toHaveValue(saved.name);
  await rename.locator("#rename-preset").fill(kept.name);
  await rename.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(rename.getByRole("alert")).toContainText("同名");
  await rename.locator("#rename-preset").fill("User renamed {b}");
  await rename.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(rename).toBeHidden();
  const renamed = (await state()).presets.find((p) => p.id === saved.id);
  assert.deepEqual(
    { ...renamed.settings, presetName: settingsBefore.presetName },
    settingsBefore,
  );
  await row(renamed.name)
    .getByRole("button", { name: "隐藏预设 " + renamed.name, exact: true })
    .click();
  await expect(row(renamed.name)).toHaveClass(/is-hidden/);
  await page.keyboard.press("Escape");
  await expect(
    page.locator("#preset-select option").filter({ hasText: renamed.name }),
  ).toHaveCount(1);
  const builtin =
    (await state()).presets.find((p) => p.id === "builtin-cpu") ||
    (await state()).presets.find((p) => p.builtin);
  await page.selectOption("#preset-select", builtin.id);
  await expect(
    page.locator("#preset-select option").filter({ hasText: renamed.name }),
  ).toHaveCount(0);
  await openManager();
  await row(renamed.name)
    .getByRole("button", { name: "显示预设 " + renamed.name, exact: true })
    .click();
  await expect(row(renamed.name)).not.toHaveClass(/is-hidden/);
  await row(renamed.name)
    .getByRole("button", { name: "调用", exact: true })
    .click();
  await expect(manager).toBeHidden();
  await expect(page.locator("#preset-select")).toHaveValue(renamed.id);
  checks.push("rename-cancel-duplicate-and-preserved-parameters");
  checks.push("active-hidden-choice-and-show-apply");
  await page.selectOption("#fps", "24");
  await page.selectOption("#preset-select", builtin.id);
  const switching = modal("切换编码预设");
  await expect(switching).toBeVisible();
  await switching
    .getByRole("button", { name: "保留当前设置", exact: true })
    .click();
  await expect(page.locator("#preset-select")).toHaveValue(renamed.id);
  await expect(page.locator("#fps")).toHaveValue("24");
  await page.selectOption("#preset-select", builtin.id);
  await switching.getByRole("button", { name: /^应用“/ }).click();
  await expect(switching).toBeHidden();
  await expect(page.locator("#preset-select")).toHaveValue(builtin.id);
  await page.selectOption("#fps", "25");
  await page
    .getByRole("button", { name: "保存到当前预设", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await state()).presets.find((p) => p.id === builtin.id).settings.fps,
    )
    .toBe("25");
  checks.push("pending-switch-cancel-confirm-and-overwrite");
  await page.evaluate(
    (file) => window.encoder.invokeResult("add", { paths: [file] }),
    source,
  );
  await expect.poll(async () => (await state()).jobs[0]?.status).toBe("ready");
  const globalSettings = (await state()).settings;
  await page.locator(".job-own-toggle input").click();
  await expect(page.locator(".job-own-toggle input")).toBeChecked();
  await expect(page.locator(".job-preset-note")).toBeVisible();
  await page.selectOption("#fps", "30");
  await page.getByRole("button", { name: "另存为预设", exact: true }).click();
  await save.locator("#preset-name").fill("Own saved {c}");
  await save.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(save).toBeHidden();
  const own = (await state()).presets.find((p) => p.name === "Own saved {c}");
  assert.equal(own.settings.fps, "30");
  assert.deepEqual((await state()).settings, globalSettings);
  const callsAfterOwn = await app.evaluate(() => global.presetCalls);
  assert.ok(
    callsAfterOwn.find(
      (x) => x.action === "savePreset" && x.payload.name === "Own saved {c}",
    ).payload.settings,
  );
  checks.push("own-settings-save-does-not-overwrite-page-settings");
  await openManager();
  const importedFile = path.join(dir, "import.json"),
    exportedFile = path.join(dir, "export.json");
  fs.writeFileSync(
    importedFile,
    JSON.stringify({
      version: 1,
      presets: [{ name: "Imported {d}", settings: core.DEFAULTS }],
    }),
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, importedFile);
  await manager.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await expect(row("Imported {d}")).toBeVisible();
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exportedFile);
  await manager.getByRole("button", { name: "导出预设", exact: true }).click();
  await expect.poll(() => fs.existsSync(exportedFile)).toBe(true);
  const exported = JSON.parse(fs.readFileSync(exportedFile));
  assert.ok(exported.presets.some((p) => p.name === "Imported {d}"));
  assert.equal(
    exported.presets.some((p) => p.builtin),
    false,
  );
  await manager
    .getByRole("button", { name: "恢复内置预设", exact: true })
    .click();
  await expect
    .poll(async () =>
      JSON.stringify(
        (await state()).presets.find((p) => p.id === builtin.id).settings,
      ),
    )
    .toBe(JSON.stringify(builtin.settings));
  checks.push("import-export-and-restore-builtins");
  const victim = "Imported {d}";
  await row(victim)
    .getByRole("button", { name: "删除预设 " + victim, exact: true })
    .click();
  const deletion = modal("删除个人预设");
  await expect(
    deletion.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await deletion.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row(victim)).toBeVisible();
  await row(victim)
    .getByRole("button", { name: "删除预设 " + victim, exact: true })
    .click();
  await deletion.getByRole("button", { name: "删除预设", exact: true }).click();
  await expect(row(victim)).toHaveCount(0);
  assert.equal(fs.existsSync(source), true);
  checks.push("delete-cancel-default-focus-and-confirm-preserve-input");
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  const actions = (await app.evaluate(() => global.presetCalls)).filter(
    (x) => x.action !== "settings",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ checks, snapshots, actions }, null, 2),
  );
  console.log("Preset workflow PASS", dir);
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
