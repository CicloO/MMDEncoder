// Trim page slider: cut-point ticks line up with where the thumb lands, the
// thumb reaches the first and last frame, and without smart cut the slider
// snaps to cut points (arrow keys jump between them).
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.resolve(root, "verification");
const work = path.resolve(root, "verification/work");
fs.mkdirSync(work, { recursive: true });
const testDir = fs.mkdtempSync(path.join(work, "trim-ui-"));
// 4 s at 30 fps, an IDR every 30 frames: cut points 0, 30, 60, 90.
const input = path.join(testDir, "剪辑 测试.mp4");
execFileSync(require("./engines.cjs").ff, [
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
  input,
]);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(testDir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1280, 900);
    w.showInactive();
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.encoder.invoke("state")).located,
        ),
      { timeout: 60000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "无损剪辑", exact: true }).click();
  await page.evaluate(
    (p) => window.encoder.invoke("trimAdd", { paths: [p] }),
    input,
  );
  const slider = page.getByRole("slider", { name: "当前帧" });
  await expect(slider).toBeVisible();
  await expect(page.locator(".trim-tick")).toHaveCount(4);
  await slider.scrollIntoViewIfNeeded();
  const value = async () => Number(await slider.inputValue());
  const box = await slider.boundingBox();
  const y = box.y + box.height / 2;

  // Drag past either end: the thumb reaches frame 0 and the last cut point
  // (snapping is on: smart cut is off by default).
  await page.mouse.click(box.x + 1, y);
  assert.equal(await value(), 0, "left end");
  await page.mouse.click(box.x + box.width - 1, y);
  assert.equal(await value(), 90, "right end snaps to the last cut point");

  // Each tick sits where clicking puts the thumb on that frame.
  for (const tick of await page.locator(".trim-tick").all()) {
    const t = await tick.boundingBox();
    await page.mouse.click(t.x + t.width / 2, y);
    const v = await value();
    assert.ok([0, 30, 60, 90].includes(v), "snapped to a cut point: " + v);
  }
  const ticks = await page
    .locator(".trim-tick")
    .evaluateAll((els) =>
      els.map(
        (e) =>
          e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2,
      ),
    );
  for (const [i, frame] of [0, 30, 60, 90].entries()) {
    await page.mouse.click(ticks[i], y);
    assert.equal(await value(), frame, `tick ${i} is frame ${frame}`);
  }
  // Between ticks: the nearest cut point.
  await page.mouse.click(ticks[1] + (ticks[2] - ticks[1]) * 0.3, y);
  assert.equal(await value(), 30);
  // On the slider: ↓/↑ next / previous cut point, →/← one frame.
  await slider.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(value).toBe(60);
  await page.keyboard.press("ArrowUp");
  await expect.poll(value).toBe(30);
  await page.keyboard.press("ArrowRight");
  await expect.poll(value).toBe(31);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(value).toBe(30);

  // Smart cut on, but this file has no recorded encode settings (not made
  // by MMDEncoder), so it cannot be smart-cut: the slider keeps snapping.
  await page.evaluate(() =>
    window.encoder.invoke("trimSmart", { smart: true }),
  );
  await page.mouse.click(ticks[1] + (ticks[2] - ticks[1]) * 0.4, y);
  assert.equal(await value(), 30, "still snaps when smart cut cannot be used");

  await page.screenshot({ path: path.join(evidence, "trim-slider.png") });
  console.log("Desktop trim PASS");
  passed = true;
} finally {
  await app.close();
  if (passed) fs.rmSync(testDir, { recursive: true, force: true });
}
