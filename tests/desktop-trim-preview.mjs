// Real JPEGs from four source aspect ratios at two window sizes.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/trim-preview-"));
const { ff } = require("./engines.cjs");
const sources = [];
for (const [name, width, height] of [
  ["16x9", 320, 180],
  ["4x3", 320, 240],
  ["9x16", 180, 320],
  ["21x9", 420, 180],
]) {
  const file = path.join(dir, `User 画幅 # % ${name}.mp4`);
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=${width}x${height}:r=30:d=2`,
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  sources.push({ name, width, height, file });
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
  page.setDefaultTimeout(30000);
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  await page.getByRole("button", { name: "无损剪辑", exact: true }).click();
  await page.evaluate(
    (files) => window.encoder.invoke("trimAdd", { paths: files }),
    sources.map((s) => s.file),
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const clips = (await window.encoder.invoke("state")).trim.clips;
        return clips.length === 4 && clips.every((c) => c.status === "ready");
      }),
    )
    .toBe(true);
  const before = await page.evaluate(async () =>
    (await window.encoder.invoke("state")).trim.clips.map(
      ({ id, from, to, fps }) => ({ id, from, to, fps }),
    ),
  );
  const measurements = [];
  for (const source of sources) {
    await page
      .locator(".job-select")
      .filter({ hasText: path.basename(source.file) })
      .click();
    await expect(page.locator(".trim-editor h3")).toHaveAttribute(
      "title",
      source.file,
    );
    const image = page.locator(".trim-preview img");
    await expect
      .poll(() =>
        image
          .evaluate(
            (node, ratio) =>
              node.complete &&
              node.naturalWidth > 0 &&
              Math.abs(node.naturalWidth / node.naturalHeight - ratio) < 0.01,
            source.width / source.height,
          )
          .catch(() => false),
      )
      .toBe(true);
    for (const width of [1360, 700]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(width, 1000);
        w.showInactive();
      }, width);
      await page.locator(".trim-preview").scrollIntoViewIfNeeded();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const measure = await image.evaluate((node) => {
        const frame = node.parentElement.getBoundingClientRect(),
          image = node.getBoundingClientRect();
        const scale = Math.min(
          frame.width / node.naturalWidth,
          frame.height / node.naturalHeight,
        );
        return {
          frame: frame.toJSON(),
          image: image.toJSON(),
          natural: [node.naturalWidth, node.naturalHeight],
          fit: getComputedStyle(node).objectFit,
          content: [node.naturalWidth * scale, node.naturalHeight * scale],
          page: [
            document.querySelector(".page-scroll").clientWidth,
            document.querySelector(".page-scroll").scrollWidth,
          ],
        };
      });
      assert.ok(
        Math.abs(measure.frame.width / measure.frame.height - 16 / 9) < 0.01,
      );
      assert.equal(measure.fit, "contain");
      assert.ok(Math.abs(measure.image.width - measure.frame.width) <= 1);
      assert.ok(Math.abs(measure.image.height - measure.frame.height) <= 1);
      assert.ok(
        measure.content[0] <= measure.frame.width + 1 &&
          measure.content[1] <= measure.frame.height + 1,
      );
      assert.ok(measure.page[1] <= measure.page[0]);
      measurements.push({ source: source.name, width, ...measure });
      const png = await app.evaluate(
        async ({ BrowserWindow }, rect) =>
          (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect))
            .toPNG()
            .toString("base64"),
        {
          x: Math.round(measure.frame.x),
          y: Math.round(measure.frame.y),
          width: Math.round(measure.frame.width),
          height: Math.round(measure.frame.height),
        },
      );
      fs.writeFileSync(
        path.join(dir, `${source.name}-${width}.png`),
        Buffer.from(png, "base64"),
      );
    }
  }
  assert.deepEqual(
    await page.evaluate(async () =>
      (await window.encoder.invoke("state")).trim.clips.map(
        ({ id, from, to, fps }) => ({ id, from, to, fps }),
      ),
    ),
    before,
  );
  fs.writeFileSync(
    path.join(dir, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log("Real trim preview 4 aspect ratios x 2 window widths PASS", dir);
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure-error.txt"),
    String(error.stack || error),
  );
  throw error;
} finally {
  await app.close();
}
