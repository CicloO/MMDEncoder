import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const { ff } = require("./engines.cjs");
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.resolve(root, "verification");
const work = path.resolve(root, "verification/work");
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(work, "alpha-ui-"));
const input = path.join(data, "alpha.mkv");
execFileSync(
  ff,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30:d=0.3,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a=128",
    "-c:v",
    "ffv1",
    input,
  ],
  { windowsHide: true },
);
const packaged = process.env.MMD_PACKAGE_EXE;
const app = await electron.launch({
  executablePath: packaged || require("electron"),
  args: packaged ? [] : [root],
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
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await page.evaluate(async (input) => {
    await window.encoder.invoke("add", { paths: [input] });
  }, input);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const job = (await window.encoder.invoke("state")).jobs[0];
        return {
          status: job?.status,
          width: job?.meta?.width,
          height: job?.meta?.height,
        };
      }),
    )
    .toEqual({ status: "ready", width: 160, height: 90 });
  await page.selectOption("#resizeMode", "custom");
  await page.locator("#width").fill("320");
  await expect(page.locator("#height")).toHaveValue("180");
  await page.locator("#width").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(evidence, "06-resolution.png"),
    timeout: 15000,
  });
  await page.getByRole("button", { name: "透明通道", exact: true }).click();
  await page.selectOption("#alphaMode", "preserve");
  await expect(
    page.getByRole("alert").getByText("保留 Alpha 请选择", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "07-preserve-alpha.png"),
    timeout: 15000,
  });
  console.log(
    `${packaged ? "Packaged" : "Source"} resolution and alpha UI PASS`,
  );
  passed = true;
} finally {
  await app.close();
  // Keep the working folder only when something failed.
  if (passed) fs.rmSync(data, { recursive: true, force: true });
}
