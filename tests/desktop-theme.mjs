import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { _electron as electron, expect } from "@playwright/test";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/theme-")),
  data = path.join(dir, "data");
const source = require("../locales/zh-CN.json"),
  colors = require("../desktop/theme-colors.json");
const { createService } = require("../backend/service.cjs");
const seed = createService({ dataDir: data });
await seed.invoke("setTheme", { theme: "dark" });
seed.dispose();
const fixture = path.join(dir, "package.json"),
  main = path.join(dir, "main.cjs");
fs.writeFileSync(fixture, JSON.stringify({ main: "main.cjs" }));
// Hold only the renderer entry on the first launch so the parsed document and
// first background can be inspected before React receives asynchronous state.
fs.writeFileSync(
  main,
  `const {app,session}=require('electron');let pending=[];global.releaseThemeEntry=()=>{for(const cb of pending)cb({});pending=[];session.defaultSession.webRequest.onBeforeRequest(null);};app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['file://*/*']},(details,cb)=>/\\/dist\\/assets\\/[^/]+\\.js$/.test(details.url)?pending.push(cb):cb({}));setTimeout(()=>global.releaseThemeEntry(),10000).unref();});require(${JSON.stringify(path.join(root, "desktop/main.cjs"))});`,
);
const env = {
  ...process.env,
  MMD_ENCODER_TEST: "1",
  MMD_ENCODER_DATA: data,
  MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
};
let app;
const checks = [];
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [dir],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const early = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    initial: window.encoder.initialTheme,
    hasApp: !!document.querySelector(".app-shell"),
  }));
  assert.equal(early.initial, "dark");
  assert.equal(early.hasApp, false);
  const darkCss =
    "rgb(" +
    colors.dark.background
      .slice(1)
      .match(/../g)
      .map((value) => parseInt(value, 16))
      .join(", ") +
    ")";
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    )
    .toBe(darkCss);
  assert.equal(
    (
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBackgroundColor(),
      )
    ).toLowerCase(),
    colors.dark.background,
  );
  await app.evaluate(() => globalThis.releaseThemeEntry());
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  checks.push("saved-dark-window-and-parsed-html-before-react");
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  const choose = async (theme) => {
    for (let n = 0; n < 3 && (await state()).preferences.theme !== theme; n++) {
      const current = (await state()).preferences.theme;
      const next = current === "light" ? "dark" : "light";
      await page.locator(".theme-toggle").click();
      await expect
        .poll(async () => (await state()).preferences.theme)
        .toBe(next);
      const after = next === "light" ? "dark" : "light";
      await expect(page.locator(".theme-toggle")).toHaveAccessibleName(
        source["app.theme.switch"]
          .replace("{current}", source["app.theme." + next + "Name"])
          .replace("{next}", source["app.theme." + after + "Name"]),
      );
    }
    await expect
      .poll(async () => (await state()).preferences.theme)
      .toBe(theme);
  };
  await choose("dark");
  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = "light"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  checks.push("two-theme-mode-does-not-follow-system");
  await choose("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = "dark"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  assert.equal(
    (
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBackgroundColor(),
      )
    ).toLowerCase(),
    colors.light.background,
  );
  await page.evaluate(() => localStorage.setItem("mmd-color-theme", "dark"));
  await page.reload();
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".theme-toggle")).toHaveAccessibleName(
    source["app.theme.switch"]
      .replace("{current}", source["app.theme.lightName"])
      .replace("{next}", source["app.theme.darkName"]),
  );
  checks.push("explicit-light-persists-and-old-local-storage-is-ignored");
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [root],
    env,
    timeout: 60000,
  });
  const reopened = await app.firstWindow();
  await reopened.getByRole("heading", { name: "视频队列" }).waitFor();
  await expect(reopened.locator("html")).toHaveAttribute("data-theme", "light");
  assert.equal(
    await reopened.evaluate(
      async () => (await window.encoder.invoke("state")).preferences.theme,
    ),
    "light",
  );
  checks.push("theme-survives-process-restart");
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ passed: true, checks, early }, null, 2),
  );
  console.log("Desktop theme PASS", dir);
} finally {
  if (app) await app.close();
}
