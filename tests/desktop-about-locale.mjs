// Actual App + LocaleRoot with test-only registry and update-server adapters.
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
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/about-app-locale-")),
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
    name: "mmd-encoder",
    version: require("../package.json").version,
    main: "main.cjs",
  }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `
const {createRequire}=require('node:module');const native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});
const service=native('../backend/service.cjs'),create=service.createService;service.createService=options=>create({...options,localeRegistry:${JSON.stringify(registry)}});
const updates=native('../backend/update.cjs');global.testUpdate={current:'1.6.1',latest:'1.6.1',newer:false,url:updates.RELEASES_URL};updates.checkForUpdate=async()=>global.testUpdate;
const {ipcMain}=native('electron'),handle=ipcMain.handle.bind(ipcMain);global.testCalls={};ipcMain.handle=(channel,listener)=>handle(channel,(event,action,...args)=>{global.testCalls[action]=(global.testCalls[action]||0)+1;return listener(event,action,...args);});
native('./main.cjs');
`,
);
const launch = () =>
  electron.launch({
    executablePath: require("electron"),
    args: [dir],
    env: {
      ...process.env,
      MMD_ENCODER_TEST: "1",
      MMD_ENCODER_DATA: path.join(dir, "data"),
      MMD_ENCODER_TOOLS_ROOT: path.join(dir, "no-encoding-tools"),
    },
    timeout: 60000,
  });
let app = await launch();
async function dismissSetup(page, title = "编码引擎") {
  const setup = page.getByRole("dialog", { name: title, exact: true });
  await expect(setup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(setup).toBeHidden();
}
try {
  const page = await app.firstWindow();
  await dismissSetup(page);
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.showInactive();
      w.setSize(1360, 1000);
      await w.loadFile(file);
    },
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  const opener = page.getByRole("button", {
    name: "关于与语言 · Language",
    exact: true,
  });
  await dismissSetup(page);
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(
    page.getByRole("dialog", { name: "关于", exact: true }),
  ).toBeVisible();
  const before = await app.evaluate(() => global.testCalls.aboutInfo || 0);
  const language = page.getByRole("combobox", {
    name: "界面语言 · Language",
    exact: true,
  });
  await expect(language).toHaveValue("system");
  assert.deepEqual(await language.locator("option").allTextContents(), [
    "跟随系统（简体中文）",
    "简体中文",
    "Test English",
  ]);
  await page.evaluate(() => {
    window.aboutNode = document.querySelector('[role="dialog"]');
  });
  await language.selectOption("en-XA");
  const pseudo = await page.evaluate(() => window.appAboutFixture.pseudo);
  await expect(
    page.getByRole("dialog", { name: pseudo["about.title"], exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: pseudo["about.open"] + " · Language",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  assert.equal(
    await page.evaluate(
      () => window.aboutNode === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  assert.equal(
    await app.evaluate(() => global.testCalls.aboutInfo || 0),
    before,
  );
  const changed = page.getByRole("combobox", {
    name: pseudo["about.language"] + " · Language",
    exact: true,
  });
  await expect(changed).toHaveValue("en-XA");
  const state = await page.evaluate(() => window.encoder.invokeResult("state"));
  assert.equal(state.preferences.locale, "en-XA");
  assert.equal(state.systemLocale, "zh-CN");
  assert.deepEqual(
    (await changed.locator("option").allTextContents()).slice(1),
    ["简体中文", "Test English"],
  );
  await changed.selectOption("system");
  await expect(
    page.getByRole("dialog", { name: "关于", exact: true }),
  ).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.encoder.invokeResult("state")))
      .preferences.locale,
    null,
  );
  await page
    .getByRole("combobox", { name: "界面语言 · Language", exact: true })
    .selectOption("en-XA");
  await expect(
    page.getByRole("dialog", { name: pseudo["about.title"], exact: true }),
  ).toBeVisible();
  // A real settings-store failure must keep the selected locale and show a
  // localized error. These files belong only to this fixture's data directory.
  const settings = path.join(dir, "data/settings.json"),
    held = settings + ".held";
  assert.equal(path.dirname(settings), path.join(dir, "data"));
  fs.renameSync(settings, held);
  fs.mkdirSync(settings);
  try {
    await page
      .getByRole("combobox", {
        name: pseudo["about.language"] + " · Language",
        exact: true,
      })
      .selectOption("zh-CN");
    await expect(page.getByRole("alert")).toContainText(
      pseudo["about.languageFailed"].split("{detail}")[0],
    );
    await expect(
      page.getByRole("combobox", {
        name: pseudo["about.language"] + " · Language",
        exact: true,
      }),
    ).toHaveValue("en-XA");
    assert.equal(
      (await page.evaluate(() => window.encoder.invokeResult("state")))
        .preferences.locale,
      "en-XA",
    );
  } finally {
    fs.rmdirSync(settings);
    fs.renameSync(held, settings);
  }
  await page
    .getByRole("combobox", {
      name: pseudo["about.language"] + " · Language",
      exact: true,
    })
    .selectOption("zh-CN");
  await page
    .getByRole("combobox", { name: "界面语言 · Language", exact: true })
    .selectOption("en-XA");
  await expect(
    page.getByRole("dialog", { name: pseudo["about.title"], exact: true }),
  ).toBeVisible();
  const layouts = [];
  await app.evaluate(() => {
    global.testUpdate = {
      current: "1.6.1",
      latest: "9.9.0",
      newer: true,
      url: "https://github.com/CicloO/MMDEncoder/releases/tag/v9.9.0",
      assets: { size: 4096 },
    };
  });
  const checked = await page.evaluate(() =>
    window.encoder.invokeResult("checkAppUpdate"),
  );
  assert.equal(checked.canInstall, false);
  assert.equal(checked.installBlockedData.code, "UPDATE_NOT_PORTABLE");
  await page
    .getByRole("button", { name: pseudo["about.check"], exact: true })
    .click();
  await expect(
    page.getByText(pseudo["error.UPDATE_NOT_PORTABLE"], { exact: true }),
  ).toBeVisible();
  await changed.selectOption("zh-CN");
  await expect(
    page.getByText(checked.installBlocked, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "界面语言 · Language", exact: true })
    .selectOption("en-XA");
  for (const width of [1360, 650]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 1000),
      width,
    );
    const rect = await page
      .getByRole("dialog", { name: pseudo["about.title"], exact: true })
      .boundingBox();
    const png = await app.evaluate(
      async ({ BrowserWindow }, rect) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect))
          .toPNG()
          .toString("base64"),
      Object.fromEntries(
        Object.entries(rect).map(([key, value]) => [key, Math.round(value)]),
      ),
    );
    fs.writeFileSync(
      path.join(dir, `language-expanded-${width}.png`),
      Buffer.from(png, "base64"),
    );
    assert.ok(rect.height <= 1000 && rect.width <= width);
    const layout = await page
      .getByRole("dialog", { name: pseudo["about.title"], exact: true })
      .evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        title: getComputedStyle(el.querySelector(".about-language-label"))
          .fontSize,
        support: getComputedStyle(el.querySelector("section:last-child h3"))
          .fontSize,
        titleWeight: getComputedStyle(el.querySelector(".about-language-label"))
          .fontWeight,
        supportWeight: getComputedStyle(
          el.querySelector("section:last-child h3"),
        ).fontWeight,
      }));
    assert.ok(layout.scroll <= layout.client + 1);
    assert.equal(layout.title, layout.support);
    assert.equal(layout.titleWeight, layout.supportWeight);
    layouts.push({ width, rect, ...layout });
  }
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .setLegacyMode()
    .analyze();
  assert.deepEqual(axe.violations, []);
  await app.close();
  app = await launch();
  const restarted = await app.firstWindow();
  await dismissSetup(restarted);
  await restarted.getByRole("heading", { name: "视频队列" }).waitFor();
  await app.evaluate(
    async ({ BrowserWindow }, file) =>
      BrowserWindow.getAllWindows()[0].loadFile(file),
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await expect(restarted.locator("html")).toHaveAttribute("lang", "en-XA");
  await dismissSetup(restarted, pseudo["engine.title"]);
  await expect(
    restarted.getByRole("button", {
      name: pseudo["about.open"] + " · Language",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    (await restarted.evaluate(() => window.encoder.invokeResult("state")))
      .preferences.locale,
    "en-XA",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        registry,
        layouts,
        testOnly: true,
        aboutQueries: before,
        checks: [
          "app-and-dialog-refresh",
          "literal-Language-marker",
          "dialog-not-remounted",
          "no-repeated-about-query",
          "preference-survives-restart",
          "native-language-names",
          "system-selection-uses-policy-resolution",
          "failed-save-preserves-locale",
          "language-section-at-two-formal-locales",
          "actual-update-IPC-keeps-install-block-descriptor",
          "update-block-refreshes-without-another-check",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Actual App about locale and persistence PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure-state.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        calls: await app.evaluate(() => global.testCalls),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
