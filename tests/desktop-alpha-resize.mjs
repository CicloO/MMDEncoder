import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.resolve(root, "verification");
const data = fs.mkdtempSync(
  path.resolve(root, "verification/work") + "/alpha-ui-",
);
const input = JSON.parse(
  fs.readFileSync(path.join(evidence, "debug-state.json"), "utf8"),
).jobs[0].path;
const app = await electron.launch({
  executablePath:
    process.env.MMD_PACKAGE_EXE ||
    path.resolve(root, "release/MMDEncoder/MMDEncoder.exe"),
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
  console.log("Packaged resolution and alpha UI PASS");
  passed = true;
} finally {
  await app.close();
  // Keep the working folder only when something failed.
  if (passed) fs.rmSync(data, { recursive: true, force: true });
}
