// Native media decode, timeline coordination, stream access and file release.
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
const fixtureDir = path.join(dir, "fixture-dist");
await build({
  root,
  base: "./",
  build: {
    outDir: fixtureDir,
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
  const size = fs.statSync(input).size;
  const suffix = await request(stream, { headers: { Range: "bytes=-16" } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(
    Buffer.from(suffix.body, "base64"),
    fs.readFileSync(input).subarray(-16),
  );
  const tail = await request(stream, {
    headers: { Range: `bytes=${size - 8}-` },
  });
  assert.equal(tail.status, 206);
  assert.deepEqual(
    Buffer.from(tail.body, "base64"),
    fs.readFileSync(input).subarray(-8),
  );
  for (const value of [
    `bytes=${size}-`,
    "bytes=-0",
    "bytes=10-2",
    "bytes=bad",
    "bytes=0-1,5-6",
  ]) {
    const response = await request(stream, { headers: { Range: value } });
    assert.equal(response.status, 416);
    assert.equal(response.headers["content-range"], `bytes */${size}`);
  }
  const head = await request(stream, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), size);
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

  await slider.focus();
  await page.keyboard.press("ArrowUp");
  await expect(slider).toHaveValue("30");
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
  const actualClips = (await state()).clips;
  await app.evaluate(
    async ({ BrowserWindow }, file) =>
      BrowserWindow.getAllWindows()[0].loadFile(file),
    path.join(fixtureDir, "tests/fixtures/i18n/align.html"),
  );
  await page
    .getByRole("button", { name: "Alignment fixture focus target" })
    .waitFor();
  await page.evaluate(() => window.alignLocale.showTrim());
  await expect(page.locator(".trim-editor h3")).toBeVisible();
  await page.evaluate(
    (clips) =>
      window.alignLocale.setTrimClips([
        { ...clips[0], from: 0, to: clips[0].frames },
      ]),
    actualClips,
  );
  await expect(play()).toBeEnabled();
  await video.evaluate((node) => {
    node.muted = true;
    window.localeTrimVideo = node;
  });
  await play().click();
  await expect
    .poll(() =>
      video.evaluate((node) => !node.paused && node.currentTime > 0.2),
    )
    .toBe(true);
  const localeBefore = await page.evaluate(() => ({
    time: document.querySelector("video").currentTime,
    snapshot: window.alignLocale.trimSnapshot(),
  }));
  for (const locale of ["en-XA", "en-XB", "unsupported", "zh-CN"]) {
    await page.evaluate((locale) => window.alignLocale.choose(locale), locale);
    const expected = await page.evaluate(
      (locale) =>
        locale.startsWith("en-X")
          ? window.alignLocale.pseudo["trim.pause"]
          : "暂停",
      locale,
    );
    await expect(
      page.locator(".trim-buttons > button[aria-pressed]"),
    ).toHaveText(expected);
    assert.equal(
      await page.evaluate(
        (time) =>
          window.localeTrimVideo === document.querySelector("video") &&
          !window.localeTrimVideo.paused &&
          window.localeTrimVideo.currentTime >= time,
        localeBefore.time,
      ),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.alignLocale.trimSnapshot()),
      localeBefore.snapshot,
    );
  }
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  fs.writeFileSync(
    path.join(dir, "native-player.png"),
    Buffer.from(png, "base64"),
  );
  await page.evaluate(
    (clips) => window.alignLocale.setTrimClips([clips[1]]),
    actualClips,
  );
  await expect(
    page.getByText("此文件无法直接播放，使用逐帧预览。", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.alignLocale.choose("en-XA"));
  const fallback = await page.evaluate(
    () => window.alignLocale.pseudo["trim.previewUnavailable"],
  );
  await expect(page.getByText(fallback, { exact: true })).toBeVisible();

  // A sparse tail makes cancellation observable before EOF without creating
  // a large media fixture or changing the user's files.
  let cancelledStream;
  fs.truncateSync(input, size + (64 << 20));
  try {
    await app.evaluate((_, source) => {
      const fs = process.getBuiltinModule("fs"),
        create = fs.createReadStream;
      globalThis.trimStreamChecks = [];
      fs.createReadStream = (...args) => {
        const stream = create(...args);
        if (args[0] === source) {
          const check = { closed: false, bytesRead: 0 };
          globalThis.trimStreamChecks.push(check);
          stream.once("close", () => {
            check.closed = true;
            check.bytesRead = stream.bytesRead;
          });
        }
        return stream;
      };
    }, input);
    const bytes = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url),
        reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      return first.value.length;
    }, stream);
    assert.ok(bytes > 0);
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.trimStreamChecks.at(-1)?.closed),
      )
      .toBe(true);
    cancelledStream = await app.evaluate(() =>
      globalThis.trimStreamChecks.at(-1),
    );
    assert.ok(cancelledStream.bytesRead < size + (64 << 20));
  } finally {
    fs.truncateSync(input, size);
  }
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
        cancelledStream,
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
          "playing-locale-preserved",
          "consumer-cancel-closes-file",
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
