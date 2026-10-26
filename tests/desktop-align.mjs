// 音频对齐 dialog on the media page: add a reference, align automatically,
// nudge, play, apply, and extract the audio lined up with the reference.
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
const testDir = fs.mkdtempSync(path.join(work, "align-ui-"));
const { ff } = require("./engines.cjs");
const { align } = require("../backend/align.cjs");
const run = (args) =>
  execFileSync(ff, ["-v", "error", ...args], { maxBuffer: 1 << 26 });
const song = path.join(testDir, "原曲.flac");
run([
  "-f",
  "lavfi",
  "-i",
  "anoisesrc=d=20:c=pink:r=44100:seed=11,tremolo=f=1.7:d=0.9",
  song,
]);
const render = path.join(testDir, "渲染.mp4");
run([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=160x90:r=30000/1001:d=8",
  "-ss",
  "2.5",
  "-t",
  "8",
  "-i",
  song,
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  "-shortest",
  render,
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
  page.setDefaultTimeout(30000);
  await page.getByRole("heading", { name: /^视频队列/ }).waitFor();
  await page.evaluate(() => {
    localStorage.setItem("mmd-auto-align", "off");
    localStorage.setItem(
      "mmd-media-options",
      JSON.stringify({ autoAlign: false }),
    );
  });
  await page.reload();
  await page.getByRole("heading", { name: /^视频队列/ }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mmd-auto-align")),
    null,
  );
  await page.evaluate(() => {
    window.alignmentMotion = [];
    let previous = "";
    const observe = () => {
      const active = [
        ...document.querySelectorAll(".alignment-wave.active"),
      ].map((node) => ({
        button:
          node.closest("button")?.getAttribute("aria-label") ||
          node.closest("button")?.textContent,
        animation: getComputedStyle(node.querySelector("path")).animationName,
      }));
      const value = JSON.stringify(active);
      if (value !== previous) {
        window.alignmentMotion.push(active);
        previous = value;
      }
    };
    new MutationObserver(observe).observe(document.getElementById("root"), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-busy"],
    });
  });
  const errorTransport = await page.evaluate(async () => {
    const structured = await window.encoder.invokeResult("alignPreview", {
      path: "relative.wav",
    });
    let legacy = "";
    try {
      await window.encoder.invoke("alignPreview", { path: "relative.wav" });
    } catch (error) {
      legacy = error.message;
    }
    return { structured, legacy };
  });
  assert.equal(
    errorTransport.structured.__mmdError.code,
    "ALIGN_INPUT_INVALID",
  );
  assert.equal(errorTransport.legacy, "请选择有效的音频或视频文件");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1280, 900);
    w.showInactive();
  });
  // The file picker answers with the reference (no native dialog in a test).
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, render);
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  if (!process.argv.includes("--trim-only")) {
    await expect
      .poll(
        async () => {
          const s = await state();
          return s.located && !s.detecting;
        },
        { timeout: 120000 },
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "音视频提取与合并", exact: true })
      .click();
    await page.evaluate(
      (p) => window.encoder.invoke("mediaAdd", { paths: [p] }),
      song,
    );
    await page.getByRole("button", { name: /对齐 原曲\.flac 的音频/ }).click();
    const dialog = page.getByRole("dialog", { name: "音频对齐" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "添加参考音频" }).click();
    await expect(dialog.getByText(/匹配可信/)).toBeVisible({ timeout: 60000 });
    await expect(dialog.getByText(/目标开头多出 2\.500\d 秒/)).toBeVisible();
    const frameField = dialog.getByLabel("音频偏移（帧）", { exact: true });
    await expect(frameField).toHaveAttribute("title", "30000/1001");
    await frameField.fill("2");
    await expect(dialog.getByText(/目标开头多出 2\.433\d 秒/)).toBeVisible();
    await dialog.getByRole("button", { name: "自动对齐", exact: true }).click();
    await expect(dialog.getByText(/匹配可信/)).toBeVisible({ timeout: 60000 });
    await expect(frameField).toHaveValue("2");
    await expect(dialog.getByText(/目标开头多出 2\.433\d 秒/)).toBeVisible();
    await frameField.fill("0");
    await page.screenshot({ path: path.join(evidence, "align-dialog.png") });

    // Nudge one frame later and back with the keyboard, then play briefly.
    const target = dialog.getByLabel(/目标音频波形/);
    await target.focus();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByText(/目标开头多出 2\.46\d\d 秒/)).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByText(/目标开头多出 2\.500\d 秒/)).toBeVisible();
    await dialog.getByRole("button", { name: "播放" }).click();
    await expect(dialog.getByRole("button", { name: "暂停" })).toBeVisible();
    await page.waitForTimeout(400);
    await dialog.getByRole("button", { name: "暂停" }).click();

    // Waveforms: right-drag pans the view (not the alignment), a left click
    // sets the playhead; the zoom bar's edge zooms.
    const ruler = dialog.locator(".align-ruler span");
    const playheadText = dialog.locator(".align-time");
    const box = await target.boundingBox();
    const startBefore = await ruler.first().innerText();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up({ button: "right" });
    assert.notEqual(
      await ruler.first().innerText(),
      startBefore,
      "view panned",
    );
    await expect(dialog.getByText(/目标开头多出 2\.500\d 秒/)).toBeVisible();
    const headBefore = await playheadText.innerText();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    assert.notEqual(await playheadText.innerText(), headBefore, "playhead set");
    await expect(dialog.getByText(/目标开头多出 2\.500\d 秒/)).toBeVisible();
    const zoomBar = dialog.getByRole("scrollbar", { name: /视图范围/ });
    const edge = await dialog.locator(".align-zoom-edge.right").boundingBox();
    const endBefore = await ruler.last().innerText();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x - 200, edge.y + edge.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await ruler.last().innerText(), endBefore, "zoomed in");
    await expect(zoomBar).toBeVisible();
    await page.screenshot({ path: path.join(evidence, "align-zoom.png") });

    await dialog.getByRole("button", { name: "应用" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText(/对齐 \+2\.500 秒 · 截到参考长度/),
    ).toBeVisible();
    await page.getByLabel("输出音频").selectOption("flac");
    await page.getByRole("button", { name: "开始处理" }).click();
    await expect
      .poll(async () => (await state()).mediaJobs[0].status, { timeout: 60000 })
      .toBe("done");
    const out = (await state()).mediaJobs[0].output;
    const check = await align({ ffmpeg: ff }, render, out);
    assert.ok(
      Math.abs(check.offset) < 0.0005,
      "extracted audio lines up: " + check.offset,
    );

    // Merge: the render with the song added; chosen, it is aligned at once
    // against the render's own sound (自动对齐 is on by default).
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, song);
    await page.getByLabel("操作").selectOption("merge");
    await expect(
      page.getByLabel("选择音频后自动对齐", { exact: false }),
    ).toHaveCount(0);
    assert.equal(
      await page.evaluate(
        () =>
          "autoAlign" in JSON.parse(localStorage.getItem("mmd-media-options")),
      ),
      false,
    );
    await page.evaluate(
      (p) => window.encoder.invoke("mediaAdd", { paths: [p] }),
      render,
    );
    await page.getByRole("button", { name: /为 渲染\.mp4 选择音频/ }).click();
    await expect(page.getByText(/对齐 \+2\.500 秒/)).toBeVisible({
      timeout: 60000,
    });
    const mergeAlignmentButton = page.getByRole("button", {
      name: /对齐 渲染\.mp4 的合并音频/,
    });
    await expect(mergeAlignmentButton).toHaveAttribute("aria-busy", "false");
    assert.ok(
      await page.evaluate(() =>
        window.alignmentMotion
          .flat()
          .some(
            (item) =>
              item.button?.includes("合并音频") &&
              item.animation === "alignment-wave",
          ),
      ),
      "merge waveform moved during automatic alignment",
    );
    // The dialog shows the video's own sound as the fixed reference.
    await page
      .getByRole("button", { name: /对齐 渲染\.mp4 的合并音频/ })
      .click();
    const mergeDialog = page.getByRole("dialog", { name: "音频对齐" });
    await expect(mergeDialog.getByText(/视频自带的声音/)).toBeVisible();
    await expect(
      mergeDialog.getByRole("button", { name: "添加参考音频" }),
    ).toHaveCount(0);
    await expect(
      mergeDialog.getByText(/目标开头多出 2\.500\d 秒/),
    ).toBeVisible();
    await mergeDialog.getByLabel("音频偏移（帧）", { exact: true }).fill("-2");
    await mergeDialog
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await state()).mediaJobs.find((j) => j.path === render)
            .audioShiftFrames,
      )
      .toBe(-2);
    await page
      .getByRole("button", { name: /对齐 渲染\.mp4 的合并音频/ })
      .click();
    await expect(
      mergeDialog.getByLabel("音频偏移（帧）", { exact: true }),
    ).toHaveValue("-2");
    await page.screenshot({ path: path.join(evidence, "align-merge.png") });
    await mergeDialog.getByRole("button", { name: "取消" }).click();

    // Video page: replacing the render's audio aligns it the same way.
    await page.getByRole("button", { name: "视频压制", exact: true }).click();
    await page.evaluate(
      (p) => window.encoder.invoke("add", { paths: [p] }),
      render,
    );
    await expect
      .poll(async () => (await state()).jobs[0]?.status)
      .toBe("ready");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: /为 渲染\.mp4 选择音频/ }).click();
    await expect
      .poll(async () => (await state()).jobs[0].audioOffset, { timeout: 60000 })
      .toBeCloseTo(2.5, 3);
    await expect(page.getByText(/替换音频：.*对齐 \+2\.500 秒/)).toBeVisible();
    const videoAlignmentButton = page.getByRole("button", {
      name: /对齐 渲染\.mp4 的替换音频/,
    });
    await expect(videoAlignmentButton).toHaveAttribute("aria-busy", "false");
    assert.ok(
      await page.evaluate(() =>
        window.alignmentMotion
          .flat()
          .some(
            (item) =>
              item.button?.includes("替换音频") && item.animation === "none",
          ),
      ),
      "reduced motion keeps a busy waveform static",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // The queue row has the same alignment button as on the media page.
    await page
      .getByRole("button", { name: /对齐 渲染\.mp4 的替换音频/ })
      .click();
    const videoDialog = page.getByRole("dialog", { name: "音频对齐" });
    await expect(videoDialog.getByText(/视频自带的声音/)).toBeVisible();
    await expect(
      videoDialog.getByLabel("音频偏移（帧）", { exact: true }),
    ).toBeEnabled();
    await videoDialog.getByLabel("音频偏移（帧）", { exact: true }).fill("2");
    await videoDialog
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect
      .poll(async () => (await state()).jobs[0].audioShiftFrames)
      .toBe(2);
    await page
      .getByRole("button", { name: /对齐 渲染\.mp4 的替换音频/ })
      .click();
    await expect(
      videoDialog.getByLabel("音频偏移（帧）", { exact: true }),
    ).toHaveValue("2");
    await videoDialog.getByLabel("音频偏移（帧）", { exact: true }).fill("1.5");
    await expect(
      videoDialog.getByRole("button", { name: "应用", exact: true }),
    ).toBeDisabled();
    await videoDialog.getByRole("button", { name: "取消" }).click();
    await expect(videoDialog).toBeHidden();
    assert.equal(
      (await state()).jobs[0].audioShiftFrames,
      2,
      "cancel preserves saved frames",
    );
    const silent = path.join(testDir, "silent.mp4");
    run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=24000/1001:d=2",
      "-c:v",
      "libx264",
      silent,
    ]);
    await page.evaluate(
      (p) => window.encoder.invoke("add", { paths: [p] }),
      silent,
    );
    await expect
      .poll(
        async () => (await state()).jobs.find((j) => j.path === silent)?.status,
      )
      .toBe("ready");
    const silentId = (await state()).jobs.find((j) => j.path === silent).id;
    await page.evaluate(
      ({ id, path }) => window.encoder.invoke("setAudio", { id, path }),
      { id: silentId, path: song },
    );
    await page
      .getByRole("button", { name: /对齐 silent\.mp4 的替换音频/ })
      .click();
    await expect(
      videoDialog.getByText(
        "参考视频没有音轨，可手动调整音频偏移，无法自动匹配波形。",
      ),
    ).toBeVisible();
    await expect(
      videoDialog.getByLabel("音频偏移（帧）", { exact: true }),
    ).toHaveAttribute("title", "24000/1001");
    await videoDialog.getByLabel("音频偏移（帧）", { exact: true }).fill("3");
    await videoDialog
      .getByRole("button", { name: "应用", exact: true })
      .click();
    assert.equal(
      (await state()).jobs.find((j) => j.id === silentId).audioShiftFrames,
      3,
    );
  }
  // Trim: new audio matches automatically; waveform and actual-frame shift
  // stay independent, including a nonzero clip start and MMD display units.
  const trimReference = path.join(testDir, "trim reference.mp4");
  run([
    "-i",
    render,
    "-c:v",
    "libx264",
    "-g",
    "1",
    "-preset",
    "ultrafast",
    "-c:a",
    "copy",
    trimReference,
  ]);
  await page.getByRole("button", { name: "无损剪辑", exact: true }).click();
  await page.evaluate(
    (p) => window.encoder.invoke("trimAdd", { paths: [p] }),
    trimReference,
  );
  await expect
    .poll(async () => (await state()).trim.clips[0]?.status, { timeout: 30000 })
    .toBe("ready");
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, song);
  await page.locator("#trim-audio").selectOption("replace");
  await page.getByRole("button", { name: "选择音频" }).click();
  const trimButton = page.getByRole("button", {
    name: "音频对齐",
    exact: true,
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.alignmentMotion
            .flat()
            .some((item) => item.button === "音频对齐"),
        ),
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(trimButton).toHaveAttribute("aria-busy", "false", {
    timeout: 60000,
  });
  await expect(page.locator("#trim-offset")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "自动填写", exact: true }),
  ).toHaveCount(0);
  await trimButton.click();
  const trimDialog = page.getByRole("dialog", { name: "音频对齐" });
  await expect(trimDialog.getByText(/视频自带的声音/)).toBeVisible();
  await expect(trimDialog.getByText(/目标开头多出 2\.50\d\d 秒/)).toBeVisible({
    timeout: 30000,
  });
  const trimShift = trimDialog.getByLabel("音频偏移（帧）", { exact: true });
  await expect(trimShift).toHaveAttribute("title", "30000/1001");
  await trimShift.fill("2");
  await trimDialog.getByRole("button", { name: "应用" }).click();
  await expect(trimDialog).toBeHidden();
  await trimButton.click();
  await expect(trimShift).toBeEnabled();
  await expect(trimShift).toHaveValue("2");
  await trimDialog
    .getByRole("button", { name: "自动对齐", exact: true })
    .click();
  await expect(trimShift).toBeEnabled({ timeout: 60000 });
  await expect(trimShift).toHaveValue("2");
  await trimShift.fill("-3");
  await trimDialog.getByRole("button", { name: "取消", exact: true }).click();
  await trimButton.click();
  await expect(trimShift).toBeEnabled();
  await expect(trimShift).toHaveValue("2");
  await trimDialog
    .getByRole("button", { name: "清除对齐", exact: true })
    .click();
  await expect(trimDialog).toBeHidden();

  const trimId = (await state()).trim.clips[0].id;
  await page.evaluate(
    (id) => window.encoder.invoke("trimSet", { id, from: 17, to: 65 }),
    trimId,
  );
  await expect.poll(async () => (await state()).trim.clips[0].from).toBe(17);
  await page.getByRole("checkbox", { name: /按 MMD 帧号输入/ }).check();
  await page.locator("#trim-audio-codec").selectOption("pcm");
  const sourcePcm = run([
    "-i",
    song,
    "-af",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "-",
  ]);
  const count = Math.round(((48 * 1001) / 30000) * 44100);
  for (const shift of [0, 2, -3]) {
    await trimButton.click();
    await expect(trimShift).toBeEnabled();
    await trimShift.fill(String(shift));
    await trimDialog.getByRole("button", { name: "应用", exact: true }).click();
    await expect(trimDialog).toBeHidden();
    await expect
      .poll(
        async () => {
          const s = await state();
          return !s.detecting && !s.tools.busy && !s.enhancements.busy;
        },
        { timeout: 60000 },
      )
      .toBe(true);
    const previous = (await state()).trim.output;
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await expect
      .poll(
        async () => {
          const t = (await state()).trim;
          return (
            !t.running &&
            t.output !== previous &&
            t.stage?.stage === "trim_completed"
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);
    const output = (await state()).trim.output;
    const actual = run([
      "-i",
      output,
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "-",
    ]);
    const expected = Buffer.alloc(count * 4),
      at = Math.round((((17 - shift) * 1001) / 30000) * 44100);
    sourcePcm.copy(expected, 0, at * 4, (at + count) * 4);
    assert.equal(
      actual.length,
      expected.length,
      `trim shift ${shift}: sample count`,
    );
    assert.ok(
      actual.equals(expected),
      `trim shift ${shift}: source start once, actual FPS and sample content`,
    );
  }
  const savedTrim = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mmd-trim-options")),
  );
  assert.equal("offset" in savedTrim, false);
  assert.equal("audioFile" in savedTrim, false);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "选择音频" }).click();
  await trimButton.click();
  await expect(trimShift).toBeEnabled();
  await expect(trimShift).toHaveValue("-3");
  await trimDialog.getByRole("button", { name: "取消", exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, song);
  const previousTrimMotion = await page.evaluate(
    () =>
      window.alignmentMotion.flat().filter((item) => item.button === "音频对齐")
        .length,
  );
  await page.getByRole("button", { name: "选择音频" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.alignmentMotion
              .flat()
              .filter((item) => item.button === "音频对齐").length,
        ),
      { timeout: 60000 },
    )
    .toBeGreaterThan(previousTrimMotion);
  await expect(trimButton).toHaveAttribute("aria-busy", "false", {
    timeout: 60000,
  });
  await trimButton.click();
  await expect(trimShift).toBeEnabled();
  await expect(trimShift).toHaveValue("0");
  await expect(trimDialog.getByText(/目标开头多出 2\.50\d\d 秒/)).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({
    path: path.join(evidence, "i18n/b4-trim-audio-dialog.png"),
  });
  await trimDialog.getByRole("button", { name: "取消", exact: true }).click();
  console.log(
    "Trim automatic alignment, independent fractional-frame shift, cancel/reset and 3 sample-exact desktop exports PASS",
  );
  console.log(
    process.argv.includes("--trim-only")
      ? "Desktop trim audio PASS"
      : "Desktop align PASS",
  );
  fs.writeFileSync(
    path.join(evidence, "i18n/b3-auto-align-motion.json"),
    JSON.stringify(await page.evaluate(() => window.alignmentMotion), null, 2),
  );
  passed = true;
} catch (error) {
  fs.writeFileSync(
    path.join(testDir, "failure-error.txt"),
    String(error.stack || error),
  );
  try {
    const page = await app.firstWindow();
    fs.writeFileSync(
      path.join(testDir, "failure-state.json"),
      JSON.stringify(
        await page.evaluate(async () => ({
          state: await window.encoder.invoke("state"),
          text: document.body.innerText,
        })),
        null,
        2,
      ),
    );
    await page.screenshot({ path: path.join(testDir, "failure.png") });
  } catch (diagnosticError) {
    console.error(
      "Could not capture desktop diagnostic:",
      diagnosticError.message,
    );
  }
  throw error;
} finally {
  await app.close();
  if (passed) fs.rmSync(testDir, { recursive: true, force: true });
}
