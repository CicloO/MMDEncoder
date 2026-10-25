require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process");
const core = require("../backend/core.cjs");
const media = require("../backend/media.cjs");
const { createService } = require("../backend/service.cjs");
const { ff, fp } = require("./engines.cjs");
test("every concrete AAC/Opus bitrate reaches CPU and three-stage NVEncC mux commands; zero is rejected without mapping", () => {
  for (const audio of ["aac", "libopus"])
    for (const encoder of ["libx264", "nvencc:hevc"])
      for (const audioBitrate of [64, 96, 128, 160, 192, 256, 320, 384, 512]) {
        const s = {
          ...core.DEFAULTS,
          container: "mkv",
          audio,
          encoder,
          preset: encoder.startsWith("nvencc:") ? "p4" : "medium",
          audioBitrate,
        };
        const c = core.buildCommands(
          {
            path: "a.mkv",
            meta: { width: 320, height: 180, audio: { channels: 2 } },
          },
          s,
          { ffmpeg: "ff", nvencc: "nv" },
          { output: "out.mkv" },
        )[0];
        const a = (c.pipeTo || c).args;
        assert.equal(a[a.indexOf("-b:a") + 1], audioBitrate + "k");
      }
  assert.equal(core.DEFAULTS.audioBitrate, 320);
  assert.ok(
    core
      .validateIssues({ ...core.DEFAULTS, audioBitrate: 0 })
      .some((i) => i.code === "AUDIO_BITRATE_INVALID"),
  );
  assert.throws(() =>
    core.buildCommands(
      { path: "a", meta: {} },
      { ...core.DEFAULTS, audioBitrate: 0 },
      { ffmpeg: "ff" },
      { output: "out.mp4" },
    ),
  );
  // The audio/video tools' zero means follow source and remains independent.
  assert.equal(
    media.audioBitrate(0, "aac", { codec: "aac", bitRate: 128000 }),
    128,
  );
  assert.equal(media.audioBitrate(0, "aac", { codec: "pcm_s16le" }), 320);
});
test("new personal presets default to 320 and imports with zero are refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitrate-preset-"));
  const svc = createService({ dataDir: dir, mmdPluginDll: "" });
  t.after(() => {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await svc.invoke("savePreset", { name: "New 320" });
  assert.equal(
    svc.getState().presets.find((p) => p.name === "New 320").settings
      .audioBitrate,
    320,
  );
  const count = svc.getState().presets.length;
  await assert.rejects(() =>
    svc.invoke("importPresets", {
      presets: [
        { name: "Old zero", settings: { ...core.DEFAULTS, audioBitrate: 0 } },
      ],
    }),
  );
  assert.equal(svc.getState().presets.length, count);
});
test(
  "representative AAC default 320 and explicit Opus commands produce readable audio",
  { timeout: 30000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitrate-real-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "source.mkv");
    cp.execFileSync(
      ff,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=0.5",
        "-f",
        "lavfi",
        "-i",
        "sine=r=48000:d=0.5",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        source,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    for (const [audio, audioBitrate] of [
      ["aac", 320],
      ["libopus", 128],
    ]) {
      const output = path.join(dir, audio + ".mkv");
      const c = core.buildCommands(
        {
          path: source,
          meta: {
            width: 320,
            height: 180,
            fps: 30,
            duration: 0.5,
            audio: { channels: 1, sampleRate: 48000 },
          },
        },
        {
          ...core.DEFAULTS,
          container: "mkv",
          preset: "veryfast",
          audio,
          audioBitrate,
        },
        { ffmpeg: ff },
        { output },
      )[0];
      cp.execFileSync(c.exe, c.args, { windowsHide: true, stdio: "pipe" });
      const info = JSON.parse(
        cp.execFileSync(
          fp,
          ["-v", "error", "-show_streams", "-of", "json", output],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      assert.equal(
        info.streams.find((x) => x.codec_type === "audio").codec_name,
        audio === "aac" ? "aac" : "opus",
      );
    }
  },
);
