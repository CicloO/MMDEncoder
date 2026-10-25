require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const core = require("../backend/core.cjs");
const { createEncoder } = require("../backend/encode-job.cjs");
const rtx = require("../backend/rtx-check.cjs");
const { appError } = require("../backend/errors.cjs");
const { load } = require("./load-typescript.cjs");

test("failed encoding keeps system identity, readable external diagnostics and retry eligibility independently of wording", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-errors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [code, message, retry] of [
    ["ENOSPC", "foreign storage diagnostic", false],
    ["EACCES", "foreign access diagnostic", false],
    [1, "磁盘 空间 权限 ENOSPC are just diagnostic text", true],
  ]) {
    const job = {
      id: "job",
      path: path.join(dir, "source.mov"),
      status: "ready",
      settings: {
        ...core.DEFAULTS,
        encoder: "libx264",
        preset: "medium",
        outputMode: "custom",
        outputDir: dir,
      },
      meta: { width: 320, height: 180, duration: 1, fps: 30 },
    };
    const states = [];
    const encode = createEncoder({
      engineInfo: () => ({ ffmpeg: "ffmpeg" }),
      engines: () => core.ENGINES,
      verification: () => ({}),
      isStopped: () => false,
      jobIndex: () => 1,
      nameSource: (j) => j.path,
      appendEvidence: () => {},
      run: async () => {
        throw Object.assign(new Error(message), { code });
      },
      commit: () => assert.fail("failed output must not be committed"),
      emit: () => states.push(JSON.parse(JSON.stringify(job))),
      emitProgress: () => {},
    });
    await encode(job);
    assert.equal(job.status, "failed");
    assert.equal(job.softwareRetry, retry);
    assert.equal(
      job.errorData.code,
      typeof code === "string" ? code : "VIDEO_ENGINE_FAILED",
    );
    assert.ok(JSON.stringify(job.errorData).includes(message));
    assert.equal(job.stage.stage, "stopped");
    assert.equal(states[0].stage.stage, "preparing");
    assert.equal(job.output, undefined);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test("RTX failure and invalidation keep coded causes through state serialization", async () => {
  let state = {};
  await assert.rejects(
    rtx.testEnhancements({
      settings: core.DEFAULTS,
      check: async () => {
        throw appError("VFG_GPU_REQUIRED");
      },
      onStart: (value) => (state = value),
      onPatch: (patch) => Object.assign(state, patch),
      onLog: () => {},
      emit: () => {},
    }),
    (e) => e.code === "VFG_GPU_REQUIRED",
  );
  const wire = JSON.parse(JSON.stringify(state));
  assert.equal(wire.busy, false);
  assert.equal(wire.verified, false);
  assert.equal(wire.messageData.code, "RTX_FAILED");
  assert.equal(wire.errorData.code, "VFG_GPU_REQUIRED");
  rtx.invalidateSettings(wire, { ...core.DEFAULTS, vsr: true });
  assert.equal(wire.messageData.code, "RTX_SETTINGS_CHANGED");
  rtx.invalidateTools(wire);
  assert.equal(wire.messageData.code, "RTX_TOOLS_CHANGED");
});

test("preview summaries translate technical records at display time and preserve the saved fallback", () => {
  const i18n = load("src/i18n.ts");
  const record = {
    code: "VIDEO_PREVIEW",
    params: {
      width: 1920,
      height: 1080,
      sourceFps: "30/1",
      targetFps: "60000/1001",
      encoder: "libx264",
      engineKey: "presentation.encoder",
      engineParams: { codec: "H.264", backend: "CPU" },
      bitDepth: 8,
      audio: "none",
      container: "mp4",
      repeatFrames: true,
      nvencc: false,
    },
    message: "saved fallback",
  };
  const original = JSON.stringify(record);
  assert.match(i18n.summaryMessage(record), /H.264.*无音频.*通过重复帧/);
  i18n.localeRuntime.registerCatalog("en-XA", {
    "message.VIDEO_PREVIEW": "{encoder}: {width}x{height}, {fps}, {audio}",
    "presentation.encoder": "{codec} via {backend}",
    "output.noAudio": "Silent",
    "video.previewWithRepeat": "Repeat: {summary}",
  });
  i18n.setLocale("en-XA");
  assert.match(
    i18n.summaryMessage(record),
    /^Repeat: H.264 via CPU: 1920x1080, 30\/1 → 60000\/1001, Silent$/,
  );
  assert.equal(JSON.stringify(record), original);
});
