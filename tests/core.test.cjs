const test = require("node:test");
const assert = require("node:assert/strict");
test("invalid encoder presets are rejected instead of silently replaced", () => {
  for (const encoder of [
    "libx264",
    "libx265",
    "libsvtav1",
    "libvpx-vp9",
    "hevc_nvenc",
    "hevc_qsv",
    "hevc_amf",
    "nvencc:hevc",
  ]) {
    const errors = c.validate({
      ...c.DEFAULTS,
      encoder,
      preset: "invalidspeed",
    });
    assert.ok(
      errors.some((e) => e.includes("速度预设")),
      encoder,
    );
  }
});
const c = require("../backend/core.cjs");
test("audio bitrate reaches FFmpeg and NVEncC preparation", () => {
  const job = {
    path: "a.mkv",
    meta: { width: 640, height: 360, audio: { channels: 2 } },
  };
  for (const encoder of ["libx264", "nvencc:hevc"]) {
    for (const audio of ["aac", "libopus"]) {
      const args = c
        .buildCommands(
          job,
          {
            ...c.DEFAULTS,
            encoder,
            container: "mkv",
            preset: encoder.startsWith("nvencc") ? "p7" : "medium",
            audio,
            audioBitrate: 128,
          },
          { ffmpeg: "ffmpeg", nvencc: "NVEncC" },
          { output: "out.mkv" },
        )
        .at(-1).args; // NVEncC: audio is added when packaging
      assert.equal(args[args.indexOf("-b:a") + 1], "128k");
    }
  }
  for (const audio of ["flac", "pcm_s16le", "none"]) {
    assert.equal(
      c
        .buildCommands(
          job,
          { ...c.DEFAULTS, container: "mkv", audio, audioBitrate: 128 },
          { ffmpeg: "ffmpeg" },
          { output: "out.mkv" },
        )[0]
        .args.includes("-b:a"),
      false,
    );
  }
  assert.ok(
    c
      .validate({ ...c.DEFAULTS, audioBitrate: -1 })
      .some((e) => e.includes("码率")),
  );
});
test("rational fps and invalid values", () => {
  assert.equal(c.parseFps("59.94").text, "60000/1001");
  assert.equal(c.parseFps("source"), null);
  for (const x of ["", "0", "1/0", "241", "-30", "abc"])
    assert.throws(() => c.parseFps(x));
});
test("validation rejects incompatible formats, alpha and naming", () => {
  for (const patch of [
    { container: "webm" },
    { audio: "flac" },
    { nameTemplate: "../{name}" },
    { nameTemplate: "CON" },
    { fps: "0" },
    { bitDepth: 10, encoder: "h264_nvenc" },
  ])
    assert.ok(
      c.validate(
        { ...c.DEFAULTS, ...patch },
        { hasAlpha: false, width: 1920, height: 1080 },
      ).length,
    );
  assert.ok(
    c.validate({ ...c.DEFAULTS, alphaMask: true }, { hasAlpha: false }).length,
  );
  assert.deepEqual(
    c.validate(c.DEFAULTS, { hasAlpha: false, width: 1920, height: 1080 }),
    [],
  );
});
test("paired naming avoids original and either occupied output", () => {
  const s = { ...c.DEFAULTS, outputMode: "source", alphaMask: true };
  const r = c.outputPaths("C:\\a\\舞蹈.mp4", s, 1, (p) =>
    p.endsWith("舞蹈 (2)_alpha.mp4"),
  );
  assert.equal(r.output, "C:\\a\\舞蹈 (3).mp4");
  assert.equal(r.maskOutput, "C:\\a\\舞蹈 (3)_alpha.mp4");
});
test("powershell paths are safely literal", () =>
  assert.equal(c.quote("C:\\Bob's $file.mp4"), "'C:\\Bob''s $file.mp4'"));
test("same fps conversion used for main and mask; audio only main", () => {
  const m = c.buildCommands(
    {
      path: "C:\\in.mov",
      meta: { hasAlpha: true, audio: { codec: "pcm" }, fps: 60 },
    },
    { ...c.DEFAULTS, alphaMask: true, fps: "30" },
    { ffmpeg: "ffmpeg" },
    { output: "x.mp4", maskOutput: "x_alpha.mp4" },
  );
  assert.equal(m.length, 2);
  for (const x of m) assert.ok(x.args.join(" ").includes("fps=30"));
  assert.ok(m[1].args.includes("-an"));
  assert.ok(m[1].args.join(" ").includes("alphaextract"));
  assert.ok(m[0].args.includes("-n"));
});
test("metadata handles alpha, depth and rational frame rate", () => {
  const m = c.metadata({
    streams: [
      {
        codec_type: "video",
        width: 10,
        height: 10,
        avg_frame_rate: "60000/1001",
        r_frame_rate: "60000/1001",
        pix_fmt: "gbrap10le",
        codec_name: "ffv1",
      },
    ],
    format: { duration: "1", size: "100" },
  });
  assert.equal(m.bitDepth, 10);
  assert.equal(m.hasAlpha, true);
  assert.equal(m.fpsText, "60000/1001");
});
test("NVEncC preserves exact P presets, quality modes reject silent substitutions", () => {
  const j = {
    path: "a.mkv",
    meta: { width: 640, height: 360, hasAlpha: false },
  };
  const cmds = c.buildCommands(
    j,
    { ...c.DEFAULTS, encoder: "nvencc:hevc", preset: "p6" },
    { ffmpeg: "ffmpeg", nvencc: "NVEncC" },
    { output: "a.mp4" },
  );
  const nv = cmds.find((x) => x.exe === "NVEncC");
  assert.equal(nv.args[nv.args.indexOf("--preset") + 1], "P6");
  const ff = c.buildCommands(
    j,
    { ...c.DEFAULTS, encoder: "hevc_nvenc", preset: "P7" },
    { ffmpeg: "ffmpeg" },
    { output: "b.mp4" },
  )[0];
  assert.equal(ff.args[ff.args.indexOf("-preset") + 1], "p7");
  assert.ok(
    c.validate({
      ...c.DEFAULTS,
      encoder: "libsvtav1",
      preset: "6",
      rateControl: "qp",
    }).length,
  );
  assert.ok(c.validate({ ...c.DEFAULTS, quality: 60 }).length);
});
test("preview creates parent directory and protects every pipeline output before executing", () => {
  const text = c.commandText(
    [
      { exe: "ffmpeg", args: ["-n", "out.mp4"], output: "C:\\folder\\out.mp4" },
      {
        exe: "NVEncC",
        args: ["-o", "inter.mkv"],
        temporary: "C:\\folder\\inter.mkv",
      },
    ],
    { prepare: true },
  );
  assert.ok(text.includes("[System.IO.Directory]::CreateDirectory"));
  assert.ok(text.includes("Test-Path -LiteralPath 'C:\\folder\\inter.mkv'"));
});
test("VP9 alpha uses alpha-capable decoder explicitly", () => {
  const commands = c.buildCommands(
    {
      path: "alpha.webm",
      meta: { width: 640, height: 360, hasAlpha: true, codec: "vp9" },
    },
    { ...c.DEFAULTS, alphaMask: true },
    { ffmpeg: "ffmpeg" },
    { output: "out.mp4", maskOutput: "out_alpha.mp4" },
  );
  for (const c of commands) {
    assert.ok(c.args.indexOf("libvpx-vp9") > 0);
    assert.ok(c.args.indexOf("libvpx-vp9") < c.args.indexOf("-i"));
  }
});
test("name template uses display preset name and local calendar date", () => {
  const s = {
    ...c.DEFAULTS,
    preset: "p7",
    presetName: "收藏的 MMD",
    nameTemplate: "{name}_{preset}_{date}",
  };
  const date = {
    getFullYear: () => 2026,
    getMonth: () => 8,
    getDate: () => 17,
    toISOString: () => "2026-09-16T16:10:00Z",
  };
  const output = c.outputPaths(
    "C:\\in\\dance.mov",
    s,
    1,
    () => false,
    date,
  ).output;
  assert.match(output, /dance_收藏的 MMD_2026-09-17\.mp4$/);
});
test("source metadata maps packed, semiplanar and float bit depths", () => {
  for (const [pix_fmt, bitDepth] of [
    ["p010le", 10],
    ["rgb48le", 16],
    ["gbrapf32le", 32],
    ["x2rgb10le", 10],
  ]) {
    const m = c.metadata({
      streams: [{ codec_type: "video", pix_fmt }],
      format: {},
    });
    assert.equal(m.bitDepth, bitDepth, pix_fmt);
  }
});
test("video bitrate: stream value, MKV BPS tag, or total minus audio", () => {
  const v = {
    codec_type: "video",
    width: 16,
    height: 16,
    avg_frame_rate: "30/1",
    pix_fmt: "yuv420p",
  };
  const a = {
    codec_type: "audio",
    codec_name: "aac",
    sample_rate: "48000",
    channels: 2,
    bit_rate: "320000",
  };
  const meta = (streams, format = {}) => c.metadata({ streams, format });
  assert.equal(
    meta([{ ...v, bit_rate: "10080827" }, a]).videoBitRate,
    10080827,
  );
  assert.equal(
    meta([{ ...v, tags: { BPS: "5000000" } }, a]).videoBitRate,
    5000000,
  );
  assert.equal(meta([v, a], { bit_rate: "8320000" }).videoBitRate, 8000000);
  assert.equal(meta([v, a]).videoBitRate, 0);
});
