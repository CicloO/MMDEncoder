import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/naming-ui-"));
const english = !process.argv.includes("original");
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: /^视频队列/ }).waitFor();
  const selected = path.join(dir, "User 用户选择.mkv");
  await app.evaluate(({ dialog }, selected) => {
    global.namingOptions = [];
    dialog.showSaveDialog = async (_window, options) => {
      global.namingOptions.push(options);
      return { canceled: false, filePath: selected };
    };
  }, selected);
  for (const [payload, extension] of [
    [{ operation: "audio", audioFormat: "aac" }, "m4a"],
    [{ operation: "audio", audioFormat: "copy" }, "mka"],
    [{ operation: "merge" }, "mkv"],
  ]) {
    const result = await page.evaluate(
      (payload) => window.encoder.invokeResult("pickMediaOutput", payload),
      payload,
    );
    assert.equal(
      result,
      selected,
      "the user's actual selected name stays exact",
    );
    const options = await app.evaluate(() => global.namingOptions.at(-1));
    assert.deepEqual(options, {
      title: "选择新的输出文件",
      defaultPath: (english ? "output." : "输出.") + extension,
      filters: [{ name: "输出文件", extensions: [extension] }],
    });
  }
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  assert.equal(
    await page.evaluate(() =>
      window.encoder.invokeResult("pickMediaOutput", { operation: "merge" }),
    ),
    null,
  );
  await expect(page.getByRole("heading", { name: /^视频队列/ })).toBeVisible();
  console.log(
    "Desktop output naming PASS",
    english ? "English" : "original",
    dir,
  );
} finally {
  await app.close();
}
