// Real tagged x264, untagged H.264 and NVEncC sources share free preview
// navigation; only the recorded supported encoder gets arbitrary cut points.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/trim-smart-"));
const { ff, fp, nv, runCommand } = require("./engines.cjs");
const core = require("../backend/core.cjs");
const source = path.join(dir, "Untagged H264.mp4");
execFileSync(ff, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=320x180:r=30:d=4",
  "-c:v",
  "libx264",
  "-g",
  "30",
  "-keyint_min",
  "30",
  "-sc_threshold",
  "0",
  source,
]);
const meta = core.metadata(
  JSON.parse(
    execFileSync(
      fp,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", source],
      { encoding: "utf8" },
    ),
  ),
);
const sources = [{ file: source, smart: false, encoder: null }];
for (const encoder of ["libx264", "nvencc:h264"]) {
  const output = path.join(dir, encoder.replace(":", "-") + ".mp4");
  const settings = {
    ...core.DEFAULTS,
    encoder,
    preset: encoder.startsWith("nvencc") ? "p4" : "medium",
    container: "mp4",
    audio: "none",
    editFriendly: true,
  };
  for (const command of core.buildCommands(
    { path: source, meta },
    settings,
    { ffmpeg: ff, ffprobe: fp, nvencc: nv },
    { output },
  ))
    runCommand(command);
  sources.push({ file: output, smart: encoder === "libx264", encoder });
}
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
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1360, 1000);
    w.showInactive();
  });
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await page.getByRole("button", { name: "无损剪辑", exact: true }).click();
  await page.evaluate(
    (paths) => window.encoder.invoke("trimAdd", { paths }),
    sources.map((s) => s.file),
  );
  const state = () =>
    page.evaluate(async () => (await window.encoder.invoke("state")).trim);
  await expect
    .poll(async () => {
      const t = await state();
      return t.clips.length === 3 && t.clips.every((c) => c.status === "ready");
    })
    .toBe(true);
  const slider = page.getByRole("slider", { name: "当前帧" });
  const smart = async (value) => {
    await page.evaluate(
      (smart) => window.encoder.invoke("trimSmart", { smart }),
      value,
    );
    await expect.poll(async () => (await state()).smart).toBe(value);
    await expect(page.getByRole("checkbox", { name: /^智能剪切/ })).toBeChecked(
      { checked: value },
    );
  };
  async function drag(frame) {
    await slider.scrollIntoViewIfNeeded();
    const b = await slider.boundingBox();
    const x = b.x + 8 + ((b.width - 16) * frame) / 119,
      y = b.y + b.height / 2;
    await page.mouse.move(b.x + 8, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.up();
  }
  const results = [];
  for (const source of sources) {
    await page
      .locator(".job-select")
      .filter({ hasText: path.basename(source.file) })
      .click();
    await expect(page.locator(".trim-editor h3")).toHaveAttribute(
      "title",
      source.file,
    );
    const clip = (await state()).clips.find((c) => c.path === source.file);
    assert.equal(clip.encoding?.encoder ?? null, source.encoder);
    assert.equal(!clip.smartBlocker, source.smart);
    assert.deepEqual(clip.cuts, [0, 30, 60, 90]);
    await smart(true);
    await drag(42);
    await expect(slider).toHaveValue("42");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue("43");
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveValue("42");
    if (source.smart)
      await expect(page.locator("#trim-cut-landing")).toHaveCount(0);
    else
      await expect(page.locator("#trim-cut-landing")).toHaveText(
        "入点将落在第 30 帧；出点将落在第 30 帧（不包含该帧）。",
      );
    await page.getByRole("button", { name: "设为入点", exact: true }).click();
    await expect
      .poll(
        async () => (await state()).clips.find((c) => c.id === clip.id).from,
      )
      .toBe(source.smart ? 42 : 30);
    await expect(slider).toHaveValue("42");
    await drag(76);
    await expect(slider).toHaveValue("76");
    await page.getByRole("button", { name: "设为出点", exact: true }).click();
    await expect
      .poll(async () => (await state()).clips.find((c) => c.id === clip.id).to)
      .toBe(source.smart ? 76 : 90);
    const range = (await state()).clips.find((c) => c.id === clip.id);
    await smart(false);
    await drag(42);
    await expect(slider).toHaveValue("30");
    await expect(page.locator("#trim-cut-landing")).toHaveCount(0);
    // Preserve the established explicit frame-step shortcuts with smart off.
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue("31");
    await page.keyboard.press("ArrowUp");
    await expect(slider).toHaveValue("30");
    await smart(true);
    await drag(45);
    await expect(slider).toHaveValue("45");
    if (!source.smart)
      await expect(page.locator("#trim-cut-landing")).toContainText("第 30 帧");
    await drag(119);
    await expect(slider).toHaveValue("119");
    if (!source.smart)
      await expect(page.locator("#trim-cut-landing")).toHaveText(
        "入点将落在第 90 帧；出点将落在结尾。",
      );
    results.push({
      encoder: source.encoder,
      blocked: clip.smartBlocker,
      from: range.from,
      to: range.to,
    });
  }
  const geometry = [];
  for (const forcedColors of ["none", "active"]) {
    await page.emulateMedia({ forcedColors });
    for (const frame of [0, 119]) {
      await drag(frame);
      await expect(slider).toHaveValue(String(frame));
      const g = await slider.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const center = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return r.y + r.height / 2;
        };
        return {
          height: box.height,
          minHeight: getComputedStyle(el).minHeight,
          center: box.y + box.height / 2,
          rail: center(".trim-rail"),
          range: center(".trim-range"),
          tick: center(".trim-tick"),
          forced: matchMedia("(forced-colors:active)").matches,
          markAdjustment: getComputedStyle(
            document.querySelector(".trim-marks"),
          ).forcedColorAdjust,
          railColor: getComputedStyle(document.querySelector(".trim-rail"))
            .backgroundColor,
          textColor: getComputedStyle(
            document.querySelector(".trim-position strong"),
          ).color,
        };
      });
      assert.equal(g.height, 28);
      assert.equal(g.minHeight, "0px");
      for (const key of ["rail", "range", "tick"])
        assert.ok(Math.abs(g.center - g[key]) < 0.1);
      assert.equal(g.forced, forcedColors === "active");
      if (g.forced) {
        assert.equal(g.markAdjustment, "none");
        assert.equal(g.railColor, g.textColor);
      }
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString("base64"),
      );
      fs.writeFileSync(
        path.join(dir, `${forcedColors}-${frame}.png`),
        Buffer.from(png, "base64"),
      );
      geometry.push({ forcedColors, frame, ...g });
    }
  }
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ results, geometry }, null, 2),
  );
  console.log(
    "Smart preview, real encoder cut points and slider geometry PASS",
    dir,
  );
} catch (error) {
  fs.writeFileSync(path.join(dir, "failure.txt"), String(error.stack || error));
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure-state.json"),
    JSON.stringify(await stateForFailure(page), null, 2),
  );
  throw error;
} finally {
  await app.close();
}
async function stateForFailure(page) {
  return page.evaluate(async () => ({
    trim: (await window.encoder.invoke("state")).trim,
    text: document.body.innerText,
  }));
}
