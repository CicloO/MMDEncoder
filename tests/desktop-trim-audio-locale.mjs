// Real alignment workers in the existing trim fixture; input/drop and locale
// changes are controlled here, while native exports live in desktop-align.
import { _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(
  path.join(root, "verification/i18n/trim-audio-locale-"),
);
const outDir = path.join(dir, "fixture-dist");
const { ff } = require("./engines.cjs");
const song = path.join(dir, "User 原曲.wav");
const other = path.join(
  dir,
  "User 新的很长音频文件名_" + "long_audio_".repeat(8) + ".wav",
);
const video = path.join(dir, "User reference.mp4");
const run = (args) => execFileSync(ff, ["-v", "error", ...args]);
run([
  "-f",
  "lavfi",
  "-i",
  "anoisesrc=d=12:c=pink:r=24000:seed=31,tremolo=f=1.7:d=0.9",
  "-c:a",
  "pcm_s16le",
  song,
]);
fs.copyFileSync(song, other);
run([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=160x90:r=30000/1001",
  "-ss",
  "1.25",
  "-i",
  song,
  "-frames:v",
  "180",
  "-c:v",
  "libx264",
  "-g",
  "1",
  "-c:a",
  "aac",
  "-shortest",
  video,
]);
await build({
  root,
  base: "./",
  build: {
    outDir,
    rollupOptions: { input: path.join(root, "tests/fixtures/i18n/align.html") },
  },
});
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
const capture = async (file) => {
  const data = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  assert.ok(data.length > 100);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
};
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await app.evaluate(
    async ({ BrowserWindow }, file) =>
      BrowserWindow.getAllWindows()[0].loadFile(file),
    path.join(outDir, "tests/fixtures/i18n/align.html"),
  );
  await page
    .getByRole("button", { name: "Alignment fixture focus target" })
    .waitFor();
  await page.evaluate(() => window.alignLocale.showTrim());
  await expect(page.locator(".trim-preview img")).toBeVisible();
  await page.evaluate(() => {
    window.trimAudioMotion = [];
    new MutationObserver(() => {
      for (const node of document.querySelectorAll(
        ".settings-column .alignment-wave.active",
      ))
        window.trimAudioMotion.push(
          getComputedStyle(node.querySelector("path")).animationName,
        );
    }).observe(document.getElementById("root"), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-busy"],
    });
    window.alignLocale.setTrimClips([]);
  });
  await expect(page.locator(".trim-preview img")).toHaveCount(0);
  await page.evaluate((song) => window.alignLocale.dropTrimFiles([song]), song);
  const button = page.locator(".settings-column button[aria-busy]");
  await expect(button).toBeDisabled();
  await expect(page.locator(".file-pick .path-text")).toHaveAttribute(
    "title",
    song,
  );
  assert.equal(
    await page.evaluate(() =>
      window.alignLocale
        .trimSnapshot()
        .calls.some((call) => call.action === "trimAdd"),
    ),
    false,
    "dropped audio is not added as a video clip",
  );
  const clip = {
    id: "actual",
    path: video,
    name: "User reference.mp4",
    status: "ready",
    codec: "h264",
    fps: { num: 30000, den: 1001 },
    frames: 180,
    from: 17,
    to: 65,
    cuts: "all",
    width: 160,
    height: 90,
  };
  await page.evaluate((clip) => window.alignLocale.setTrimClips([clip]), clip);
  await expect
    .poll(() => page.evaluate(() => window.trimAudioMotion.length))
    .toBeGreaterThan(0);
  await expect(button).toHaveAttribute("aria-busy", "false", {
    timeout: 60000,
  });
  assert.ok(
    (await page.evaluate(() => window.trimAudioMotion)).some(
      (name) => name !== "none",
    ),
  );
  await button.click();
  const dialog = page.getByRole("dialog");
  const frames = page.locator("#align-audio-shift");
  await expect(frames).toBeEnabled();
  await expect(frames).toHaveAttribute("title", "30000/1001");
  await expect(dialog.getByText(/目标开头多出 1\.25\d\d 秒/)).toBeVisible();
  await frames.fill("4");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(0, 0);
    w.setSize(1360, 1000);
    w.showInactive();
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const layout = await dialog.evaluate((node) => {
    const step = node.querySelector("#align-step"),
      shift = node.querySelector("#align-audio-shift");
    const row = step.closest(".align-row"),
      zoom = row.querySelector("button");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      sameRow: shift.closest(".align-row") === row,
      step: box(step),
      shift: box(shift),
      zoom: box(zoom),
      labelFont: getComputedStyle(
        node.querySelector('label[for="align-audio-shift"]'),
      ).font,
      nudgeFont: getComputedStyle(node.querySelector('label[for="align-step"]'))
        .font,
    };
  });
  assert.equal(layout.sameRow, true);
  assert.equal(layout.labelFont, layout.nudgeFont);
  assert.ok(Math.abs(layout.shift.y - layout.step.y) <= 1);
  assert.ok(Math.abs(layout.shift.height - layout.step.height) <= 1);
  assert.ok(Math.abs(layout.shift.height - layout.zoom.height) <= 1);
  assert.ok(layout.shift.width <= 120);
  fs.writeFileSync(
    path.join(dir, "inline-layout.json"),
    JSON.stringify(layout, null, 2),
  );
  await capture(path.join(dir, "inline-zh-1360.png"));
  const before = await page.evaluate(() => window.alignLocale.trimSnapshot());
  for (const locale of ["en-XA", "en-XB", "unsupported", "zh-CN"]) {
    await page.evaluate((locale) => window.alignLocale.choose(locale), locale);
    await expect(frames).toHaveValue("4");
    await expect(frames).toHaveAttribute("title", "30000/1001");
    await expect(page.locator("#trim-audio")).toHaveValue("replace");
    await expect(page.locator(".file-pick .path-text")).toHaveAttribute(
      "title",
      song,
    );
    assert.deepEqual(
      await page.evaluate(() => window.alignLocale.trimSnapshot()),
      before,
      "locale preserves the page and does not repeat preview requests",
    );
  }
  for (const width of [1360, 700]) {
    await page.evaluate(() => window.alignLocale.choose("en-XA"));
    await app.evaluate(({ BrowserWindow }, width) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setMinimumSize(0, 0);
      w.setSize(width, 1000);
    }, width);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const measure = await dialog.evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
      input: node
        .querySelector("#align-audio-shift")
        .getBoundingClientRect()
        .toJSON(),
    }));
    assert.ok(
      measure.scroll <= measure.width,
      JSON.stringify({ width, measure }),
    );
    assert.ok(measure.input.width <= 120);
    await capture(path.join(dir, `expanded-${width}.png`));
  }
  await page.evaluate(() => window.alignLocale.choose("zh-CN"));
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motionCount = await page.evaluate(() => window.trimAudioMotion.length);
  await page.evaluate(
    (file) => window.alignLocale.dropTrimFiles([file]),
    other,
  );
  await expect
    .poll(() => page.evaluate(() => window.trimAudioMotion.length))
    .toBeGreaterThan(motionCount);
  await expect(button).toHaveAttribute("aria-busy", "false", {
    timeout: 60000,
  });
  assert.ok(
    (await page.evaluate(() => window.trimAudioMotion))
      .slice(motionCount)
      .every((name) => name === "none"),
  );
  await expect(page.locator(".file-pick .path-text")).toHaveAttribute(
    "title",
    other,
  );
  await button.click();
  await expect(frames).toBeEnabled();
  await expect(frames).toHaveValue("0");
  await expect(dialog.getByText(/目标开头多出 1\.25\d\d 秒/)).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await capture(path.join(dir, "audio-settings-700.png"));
  console.log(
    "Trim drop before reference, deferred automatic match, new audio reset, reduced motion and locale preservation PASS",
    dir,
  );
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure-error.txt"),
    String(error.stack || error),
  );
  try {
    await capture(path.join(dir, "failure.png"));
  } catch {}
  throw error;
} finally {
  await app.close();
}
