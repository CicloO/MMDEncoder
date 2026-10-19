const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const { ff, fp } = require("./engines.cjs");

// Each test gets its own LOCALAPPDATA so mmd-export.json stays out of the real one.
function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-export-"));
  process.env.LOCALAPPDATA = path.join(root, "local");
  delete require.cache[require.resolve("../backend/mmd-export.cjs")];
  return { root, mx: require("../backend/mmd-export.cjs") };
}
const preset = (id) => core.BUILTINS.find((p) => p.id === id);

test("frame rates from AvgTimePerFrame and presets the live export cannot use", () => {
  const { mx } = fresh();
  assert.equal(mx.frameRate(166666).text, "60");
  assert.equal(mx.frameRate(333333).text, "30");
  assert.equal(mx.frameRate(333667).text, "30000/1001");
  assert.equal(mx.unsupported(preset("builtin-4k").settings), "");
  assert.match(
    mx.unsupported({
      ...preset("builtin-4k").settings,
      encoder: "nvencc:hevc",
    }),
    /NVEncC/,
  );
  assert.match(
    mx.unsupported(preset("builtin-alpha-mask").settings),
    /分离 Alpha/,
  );
});

test(
  "MMD export: raw frames encode with the preset, WAV is cut sample-exactly, placeholder AVI removed",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const { root, mx } = fresh();
    try {
      // Project music in a folder with Chinese characters; the .pmm stores the
      // path in GBK like the Chinese MMD build ("测试" = B2E2 CAD4).
      const musicDir = path.join(root, "测试");
      fs.mkdirSync(musicDir);
      const wav = path.join(musicDir, "music.wav");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=30",
        wav,
      ]);
      const pmm = path.join(root, "scene.pmm");
      fs.writeFileSync(
        pmm,
        Buffer.concat([
          Buffer.from("Polygon Movie maker 0002\0\0\0\0", "latin1"),
          Buffer.from(root + "\\", "latin1"),
          Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
          Buffer.from("\\music.wav\0\0\0\0", "latin1"),
        ]),
      );
      assert.equal(mx.projectWav(pmm), wav);

      const settings = {
        ...preset("builtin-1080-sw").settings,
        resizeMode: "source",
      };
      mx.writeConfig({
        settings,
        presetName: "默认 1080p · CPU",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: process.execPath,
        helper: path.resolve(__dirname, "../backend/mmd-export.cjs"),
      });

      // MMD's placeholder AVI: raw video tagged MMDE, as the plugin produces.
      const avi = path.join(root, "导出.avi");
      // FFmpeg ignores tag overrides for raw AVI, so write FFV1 and patch its
      // FOURCC (stream handler and bitmap compression) to MMDE.
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=16x16:r=60:d=1",
        "-c:v",
        "ffv1",
        avi,
      ]);
      const bytes = fs.readFileSync(avi);
      for (
        let i = bytes.indexOf("FFV1");
        i >= 0 && i < 4096;
        i = bytes.indexOf("FFV1", i + 4)
      )
        bytes.write("MMDE", i, "latin1");
      fs.writeFileSync(avi, bytes);
      const width = 320,
        height = 240,
        frames = 60;
      const p = mx.plan({
        avi,
        width,
        height,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 166666,
      });
      assert.equal(p.output, path.join(root, "导出.mp4"));
      assert.ok(
        p.args.includes("bgra") &&
          p.args.includes("320x240") &&
          p.args.includes("60"),
      );
      assert.match(p.args[p.args.indexOf("-vf") + 1], /^vflip,/);
      assert.ok(!p.args.includes("-progress"));

      // Feed raw BGRA frames the way the plugin writes them to stdin.
      const enc = spawn(p.exe, p.args, { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      enc.stderr.on("data", (d) => (err += d));
      const frame = Buffer.alloc(width * height * 4, 0x80);
      for (let i = 0; i < frames; i++)
        if (!enc.stdin.write(frame))
          await new Promise((r) => enc.stdin.once("drain", r));
      enc.stdin.end();
      const code = await new Promise((r) => enc.on("close", r));
      assert.equal(code, 0, err);

      const notes = [];
      // Export started at timeline frame 300 (10 s on the 30 fps timeline).
      const r = await mx.finish(
        {
          avi,
          temp: p.temp,
          output: p.output,
          frames,
          avgTimePerFrame: 166666,
          startFrame: 300,
          pmm,
        },
        mx.readConfig(),
        (m) => notes.push(m),
      );
      assert.equal(r.audio, "wav", notes.join("\n"));
      assert.ok(r.aviDeleted && !fs.existsSync(avi), "placeholder AVI removed");
      assert.ok(!fs.existsSync(p.temp), "temporary video removed");
      const info = JSON.parse(
        execFileSync(
          fp,
          ["-v", "error", "-show_streams", "-of", "json", p.output],
          { encoding: "utf8" },
        ),
      );
      const v = info.streams.find((s) => s.codec_type === "video");
      const a = info.streams.find((s) => s.codec_type === "audio");
      assert.equal(v.codec_name, "h264");
      assert.equal(Number(v.nb_frames), frames);
      assert.equal(a.codec_name, "aac");
      // 60 frames at 60 fps = 1 s of audio (AAC adds encoder padding).
      assert.ok(
        Math.abs(Number(a.duration) - 1) < 0.05,
        "audio length " + a.duration,
      );
      assert.match(notes.join("\n"), /采样点 441000–485100/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "an AVI that is not a placeholder is never deleted",
  { skip: !fs.existsSync(ff), timeout: 60000 },
  async () => {
    const { root, mx } = fresh();
    try {
      mx.writeConfig({
        settings: { ...preset("builtin-1080-sw").settings, audio: "none" },
        presetName: "x",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const avi = path.join(root, "real.avi");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=16x16:r=30:d=1",
        "-c:v",
        "mjpeg",
        avi,
      ]);
      const temp = path.join(root, ".real.mmdencoder-video.mp4");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=64x64:r=30:d=1",
        "-c:v",
        "libx264",
        temp,
      ]);
      const r = await mx.finish(
        {
          avi,
          temp,
          output: path.join(root, "real.mp4"),
          frames: 30,
          avgTimePerFrame: 333333,
          startFrame: 0,
          pmm: "",
        },
        mx.readConfig(),
      );
      assert.equal(r.aviDeleted, false);
      assert.ok(fs.existsSync(avi));
      assert.equal(r.audio, "none");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "audio fade in and out over the cut WAV clip",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const { root, mx } = fresh();
    try {
      const wav = path.join(root, "music.wav");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=30",
        wav,
      ]);
      const pmm = path.join(root, "scene.pmm");
      fs.writeFileSync(
        pmm,
        Buffer.from("Polygon Movie maker 0002\0" + wav + "\0", "latin1"),
      );
      mx.writeConfig({
        settings: { ...preset("builtin-1080-sw").settings, audio: "flac" },
        presetName: "x",
        audioFade: 0.5,
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const temp = path.join(root, ".clip.mmdencoder-video.mp4");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=64x64:r=60:d=2",
        "-c:v",
        "libx264",
        temp,
      ]);
      const output = path.join(root, "clip.mp4");
      const notes = [];
      const r = await mx.finish(
        {
          avi: path.join(root, "missing.avi"),
          temp,
          output,
          frames: 120,
          avgTimePerFrame: 166666,
          startFrame: 300,
          pmm,
        },
        mx.readConfig(),
        (m) => notes.push(m),
      );
      assert.equal(r.audio, "wav");
      assert.ok(notes.some((n) => n.includes("淡入淡出 0.5 秒")));
      const peak = (start, dur) => {
        const out = require("node:child_process").spawnSync(
          ff,
          [
            "-v",
            "info",
            "-i",
            output,
            "-vn",
            "-af",
            `atrim=${start}:${start + dur},volumedetect`,
            "-f",
            "null",
            "-",
          ],
          { encoding: "utf8" },
        ).stderr;
        return Number(/max_volume: (-?[\d.]+) dB/.exec(out)?.[1] ?? -999);
      };
      const head = peak(0, 0.05),
        middle = peak(0.9, 0.2),
        tail = peak(1.95, 0.05);
      assert.ok(
        middle - head > 12,
        `fade in: start ${head} dB vs middle ${middle} dB`,
      );
      assert.ok(
        middle - tail > 12,
        `fade out: end ${tail} dB vs middle ${middle} dB`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
