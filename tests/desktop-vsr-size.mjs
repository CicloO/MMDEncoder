// VSR 倍率's 跟随分辨率 / 最大 buttons: exclusive toggles, a read-only box
// showing the scale worked out for the selected file, and back to typed.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const { ff } = require("./engines.cjs");
const source = require("../locales/zh-CN.json");
const root = path.resolve(import.meta.dirname, "..");
const work = path.resolve(root, "verification/work");
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(work, "vsr-size-"));
const input = path.join(data, "wide.mkv");
execFileSync(
  ff,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=2848x1602:r=30:d=0.2",
    "-c:v",
    "ffv1",
    input,
  ],
  { windowsHide: true },
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: data,
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
    w.setSize(1360, 1100);
    w.showInactive();
  });
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await page.evaluate(
    (input) => window.encoder.invoke("add", { paths: [input] }),
    input,
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.encoder.invoke("state")).jobs[0]?.meta?.width,
      ),
    )
    .toBe(2848);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = await window.encoder.invoke("state");
          return s.located && !s.detecting;
        }),
      { timeout: 90000 },
    )
    .toBe(true);
  await page.selectOption("#encoder", "nvencc:h264");
  await page
    .getByRole("button", { name: source["video.tab.rtx"], exact: true })
    .click();
  await page.selectOption("#upscaler", "vsr");
  const box = page.locator("#vsrScale");
  const max = page.getByRole("button", { name: source["rtx.vsrScaleMax"] });
  const follow = page.getByRole("button", {
    name: source["rtx.vsrScaleResolution"],
  });
  await expect(box).toHaveValue("2");
  await expect(box).toBeEditable();
  await expect(max).toHaveAttribute("aria-pressed", "false");
  await expect(max).toHaveAttribute("title", source["rtx.vsrScaleMax"]);

  await max.click();
  await expect(max).toHaveAttribute("aria-pressed", "true");
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect(box).not.toBeEditable();
  // H.264 tops out at 4096: 2848 × 1.43 = 4072.
  await expect(box).toHaveValue("1.43");
  await page.screenshot({ path: path.join(data, "vsr-max.png") });

  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await expect(max).toHaveAttribute("aria-pressed", "false");
  // Source size under 画质 = 1×.
  await expect(box).toHaveValue("1.00");
  await page
    .getByRole("button", { name: source["video.tab.encoding"], exact: true })
    .click();
  await page.selectOption("#resizeMode", "long");
  await page.locator("#width").fill("3840");
  await page
    .getByRole("button", { name: source["video.tab.rtx"], exact: true })
    .click();
  await expect(box).toHaveValue("1.35");
  await page.screenshot({ path: path.join(data, "vsr-follow.png") });

  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect(box).toBeEditable();
  await expect(box).toHaveValue("2");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = (await window.encoder.invoke("state")).settings;
        return [s.vsrSize, s.resizeMode];
      }),
    )
    .toEqual(["scale", "source"]);
  // A typed scale sets the size: 画质's resolution shows the source size and
  // cannot be changed until VSR follows it.
  const quality = page.getByRole("button", {
    name: source["video.tab.encoding"],
    exact: true,
  });
  const rtxTab = page.getByRole("button", {
    name: source["video.tab.rtx"],
    exact: true,
  });
  await quality.click();
  await expect(page.locator("#resizeMode")).toBeDisabled();
  await expect(page.locator("#resizeMode")).toHaveValue("source");
  await expect(page.locator("#width")).toHaveCount(0);

  // Switching to VSR with a resolution already set keeps it and follows it.
  await rtxTab.click();
  await page.selectOption("#upscaler", "lanczos");
  await quality.click();
  await expect(page.locator("#resizeMode")).toBeEnabled();
  await page.selectOption("#resizeMode", "long");
  await page.locator("#width").fill("3840");
  await rtxTab.click();
  await page.selectOption("#upscaler", "vsr");
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await expect(box).toHaveValue("1.35");
  await quality.click();
  await expect(page.locator("#resizeMode")).toBeEnabled();
  await expect(page.locator("#resizeMode")).toHaveValue("long");
  await expect(page.locator("#width")).toHaveValue("3840");
  passed = true;
  console.log("VSR size buttons PASS", data);
} finally {
  await app.close();
  if (!passed) process.exitCode = 1;
}
