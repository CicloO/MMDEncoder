// Native media decode, timeline coordination, stream access and file release.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/trim-playback-"));
const { ff } = require("./engines.cjs");
const input = path.join(dir, "User 片段 # 50% ' sample.mp4");
const prores = path.join(dir, "User ProRes.mov");
const make = (file, args) =>
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30000/1001:d=6",
    ...args,
    file,
  ]);
make(input, [
  "-c:v",
  "libx264",
  "-g",
  "30",
  "-keyint_min",
  "30",
  "-sc_threshold",
  "0",
  "-bf",
  "0",
]);
make(prores, ["-c:v", "prores_ks", "-profile:v", "1"]);
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
  await app.evaluate((_, root) => {
    const nativeRequire = process
      .getBuiltinModule("module")
      .createRequire(root + "/desktop/main.cjs");
    const trim = nativeRequire("../backend/trim.cjs"),
      read = trim.frameJpeg;
    globalThis.trimJpegReads = 0;
    trim.frameJpeg = (...args) => {
      globalThis.trimJpegReads++;
      return read(...args);
    };
  }, root);
  await page.getByRole("button", { name: "无损剪辑", exact: true }).click();
  await page.evaluate(
    (paths) => window.encoder.invoke("trimAdd", { paths }),
    [input, prores],
  );
  const state = () =>
    page.evaluate(async () => (await window.encoder.invoke("state")).trim);
  await expect
    .poll(
      async () =>
        (await state()).clips.length === 2 &&
        (await state()).clips.every((c) => c.status === "ready"),
    )
    .toBe(true);
  const id = (await state()).clips[0].id;
  const stream = `mmd-preview://clip/${id}`;
  const request = (url, options = {}) =>
    app.evaluate(
      async ({ net }, { url, options }) => {
        const response = await net.fetch(url, options);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()).toString("base64"),
        };
      },
      { url, options },
    );
  const range = await request(stream, { headers: { Range: "bytes=100-163" } });
  assert.equal(range.status, 206);
  assert.deepEqual(
    Buffer.from(range.body, "base64"),
    fs.readFileSync(input).subarray(100, 164),
  );
  assert.match(range.headers["content-range"], /^bytes 100-163\//);
  const head = await request(stream, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  for (const url of [
    "mmd-preview://other/" + id,
    stream + "?path=" + encodeURIComponent(prores),
    "mmd-preview://clip/" + encodeURIComponent(input),
    "mmd-preview://clip/%2e%2e%2fsecret",
    "mmd-preview://clip/not-a-clip",
  ])
    assert.equal((await request(url)).status, 404, url);
  assert.equal((await request(stream, { method: "POST" })).status, 405);
  assert.equal(
    await page.evaluate(() =>
      window.encoder.invokeResult("trimPreviewSource", {}).then(
        () => false,
        () => true,
      ),
    ),
    true,
  );

  const video = page.locator(".trim-preview video");
  const slider = page.getByRole("slider", { name: "当前帧" });
  const play = () => page.getByRole("button", { name: "播放", exact: true });
  await expect(video).toBeVisible();
  await expect(play()).toBeEnabled();
  await video.evaluate((node) => {
    node.muted = true;
  });
  await page.evaluate(
    (id) => window.encoder.invoke("trimSet", { id, from: 30, to: 60 }),
    id,
  );
  await expect(slider).toHaveValue("30");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("31");
  await expect
    .poll(() => video.evaluate((node) => node.currentTime))
    .toBeCloseTo((31 * 1001) / 30000, 4);
  const calls = await app.evaluate(() => globalThis.trimJpegReads);
  const saved = (await state()).clips.map(({ id, from, to, fps }) => ({
    id,
    from,
    to,
    fps,
  }));
  await play().click();
  await expect
    .poll(() =>
      video.evaluate(
        (node) => !node.paused && node.currentTime > (36 * 1001) / 30000,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect.poll(() => video.evaluate((node) => node.paused)).toBe(true);
  const pausedFrame = Number(await slider.inputValue());
  assert.ok(pausedFrame >= 35 && pausedFrame < 60);
  await play().click();
  await expect
    .poll(() =>
      video.evaluate(
        (node) =>
          node.paused && node.currentTime >= (59 * 1001) / 30000 - 0.001,
      ),
    )
    .toBe(true);
  await expect(slider).toHaveValue("59");
  await expect
    .poll(() => video.evaluate((node) => node.currentTime))
    .toBeCloseTo((59 * 1001) / 30000, 4);
  assert.equal(
    await app.evaluate(() => globalThis.trimJpegReads),
    calls,
    "native playback and seeks do not request JPEGs",
  );
  assert.deepEqual(
    (await state()).clips.map(({ id, from, to, fps }) => ({
      id,
      from,
      to,
      fps,
    })),
    saved,
  );

  await play().click();
  await expect.poll(() => video.evaluate((node) => !node.paused)).toBe(true);
  await page.getByRole("button", { name: "下一帧", exact: true }).click();
  await expect.poll(() => video.evaluate((node) => node.paused)).toBe(true);
  const stopped = Number(await slider.inputValue());
  await expect
    .poll(() => video.evaluate((node) => node.currentTime))
    .toBeCloseTo((stopped * 1001) / 30000, 4);
  await video.evaluate((node) => {
    window.oldTrimVideo = node;
  });
  await page
    .locator(".job-select")
    .filter({ hasText: path.basename(prores) })
    .click();
  await expect(
    page.getByText("此文件无法直接播放，使用逐帧预览。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".trim-preview img")).toHaveAttribute(
    "src",
    /^data:image\/jpeg;base64,/,
  );
  await expect(play()).toBeDisabled();
  assert.equal(
    await page.evaluate(
      () =>
        window.oldTrimVideo.paused &&
        !window.oldTrimVideo.getAttribute("src") &&
        window.oldTrimVideo.readyState === 0,
    ),
    true,
  );
  const oldImage = await page.locator(".trim-preview img").getAttribute("src");
  await page.getByRole("button", { name: "下一帧", exact: true }).click();
  await expect
    .poll(() => page.locator(".trim-preview img").getAttribute("src"))
    .not.toBe(oldImage);

  await page
    .locator(".job-select")
    .filter({ hasText: path.basename(input) })
    .click();
  await expect(play()).toBeEnabled();
  await video.evaluate((node) => {
    node.muted = true;
    window.oldTrimVideo = node;
  });
  await play().click();
  await expect.poll(() => video.evaluate((node) => !node.paused)).toBe(true);
  await page.getByRole("button", { name: "视频压制", exact: true }).click();
  await expect(page.locator(".trim-preview video")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.oldTrimVideo.paused &&
          !window.oldTrimVideo.getAttribute("src") &&
          window.oldTrimVideo.readyState === 0,
      ),
    )
    .toBe(true);
  const renamed = path.join(dir, "released.mp4");
  assert.equal(path.dirname(input), path.resolve(dir));
  assert.equal(path.dirname(renamed), path.resolve(dir));
  await expect
    .poll(() => {
      try {
        fs.renameSync(input, renamed);
        fs.renameSync(renamed, input);
        return true;
      } catch {
        if (fs.existsSync(renamed)) fs.renameSync(renamed, input);
        return false;
      }
    })
    .toBe(true);
  await page.evaluate((id) => window.encoder.invoke("trimRemove", { id }), id);
  assert.equal(
    (await request(stream)).status,
    404,
    "removing a clip revokes its stream",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        range: { status: range.status, headers: range.headers },
        startFrame: 31,
        outFrame: 60,
        lastFrame: 59,
        pausedFrame,
        jpegReads: calls,
        checks: [
          "range-and-head",
          "path-and-method-restrictions",
          "fractional-fps",
          "pause-resume",
          "stop-at-out",
          "manual-seek",
          "prores-fallback",
          "switch-release",
          "leave-release",
          "revocation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Native trim playback, stream restrictions, JPEG fallback and release PASS",
    dir,
  );
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure-error.txt"),
    String(error.stack || error),
  );
  try {
    const page = await app.firstWindow();
    fs.writeFileSync(
      path.join(dir, "failure-state.json"),
      JSON.stringify(
        await page.evaluate(async () => ({
          trim: (await window.encoder.invoke("state")).trim,
          text: document.body.innerText,
          video: (() => {
            const v = document.querySelector("video");
            return (
              v && {
                src: v.src,
                error: v.error?.message,
                ready: v.readyState,
                time: v.currentTime,
                paused: v.paused,
              }
            );
          })(),
        })),
        null,
        2,
      ),
    );
  } catch {}
  throw error;
} finally {
  await app.close();
}
