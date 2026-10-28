// Actual App + service. Only native drag file-path extraction is substituted.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(
  path.join(root, "verification/i18n/audio-workflow-"),
);
const data = path.join(dir, "data");
const video = path.join(dir, "User video.mp4");
const otherVideo = path.join(dir, "User other.mp4");
const audios = ["User first.wav", "User second.wav"].map((n) =>
  path.join(dir, n),
);
const { ff } = require("./engines.cjs");
execFileSync(ff, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=160x90:d=2:r=30",
  "-f",
  "lavfi",
  "-i",
  "anoisesrc=d=2:r=24000:seed=5",
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  video,
]);
fs.copyFileSync(video, otherVideo);
for (const [i, file] of audios.entries())
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=3:r=24000:seed=${5 + i}`,
    file,
  ]);
const outDir = path.join(dir, "fixture-dist");
await build({
  root,
  base: "./",
  define: { "window.encoder": "window.workflowEncoder" },
  plugins: [
    {
      name: "native-drag-fixture",
      transform(code, id) {
        if (!id.endsWith("/tests/fixtures/i18n/AppFixture.tsx")) return;
        return `const bridge=Reflect.get(window,"encoder"); window.workflowEncoder={...bridge,getPaths:()=>window.workflowDropPaths||[]};\n${code}`;
      },
    },
  ],
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/app.html") },
  },
});
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({
    main: "main.cjs",
    version: require("../package.json").version,
  }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `const m=require(${JSON.stringify(path.join(root, "backend/align-service.cjs"))});const create=m.createAlignService;global.workflowCounts={alignRun:0,alignPreview:0};m.createAlignService=(o)=>{const s=create(o);for(const key of Object.keys(global.workflowCounts)){const q=s.queries[key];s.queries[key]=(...a)=>{global.workflowCounts[key]++;return q(...a)}}return s};require(${JSON.stringify(path.join(root, "desktop/main.cjs"))});`,
);
const env = {
  ...process.env,
  MMD_ENCODER_DATA: data,
  MMD_ENCODER_TEST: "1",
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  const screenshot = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const bytes = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    fs.writeFileSync(path.join(dir, name), Buffer.from(bytes, "base64"));
  };
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  await expect
    .poll(
      async () => {
        const s = await state();
        return s.located && !s.detecting;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await app.evaluate(
    async ({ BrowserWindow }, file) =>
      BrowserWindow.getAllWindows()[0].loadFile(file),
    path.join(outDir, "tests/fixtures/i18n/app.html"),
  );
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await page.locator(".about-button").click();
  const preference = page.getByRole("checkbox", {
    name: "自动对齐音频",
    exact: true,
  });
  await expect(preference).toBeChecked();
  await preference.click();
  await expect
    .poll(async () => (await state()).preferences.autoAlignAudio)
    .toBe(false);
  await expect(preference).not.toBeChecked();
  assert.deepEqual(
    (
      await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
    [],
  );
  await screenshot("about-setting.png");
  await page.keyboard.press("Escape");
  checks.push("about-preference-saved-through-real-ipc");
  const drop = async (paths) => {
    await page.evaluate((paths) => {
      window.workflowDropPaths = paths;
      const transfer = new DataTransfer();
      for (const name of paths)
        transfer.items.add(
          new File(["drag fixture"], name.split(/[\\/]/).pop()),
        );
      document.querySelector(".app-shell").dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    }, paths);
  };
  for (const mode of ["encode", "media"]) {
    if (mode === "media") {
      await page
        .getByRole("button", { name: "音视频提取与合并", exact: true })
        .click();
      await page.getByLabel("操作", { exact: true }).selectOption("merge");
    }
    const jobs = async () =>
      (await state())[mode === "encode" ? "jobs" : "mediaJobs"];
    await drop([video]);
    await expect
      .poll(async () => {
        const j = (await jobs())[0];
        return !!j?.meta;
      })
      .toBe(true);
    // Queue selection is a real click; each subsequent audio drop reuses it.
    await page.locator(".job-select:visible").first().click();
    for (const file of audios) {
      await drop([file]);
      await expect.poll(async () => (await jobs())[0]?.audioPath).toBe(file);
    }
    assert.equal((await jobs())[0].audioOffset, undefined);
    assert.equal(
      (await app.evaluate(() => globalThis.workflowCounts)).alignRun,
      0,
    );
    const replace = page.getByRole("button", {
      name: "音频替换：User video.mp4",
      exact: true,
    });
    const align = page
      .getByRole("button", {
        name: /^对齐.*User video\.mp4/,
      })
      .filter({ visible: true });
    await expect(replace).toHaveClass(/active/);
    await expect(align).not.toHaveClass(/\bactive\b/);
    const weight = await align.locator("svg").evaluate((icon) => {
      const path = icon.querySelector("path");
      const before = getComputedStyle(path).strokeWidth;
      icon.classList.add("active");
      const during = getComputedStyle(path).strokeWidth;
      icon.classList.remove("active");
      return { before, during, effect: getComputedStyle(path).vectorEffect };
    });
    assert.equal(weight.before, weight.during);
    assert.equal(weight.effect, "non-scaling-stroke");
    await expect(page.locator(".replace-audio:visible")).toHaveCount(0);
    await align.click();
    const apply = page.getByRole("button", { name: "应用", exact: true });
    await expect(apply).toBeEnabled({ timeout: 30000 });
    assert.equal(
      (await app.evaluate(() => globalThis.workflowCounts)).alignRun,
      0,
      "opening never matches automatically",
    );
    await page
      .getByRole("spinbutton", { name: "音频偏移（帧）", exact: true })
      .fill("3");
    await apply.click();
    await expect.poll(async () => (await jobs())[0].audioShiftFrames).toBe(3);
    await expect(align).toHaveClass(/\bactive\b/);
    await align.click({ button: "right" });
    await expect
      .poll(async () => (await jobs())[0].audioOffset)
      .toBeUndefined();
    assert.equal((await jobs())[0].audioPath, audios[1]);
    await replace.focus();
    await page.keyboard.press("Shift+F10");
    await expect.poll(async () => (await jobs())[0].audioPath || "").toBe("");
    await expect(replace).not.toHaveClass(/\bactive\b/);
    await drop([otherVideo]);
    await expect
      .poll(async () => (await jobs()).filter((job) => job.meta).length)
      .toBe(2);
    await drop(audios);
    await expect
      .poll(async () => (await jobs()).map((job) => job.audioPath))
      .toEqual(audios);
    checks.push(
      `${mode}-second-drop-replaces-selection-blue-applied-no-open-match-context-and-keyboard-clear`,
    );
    await screenshot(`${mode}-queue.png`);
  }
  await page.reload();
  await page.locator(".about-button").click();
  await expect(
    page.getByRole("checkbox", { name: "自动对齐音频", exact: true }),
  ).not.toBeChecked();
  checks.push("about-preference-survives-renderer-reload");
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [root],
    env,
    timeout: 60000,
  });
  const restarted = await app.firstWindow();
  await restarted.getByRole("heading", { name: "视频队列" }).waitFor();
  assert.equal(
    await restarted.evaluate(
      async () =>
        (await window.encoder.invoke("state")).preferences.autoAlignAudio,
    ),
    false,
  );
  checks.push("about-preference-survives-process-restart");
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log("Audio workflow PASS", dir);
} finally {
  if (app) await app.close();
}
