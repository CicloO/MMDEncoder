require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const core = require("../backend/core.cjs");
const { createEncoder } = require("../backend/encode-job.cjs");
const rtx = require("../backend/rtx-check.cjs");
const {
  appError,
  validationError,
  validationIssue,
} = require("../backend/errors.cjs");
const zh = require("../locales/zh-CN.json");
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
  const log = [];
  await assert.rejects(
    rtx.testEnhancements({
      settings: core.DEFAULTS,
      check: async () => {
        throw validationError([
          validationIssue("VFG_GPU_REQUIRED"),
          {
            code: "FUTURE_DETAIL",
            params: {},
            message: "original external diagnostic",
          },
        ]);
      },
      onStart: () => {},
      onPatch: () => {},
      onLog: (text) => log.push(text),
      emit: () => {},
    }),
  );
  assert.ok(log.join("").includes(zh["error.VFG_GPU_REQUIRED"]));
  assert.ok(log.join("").includes("original external diagnostic"));
});

test("task evidence retains each validation issue before any process starts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-validation-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = {
    id: "job",
    path: path.join(dir, "source.mov"),
    status: "ready",
    settings: {
      ...core.DEFAULTS,
      encoder: "libx264",
      preset: "medium",
      vsr: true,
    },
    meta: { width: 320, height: 180, duration: 1, fps: 30 },
  };
  const evidence = [];
  const encode = createEncoder({
    engineInfo: () => ({}),
    engines: () => core.ENGINES,
    verification: () => ({ verified: false }),
    isStopped: () => false,
    jobIndex: () => 1,
    nameSource: (j) => j.path,
    appendEvidence: (_id, text) => evidence.push(text),
    run: async () => assert.fail("validation must precede execution"),
    commit: () => assert.fail("validation must precede commit"),
    emit: () => {},
    emitProgress: () => {},
  });
  await encode(job);
  assert.equal(job.status, "failed");
  assert.ok(job.errorData.issues.some((i) => i.code === "RTX_NVENCC_REQUIRED"));
  assert.ok(
    job.errorData.issues.some((i) => i.code === "RTX_REVALIDATION_REQUIRED"),
  );
  for (const code of ["RTX_NVENCC_REQUIRED", "RTX_REVALIDATION_REQUIRED"]) {
    assert.ok(job.log.includes(zh[`error.${code}`]));
    assert.ok(evidence.join("").includes(zh[`error.${code}`]));
  }
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

test("NVENC frame size limits are reported before encoding, per codec", () => {
  const rtxSettings = {
    ...core.DEFAULTS,
    encoder: "nvencc:h264",
    preset: "p4",
    bitDepth: 8,
    chroma: "420",
    vsr: true,
    vsrScale: 2,
    vsrQuality: 4,
    vsrStrength: 1,
    resizeMode: "source",
    vfg: true,
    vfgMultiplier: 2,
    vfgMode: "high",
    fps: "source",
  };
  const meta = { width: 2848, height: 1602, fps: 30 };
  const issue = core
    .validateIssues(rtxSettings, meta)
    .find((x) => x.code === "VSR_SCALE_LIMIT");
  assert.deepEqual(issue.params, {
    width: 5696,
    height: 3204,
    max: 4096,
    codec: "H.264",
    scale: 1.43,
  });
  // HEVC and AV1 go to 8192; a smaller scale fits H.264.
  for (const s of [
    { ...rtxSettings, encoder: "nvencc:hevc" },
    { ...rtxSettings, vsrScale: 1.4 },
  ])
    assert.deepEqual(core.validateIssues(s, meta), []);
  assert.equal(
    core
      .validateIssues(
        { ...rtxSettings, encoder: "nvencc:hevc", vsrScale: 3 },
        meta,
      )
      .find((x) => x.code === "VSR_SCALE_LIMIT").params.max,
    8192,
  );
  // Without VSR the plain limit applies.
  assert.ok(
    core
      .validateIssues(
        {
          ...core.DEFAULTS,
          encoder: "nvencc:h264",
          preset: "p4",
          bitDepth: 8,
          resizeMode: "custom",
          width: 5000,
          height: 3000,
        },
        meta,
      )
      .some((x) => x.code === "NVENC_SIZE_LIMIT"),
  );
  // Software encoders have no such limit.
  assert.deepEqual(
    core.validateIssues(
      { ...core.DEFAULTS, resizeMode: "custom", width: 7680, height: 4320 },
      meta,
    ),
    [],
  );
});

test("VSR size follows a typed scale, the encoder's maximum or the 画质 resolution", () => {
  const base = {
    ...core.DEFAULTS,
    encoder: "nvencc:h264",
    preset: "p4",
    bitDepth: 8,
    chroma: "420",
    vsr: true,
    vsrScale: 2,
    vsrQuality: 4,
    vsrStrength: 1,
    resizeMode: "source",
  };
  const meta = { width: 2848, height: 1602, fps: 30 };
  const over = core.validateIssues(base, meta);
  assert.deepEqual(over.find((x) => x.code === "VSR_SCALE_LIMIT").params, {
    width: 5696,
    height: 3204,
    max: 4096,
    codec: "H.264",
    scale: 1.43,
  });
  const max = { ...base, vsrSize: "max" };
  assert.deepEqual(core.dimensions(max, meta), { width: 4072, height: 2290 });
  assert.deepEqual(core.validateIssues(max, meta), []);
  assert.deepEqual(core.dimensions({ ...max, encoder: "nvencc:hevc" }, meta), {
    width: 8174,
    height: 4598,
  });
  // Never above VSR's own 4×.
  assert.deepEqual(
    core.dimensions(
      { ...max, encoder: "nvencc:hevc" },
      { width: 640, height: 360 },
    ),
    { width: 2560, height: 1440 },
  );
  const follow = {
    ...base,
    vsrSize: "resolution",
    resizeMode: "long",
    width: 3840,
  };
  assert.deepEqual(core.dimensions(follow, meta), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(core.validateIssues(follow, meta), []);
  assert.ok(
    core
      .validateIssues({ ...follow, width: 12000, encoder: "nvencc:hevc" }, meta)
      .some((x) => x.code === "VSR_SCALE_INVALID"),
  );
  // A typed scale still needs the source size; quality 8–19 stays at 1×.
  assert.ok(
    core
      .validateIssues({ ...base, resizeMode: "long", width: 3840 }, meta)
      .some((x) => x.code === "VSR_SOURCE_SIZE_REQUIRED"),
  );
  assert.ok(
    core
      .validateIssues({ ...max, vsrQuality: 8 }, meta)
      .some((x) => x.code === "VSR_NATIVE_SCALE_REQUIRED"),
  );
});

test("RTX fix keeps a resolution set under 画质 and makes VSR follow it", () => {
  const engines = core.ENGINES;
  const fix = (s) =>
    core
      .compatibility({ ...core.DEFAULTS, ...s }, engines)
      .suggestions.find((x) => x.id === "rtx-compatible")?.patch;
  // A size under 画质: kept, VSR follows it.
  const kept = fix({ vsr: true, vfg: true, resizeMode: "long", width: 3840 });
  assert.equal(kept.vsrSize, "resolution");
  assert.equal(kept.resizeMode, undefined);
  assert.equal(kept.encoder.startsWith("nvencc:"), true);
  // No size set: the typed scale, source size.
  assert.equal(fix({ vsr: true }).resizeMode, "source");
  // Quality 8–19 only works at 1×.
  assert.deepEqual(
    ["resizeMode", "vsrScale", "vsrSize"].map(
      (k) =>
        fix({ vsr: true, vsrQuality: 8, resizeMode: "long", width: 3840 })[k],
    ),
    ["source", 1, "scale"],
  );
});
