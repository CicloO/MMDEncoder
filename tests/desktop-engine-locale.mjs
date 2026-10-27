// Real App/service/tools with a test-only locale registry and local tool bytes.
// Neither this registry nor the fixture catalog is included in portable builds.
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
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/engine-locale-")),
  outDir = path.join(dir, "fixture-dist");
const registry = {
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
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
global.engineCalls=[];global.toolWait=null;global.goodHash=false;global.fixtureBytes=Buffer.from('local fixture tool archive');
const service=native('../backend/service.cjs'),create=service.createService;
service.createService=options=>create({...options,localeRegistry:${JSON.stringify(registry)},toolOptions:{
  resolveReleases:()=>new Promise((resolve,reject)=>{global.toolWait={resolve,reject};}),
  downloadRequest:()=>new Promise(resolve=>{global.toolDownload=resolve;}),
  extract:async(_exe,args)=>{
    if(args[0]==='l')return 'Path = bin/ffmpeg.exe\\nPath = bin/ffprobe.exe';
    const dest=args.find(a=>a.startsWith('-o')).slice(2);fs.mkdirSync(path.join(dest,'bin'));
    fs.writeFileSync(path.join(dest,'bin/ffmpeg.exe'),'test tool');fs.writeFileSync(path.join(dest,'bin/ffprobe.exe'),'test tool');return '';
  },verify:async()=> 'fixture version'
}});
global.releaseTools=()=>global.toolWait.resolve([{id:'ffmpeg',version:'fixture-1',url:'https://www.gyan.dev/fixture.7z',sha256:global.goodHash?crypto.createHash('sha256').update(global.fixtureBytes).digest('hex'):'0'.repeat(64)}]);
global.startDownload=()=>global.toolDownload(new Response(new ReadableStream({start(controller){global.downloadController=controller;controller.enqueue(global.fixtureBytes);}}),{headers:{'content-length':String(global.fixtureBytes.length)}}));
const updates=native('../backend/update.cjs');updates.checkForUpdate=async current=>({current,latest:current,newer:false,url:updates.RELEASES_URL});
const {ipcMain}=native('electron'),handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{global.engineCalls.push({action,payload:args[0]??null});return listener(event,action,...args);});
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
try {
  const page = await app.firstWindow();
  const engine = () => page.getByRole("dialog");
  await expect(
    page.getByRole("dialog", { name: "编码引擎", exact: true }),
  ).toBeVisible();
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1360, 1000);
      w.showInactive();
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await expect(
    page.getByRole("dialog", { name: "编码引擎", exact: true }),
  ).toBeVisible();
  const pseudo = await page.evaluate(() => window.appAboutFixture.pseudo);
  const state = () => page.evaluate(() => window.encoder.invokeResult("state"));
  const choose = (locale) =>
    page.evaluate(
      (locale) => window.encoder.invokeResult("setLocale", { locale }),
      locale,
    );
  const calls = () =>
    app.evaluate(() =>
      global.engineCalls.filter((x) =>
        [
          "checkTools",
          "installTools",
          "detect",
          "pickDirectory",
          "setToolsRoot",
        ].includes(x.action),
      ),
    );
  await page.evaluate(() => {
    window.engineNode = document.querySelector('[role="dialog"]');
  });
  const initial = await state();
  assert.ok(
    initial.noticeData?.code,
    "first missing-engine notice must have a descriptor",
  );
  await choose("en-XA");
  await expect(engine().locator('[role="alert"]').last()).toContainText(
    pseudo["message." + initial.noticeData.code],
  );
  assert.equal(
    await page.evaluate(
      () => window.engineNode === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  assert.deepEqual(await calls(), []);
  checks.push("first-start-summary-error-refreshes-with-the-dialog");
  await choose("zh-CN");
  await engine()
    .getByRole("button", { name: "检查工具更新", exact: true })
    .click();
  await expect(
    engine().getByRole("button", { name: "正在处理…", exact: true }),
  ).toBeDisabled();
  await choose("en-XA");
  assert.equal((await state()).tools.phase, "checking");
  assert.deepEqual(
    (await calls()).map((x) => x.action),
    ["checkTools"],
  );
  await app.evaluate(() =>
    global.toolWait.reject(Error("Foreign tool response: 舞台{detail}")),
  );
  await expect.poll(async () => (await state()).tools.phase).toBe("error");
  await expect(engine().getByRole("alert").first()).toContainText(
    "Foreign tool response: 舞台{detail}",
  );
  await choose("zh-CN");
  await expect(engine().getByRole("alert").first()).toContainText(
    "Foreign tool response: 舞台{detail}",
  );
  checks.push("checking-keeps-request-and-foreign-diagnostic");
  await engine()
    .getByRole("button", { name: "重试下载并安装", exact: true })
    .click();
  await app.evaluate(() => global.releaseTools());
  await expect
    .poll(async () => (await state()).tools.phase)
    .toBe("downloading");
  await app.evaluate(() => global.startDownload());
  await expect
    .poll(async () => (await state()).tools.received)
    .toBeGreaterThan(0);
  const downloading = (await state()).tools;
  assert.equal(downloading.errorData, null);
  await choose("en-XA");
  const changed = (await state()).tools;
  assert.equal(changed.received, downloading.received);
  assert.equal(changed.total, downloading.total);
  assert.deepEqual(
    (await calls()).map((x) => x.action),
    ["checkTools", "installTools"],
  );
  assert.equal(
    await page.evaluate(
      () => window.engineNode === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  checks.push("downloading-locale-keeps-bytes-request-and-node");
  await app.evaluate(() => global.downloadController.close());
  await expect.poll(async () => (await state()).tools.phase).toBe("error");
  const bad = (await state()).tools;
  assert.ok(bad.errorData.code && pseudo["error." + bad.errorData.code]);
  await expect(engine().getByRole("alert").first()).toContainText(
    pseudo["error." + bad.errorData.code],
  );
  await choose("zh-CN");
  await expect(engine().getByRole("alert").first()).toContainText(
    bad.errorData.message,
  );
  checks.push("actual-checksum-failure-reformats-from-error-descriptor");
  const nextRoot = path.join(dir, "relocated-after-error");
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, nextRoot);
  await engine().getByRole("button", { name: "更改位置", exact: true }).click();
  await expect(engine().locator("#tools-root")).toHaveValue(nextRoot);
  const relocated = (await state()).tools;
  assert.equal(relocated.errorData, null);
  assert.equal(
    relocated.phase,
    "error",
    "message migration preserves the existing phase after relocation",
  );
  await choose("en-XA");
  await expect(engine().getByRole("alert").first()).toContainText(
    pseudo["message." + relocated.messageData.code],
  );
  await expect(engine().getByRole("alert").first()).not.toContainText(
    pseudo["error." + bad.errorData.code],
  );
  checks.push("relocation-clears-stale-cause-without-changing-phase-rules");
  const layouts = [];
  for (const width of [1360, 650]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 1000),
      width,
    );
    const layout = await engine().evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
      height: el.getBoundingClientRect().height,
    }));
    assert.ok(layout.scroll <= layout.client + 1);
    layouts.push({ width, ...layout });
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    fs.writeFileSync(
      path.join(dir, `engine-long-${width}.png`),
      Buffer.from(png, "base64"),
    );
  }
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks,
        layouts,
        calls: await calls(),
        initialNotice: initial.noticeData,
        checksumError: bad.errorData,
      },
      null,
      2,
    ),
  );
  console.log("Engine locale and tool state workflow PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        calls: await app.evaluate(() => global.engineCalls),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
