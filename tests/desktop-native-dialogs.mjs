// Actual Electron dispatcher, saved locale and preload. OS-owned pickers,
// shell/clipboard side effects and the command preview are bounded adapters.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pseudoCatalog } from "./fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const baseline = process.argv.includes("--baseline"),
  root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/native-dialogs-")),
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
const {createRequire}=require('node:module'),native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});native('../locales/registry.json').locales=${JSON.stringify(registry.locales)};
const detector=native('../backend/detect.cjs'),createDetector=detector.createDetector,core=native('../backend/core.cjs');detector.createDetector=options=>({...createDetector(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const update=native('../backend/update.cjs');update.checkForUpdate=async current=>({current,latest:current,newer:false,url:update.RELEASES_URL});
const service=native('../backend/service.cjs'),create=service.createService;service.createService=options=>{const svc=create({...options,localeRegistry:${JSON.stringify(registry)}}),invoke=svc.invoke.bind(svc);global.nativeService=svc;svc.invoke=(action,payload)=>action==='preview'?Promise.resolve(global.commandPreview):invoke(action,payload);return svc;};
const {ipcMain,dialog,shell,clipboard}=native('electron'),handle=ipcMain.handle.bind(ipcMain);global.pickers=[];global.shellOps=[];global.copies=[];global.nextOpen={canceled:true};global.nextSave={canceled:true};global.commandPreview={command:'fixture command',errors:[],issues:[]};
ipcMain.handle=(channel,listener)=>{if(channel==='encoder:action')global.nativeAction=listener;return handle(channel,listener);};
dialog.showOpenDialog=async(_w,options)=>{global.pickers.push({kind:'open',...options});return global.nextOpen;};dialog.showSaveDialog=async(_w,options)=>{global.pickers.push({kind:'save',...options});return global.nextSave;};shell.openExternal=async value=>{global.shellOps.push({kind:'external',value});};shell.openPath=async value=>{global.shellOps.push({kind:'path',value});return '';};shell.showItemInFolder=value=>global.shellOps.push({kind:'item',value});clipboard.writeText=value=>global.copies.push(value);
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
const checks = [],
  snapshots = [];
const fallback = {
  "dialog.video.add": "添加视频",
  "dialog.video.files": "视频文件",
  "dialog.video.pngSequence": "PNG 图片序列（选其中任意一张）",
  "dialog.files.all": "所有文件",
  "dialog.media.pick": "选择媒体文件",
  "dialog.media.files": "音视频文件",
  "dialog.media.allFiles": "全部文件",
  "dialog.output.pick": "选择新的输出文件",
  "dialog.output.files": "输出文件",
  "dialog.directory.output": "选择统一输出目录",
};
const errorFallback = {
  DESKTOP_UNTRUSTED_UI: "不受信任的界面",
  DESKTOP_ACTION_UNSUPPORTED: "不支持的操作",
  PROJECT_PAGE_UNKNOWN: "未知的项目页面",
  RELEASE_PAGE_UNTRUSTED: "只能打开本项目的发行页",
  REVEAL_PATH_UNTRUSTED: "只能打开当前任务的文件位置",
  MMD_HISTORY_EMPTY: "还没有 MMD 导出记录",
};
try {
  const page = await app.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible();
  const invoke = (action, payload) =>
    page.evaluate(
      ([action, payload]) => window.encoder.invokeResult(action, payload),
      [action, payload],
    );
  const picker = async (action, payload) => {
    const result = await invoke(action, payload);
    assert.ok(!result?.__mmdError, JSON.stringify(result));
    return { result, options: await app.evaluate(() => global.pickers.at(-1)) };
  };
  const data = () =>
    app.evaluate(() => {
      const s = global.nativeService.getState();
      return { settings: s.settings, presets: s.presets, jobs: s.jobs };
    });
  for (const locale of baseline ? ["zh-CN"] : ["zh-CN", "en-XA"]) {
    await invoke("setLocale", { locale });
    const text = (key) =>
      locale === "zh-CN" ? (source[key] ?? fallback[key]) : pseudo[key];
    const initial = await data();
    let p = await picker("pickFiles");
    assert.equal(p.options.title, text("dialog.video.add"));
    assert.deepEqual(p.options.properties, ["openFile", "multiSelections"]);
    assert.deepEqual(
      p.options.filters.map((x) => x.name),
      [
        "dialog.video.files",
        "dialog.video.pngSequence",
        "dialog.files.all",
      ].map(text),
    );
    assert.deepEqual(p.options.filters[0].extensions, [
      "avi",
      "mov",
      "mp4",
      "mkv",
      "webm",
      "m4v",
      "mpg",
      "mpeg",
      "mts",
      "m2ts",
      "wmv",
      "flv",
      "png",
    ]);
    assert.deepEqual(p.options.filters[1].extensions, ["png"]);
    assert.deepEqual(p.options.filters[2].extensions, ["*"]);
    snapshots.push({ locale, action: "pickFiles", options: p.options });
    for (const multiple of [false, true]) {
      p = await picker("pickMedia", { multiple });
      assert.equal(p.result, null);
      assert.equal(p.options.title, text("dialog.media.pick"));
      assert.deepEqual(
        p.options.properties,
        multiple ? ["openFile", "multiSelections"] : ["openFile"],
      );
      assert.deepEqual(
        p.options.filters.map((x) => x.name),
        ["dialog.media.files", "dialog.media.allFiles"].map(text),
      );
      assert.deepEqual(p.options.filters[0].extensions, [
        "avi",
        "mov",
        "mp4",
        "mkv",
        "webm",
        "wav",
        "flac",
        "mp3",
        "aac",
        "m4a",
        "opus",
        "ogg",
        "mka",
      ]);
      snapshots.push({
        locale,
        action: "pickMedia",
        multiple,
        options: p.options,
      });
    }
    for (const [payload, ext] of [
      [{ operation: "video" }, "mkv"],
      ...[
        ["wav", "wav"],
        ["flac", "flac"],
        ["aac", "m4a"],
        ["opus", "opus"],
        ["copy", "mka"],
        ["unknown", "wav"],
      ].map(([audioFormat, ext]) => [{ operation: "audio", audioFormat }, ext]),
    ]) {
      p = await picker("pickMediaOutput", payload);
      assert.equal(p.result, null);
      assert.equal(p.options.title, text("dialog.output.pick"));
      assert.equal(p.options.defaultPath, "output." + ext);
      assert.deepEqual(p.options.filters, [
        { name: text("dialog.output.files"), extensions: [ext] },
      ]);
      snapshots.push({
        locale,
        action: "pickMediaOutput",
        payload,
        options: p.options,
      });
    }
    p = await picker("pickDirectory");
    assert.equal(p.result, null);
    assert.equal(p.options.title, text("dialog.directory.output"));
    assert.deepEqual(p.options.properties, [
      "openDirectory",
      "createDirectory",
    ]);
    p = await picker("pickDirectory", { title: "User 原始标题 {x}" });
    assert.equal(p.options.title, "User 原始标题 {x}");
    assert.deepEqual(await data(), initial);
  }
  checks.push(
    "native-picker-titles-filters-extensions-default-names-and-cancel-semantics",
  );
  const raw = "C:/User 原路径 {a}/target.mkv";
  await app.evaluate(
    (_electron, value) =>
      (global.nextOpen = {
        canceled: false,
        filePaths: [value, "C:/second.mp4"],
      }),
    raw,
  );
  assert.equal(await invoke("pickMedia"), raw);
  assert.deepEqual(await invoke("pickMedia", { multiple: true }), [
    raw,
    "C:/second.mp4",
  ]);
  assert.equal(await invoke("pickDirectory", { title: "User" }), raw);
  await app.evaluate(
    (_electron, value) =>
      (global.nextSave = { canceled: false, filePath: value }),
    raw,
  );
  assert.equal(await invoke("pickMediaOutput", { operation: "video" }), raw);
  checks.push(
    "picker-return-values-keep-user-paths-and-single-multiple-shapes",
  );
  const expectError = async (result, code, fallbackMessage) => {
    assert.ok(result.__mmdError);
    assert.equal(
      result.__mmdError.message,
      fallbackMessage ?? source["error." + code] ?? errorFallback[code],
    );
    if (!baseline) assert.equal(result.__mmdError.code, code);
    return result.__mmdError;
  };
  const forged = await app.evaluate(() =>
    global.nativeAction({ sender: {}, senderFrame: {} }, "state"),
  );
  await expectError(forged, "DESKTOP_UNTRUSTED_UI");
  const unsupported = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return global.nativeAction(
      { sender: w.webContents, senderFrame: w.webContents.mainFrame },
      "unlisted-fixture-action",
    );
  });
  await expectError(unsupported, "DESKTOP_ACTION_UNSUPPORTED");
  for (const [action, payload, code] of [
    ["openProjectPage", { page: "unknown" }, "PROJECT_PAGE_UNKNOWN"],
    [
      "openReleasePage",
      { url: "https://external.invalid/release" },
      "RELEASE_PAGE_UNTRUSTED",
    ],
    ["reveal", { path: raw }, "REVEAL_PATH_UNTRUSTED"],
  ])
    await expectError(await invoke(action, payload), code);
  assert.deepEqual(await app.evaluate(() => global.shellOps), []);
  if (!baseline) {
    const blocked = await invoke("unlisted-fixture-action");
    assert.equal(blocked.__mmdError.code, "DESKTOP_ACTION_UNSUPPORTED");
    const legacy = await page.evaluate(() =>
      window.encoder.invoke("unlisted-fixture-action").then(
        () => ({ resolved: true }),
        (error) => ({ resolved: false, message: error.message }),
      ),
    );
    assert.equal(legacy.resolved, false);
  }
  checks.push(
    "sender-action-url-and-reveal-restrictions-retain-failure-semantics",
  );
  await app.evaluate(
    () =>
      (global.commandPreview = {
        command: "forbidden fixture",
        errors: ["音频码率无效，请选择列表中的码率"],
        issues: [
          {
            code: "AUDIO_BITRATE_INVALID",
            params: {},
            message: "音频码率无效，请选择列表中的码率",
          },
        ],
      }),
  );
  const copyError = await invoke("copyCommand", { id: "fixture" });
  assert.equal(
    copyError.__mmdError.message,
    "音频码率无效，请选择列表中的码率",
  );
  if (!baseline) {
    assert.equal(copyError.__mmdError.code, "VIDEO_COMMAND_INVALID");
    assert.equal(
      copyError.__mmdError.params.errors[0].code,
      "AUDIO_BITRATE_INVALID",
    );
  }
  assert.deepEqual(await app.evaluate(() => global.copies), []);
  await app.evaluate(
    () =>
      (global.commandPreview = {
        command: 'ffmpeg.exe -i "User 原路径 {a}"',
        errors: [],
        issues: [],
      }),
  );
  await invoke("copyCommand", { id: "fixture" });
  assert.deepEqual(await app.evaluate(() => global.copies), [
    'ffmpeg.exe -i "User 原路径 {a}"',
  ]);
  checks.push(
    "copy-validation-stops-clipboard-and-preserves-structured-issues",
  );
  const history = path.join(
    process.env.LOCALAPPDATA,
    "MMDEncoder/mmd-plugin/exports.jsonl",
  );
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, "");
  await expectError(await invoke("mmdOpenLatest"), "MMD_HISTORY_EMPTY");
  const missingDir = path.join(dir, "User missing {folder}"),
    output = path.join(missingDir, "User output.mp4");
  fs.writeFileSync(history, JSON.stringify({ output }) + "\n");
  const missing = await expectError(
    await invoke("mmdOpenLatest"),
    "MMD_HISTORY_DIRECTORY_MISSING",
    "上次导出的文件夹已不存在：" + missingDir,
  );
  if (!baseline) assert.equal(missing.params.path, missingDir);
  fs.mkdirSync(missingDir);
  await invoke("mmdOpenLatest");
  assert.deepEqual((await app.evaluate(() => global.shellOps)).at(-1), {
    kind: "path",
    value: missingDir,
  });
  const mask = path.join(missingDir, "User mask.mkv");
  fs.writeFileSync(mask, "fixture bytes");
  fs.appendFileSync(history, JSON.stringify({ output, mask }) + "\n");
  await invoke("mmdOpenLatest");
  assert.deepEqual((await app.evaluate(() => global.shellOps)).at(-1), {
    kind: "item",
    value: mask,
  });
  checks.push(
    "mmd-history-empty-missing-folder-and-mask-selection-stay-isolated",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        baseline,
        checks,
        snapshots,
        copyError: copyError.__mmdError,
        missingHistory: missing,
      },
      null,
      2,
    ),
  );
  console.log("Native dialog and IPC workflow PASS", dir);
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        pickers: await app.evaluate(() => global.pickers),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
