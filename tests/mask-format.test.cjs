const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const core = require("../backend/core.cjs");
const {
  maskChoice,
  maskSettings,
  withMaskCapabilities,
} = require("../backend/mask-settings.cjs");
const baseline = require("./fixtures/i18n/mask-baseline.json");
const hash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("preview mask facts use the actual selected codec and quality and refresh with locale", () => {
  const { load } = require("./load-typescript.cjs");
  const i18n = load("src/i18n.ts");
  const p = load("src/presentation.ts", { "./i18n": i18n });
  const s = { ...core.DEFAULTS, maskFormat: "gpu-lossy" };
  const preview = {
    maskEncoding: {
      encoder: "hevc_nvenc",
      gpu: true,
      quality: 22,
      format: "gpu-lossy",
    },
  };
  assert.equal(p.maskFacts(s, preview), "HEVC 有损 · CQ 22");
  assert.equal(
    p.maskFacts({ ...s, maskFormat: "lossless" }, preview),
    "H.264 无损",
  );
  const record = {
    code: "VIDEO_MASK_PREVIEW",
    params: {
      width: 320,
      height: 180,
      sourceFps: "30/1",
      container: "mkv",
      audio: "none",
      encoder: "libx264",
      bitDepth: 8,
      maskFormat: "gpu-lossy",
      maskEncoder: "hevc_nvenc",
      maskQuality: 22,
    },
  };
  assert.match(i18n.summaryMessage(record), /HEVC 有损.*CQ 22/);
  i18n.localeRuntime.registerCatalog("en-XA", {
    "mask.encodingFacts": "{codec} lossy {mode} {quality}",
  });
  i18n.setLocale("en-XA");
  assert.equal(p.maskFacts(s, preview), "HEVC lossy CQ 22");
  assert.match(i18n.summaryMessage(record), /HEVC lossy CQ 22/);
  i18n.setLocale("zh-CN");
});

test("32 default mask command records stay exact, with only the independently accepted three-stage NVEncC delta", () => {
  for (const old of baseline.cases)
    for (const explicit of [false, true]) {
      const settings = {
        ...old.settings,
        // Feature 7 intentionally rejects the former default bitrate 0.
        // These mask-only/no-audio command records remain otherwise exact.
        audioBitrate: core.DEFAULTS.audioBitrate,
        ...(explicit ? { maskFormat: "lossless" } : {}),
      };
      const commands = core.singlePass(
        core.buildCommands(
          { path: "source.avi", meta: baseline.meta },
          settings,
          old.engines,
          {
            output: "output." + settings.container,
            maskOutput: "mask." + settings.container,
          },
        ),
      );
      const metadata = commands
        .filter((c) => c.maskEncoding)
        .map((c) => c.maskEncoding);
      if (old.engines.nvencLossless && settings.container !== "webm")
        assert.ok(
          metadata.length &&
            metadata.every(
              (m) =>
                m.gpu && m.format === "lossless" && m.encoder === "h264_nvenc",
            ),
        );
      const legacy = JSON.parse(
        JSON.stringify(commands, (key, value) =>
          key === "maskEncoding" ? undefined : value,
        ),
      );
      assert.equal(
        hash(legacy),
        old.pipelineHash || old.hash,
        JSON.stringify({
          container: settings.container,
          maskOnly: settings.alphaMode,
          encoder: settings.encoder,
          gpu: old.engines.nvencLossless,
          explicit,
        }),
      );
    }
});

test("mask selection prefers tested HEVC, uses H.264 when needed and explains CPU fallback", () => {
  const s = {
    ...core.DEFAULTS,
    alphaMask: true,
    maskFormat: "gpu-lossy",
    quality: 40,
    preset: "veryslow",
    bitDepth: 10,
  };
  const meta = { width: 1920, height: 1080 };
  const info = withMaskCapabilities({ ffmpeg: "ff" }, [
    { id: "h264_nvenc" },
    { id: "hevc_nvenc" },
    { id: "nvencc:hevc" },
  ]);
  const hevc = maskChoice(s, meta, info);
  assert.equal(hevc.encoder, "hevc_nvenc");
  assert.equal(hevc.settings.quality, 22);
  assert.equal(hevc.settings.preset, "p4");
  const avc = maskChoice(s, meta, { maskEncoders: ["h264_nvenc"] });
  assert.equal(avc.encoder, "h264_nvenc");
  assert.equal(avc.settings.quality, 19);
  for (const [m, caps, code] of [
    [meta, {}, "MASK_GPU_UNAVAILABLE"],
    [{ width: 64, height: 64 }, info, "MASK_GPU_SIZE_FALLBACK"],
    [{ width: 8192, height: 4096 }, info, "MASK_GPU_SIZE_FALLBACK"],
    [meta, { ...info, allowGpuMask: false }, "MASK_GPU_UNAVAILABLE"],
  ]) {
    const fallback = maskChoice(s, m, caps);
    assert.equal(fallback.encoder, "libx264");
    assert.equal(fallback.gpu, false);
    assert.equal(fallback.settings.quality, 18);
    assert.equal(fallback.settings.preset, "veryfast");
    assert.equal(fallback.note.code, code);
  }
  for (const format of ["gpu-lossy", "x264-lossy"]) {
    const webm = maskChoice(
      { ...s, container: "webm", maskFormat: format },
      meta,
      info,
    );
    assert.equal(webm.encoder, "libvpx-vp9");
    assert.equal(webm.gpu, false);
    assert.ok(webm.settings.quality > 0);
  }
  assert.equal(maskSettings({ ...s, maskFormat: "x264-lossy" }).quality, 18);
  assert.ok(
    core
      .validateIssues({ ...core.DEFAULTS, maskFormat: "invalid" })
      .some((i) => i.code === "MASK_FORMAT_INVALID"),
  );
});

test("GPU metadata survives a single-pass colour pipeline or a mask-only command", () => {
  for (const encoder of ["libx264", "nvencc:hevc"])
    for (const only of [false, true]) {
      const settings = {
        ...core.DEFAULTS,
        encoder,
        preset: encoder.startsWith("nvencc:") ? "p4" : "medium",
        maskFormat: "gpu-lossy",
        alphaMask: !only,
        alphaMode: only ? "mask" : "discard",
      };
      const commands = core.singlePass(
        core.buildCommands(
          { path: "source.avi", meta: baseline.meta },
          settings,
          { ffmpeg: "ff", nvencc: "nv", maskEncoders: ["hevc_nvenc"] },
          { output: "out.mp4", maskOutput: "alpha.mp4" },
        ),
      );
      const gpu = commands.filter((c) => c.maskEncoding?.gpu);
      assert.equal(gpu.length, 1);
      assert.equal(gpu[0].maskEncoding.format, "gpu-lossy");
      const args = gpu[0].pipeFrom?.args || gpu[0].args;
      assert.ok(args.includes("hevc_nvenc"));
      assert.ok(!args.includes("lossless"));
      assert.equal(args.filter((a) => a === "-i").length, 1);
    }
});
