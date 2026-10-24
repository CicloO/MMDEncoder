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

test("frame rates from AvgTimePerFrame and presets the live export can use", () => {
  const { mx } = fresh();
  assert.equal(mx.frameRate(166666).text, "60");
  assert.equal(mx.frameRate(333333).text, "30");
  assert.equal(mx.frameRate(333667).text, "30000/1001");
  // Every preset works in the live export, NVEncC ones too (mmd-pipe.cjs).
  for (const s of [
    preset("builtin-4k").settings,
    preset("builtin-alpha-mask").settings,
    { ...preset("builtin-4k").settings, encoder: "nvencc:hevc" },
  ])
    assert.equal(mx.unsupported(s), "");
});

test("NVEncC presets: MMD's frames go through FFmpeg to NVEncC, then into the container", () => {
  const { root, mx } = fresh();
  const engines = {
    ffmpeg: "C:/t/ffmpeg.exe",
    ffprobe: "C:/t/ffprobe.exe",
    nvencc: "C:/t/NVEncC.exe",
  };
  const runtime = {
    avi: path.join(root, "render.avi"),
    width: 640,
    height: 360,
    bits: 32,
    bottomUp: true,
    avgTimePerFrame: 333333,
  };
  for (const maskMode of ["off", "with"]) {
    mx.writeConfig({
      settings: { ...preset("builtin-4k").settings, encoder: "nvencc:hevc" },
      presetName: "NVEncC",
      maskMode,
      engines,
      appExe: "C:/app/MMDEncoder.exe",
      helper: "C:/app/mmd-export.cjs",
    });
    const p = mx.plan(runtime);
    assert.equal(p.exe, "C:/app/MMDEncoder.exe");
    assert.ok(p.args[0].endsWith("mmd-pipe.cjs"));
    assert.equal(p.env.ELECTRON_RUN_AS_NODE, "1");
    const job = JSON.parse(p.env.MMD_PIPE_JOB);
    const [encode, mux] = job.steps;
    assert.equal(encode.exe, engines.nvencc);
    const from = encode.pipeFrom.args;
    assert.equal(encode.pipeFrom.exe, engines.ffmpeg);
    assert.ok(from.includes("rawvideo") && from.includes("bgra"));
    assert.equal(from.indexOf("pipe:0"), from.lastIndexOf("pipe:0"));
    if (maskMode === "with") {
      assert.match(
        from[from.indexOf("-filter_complex") + 1],
        /^\[0:v\]vflip,split/,
      );
      assert.ok(p.maskOutput);
    } else assert.match(from[from.indexOf("-vf") + 1], /^vflip,/);
    // The container step reads only NVEncC's file: no pipe, no progress.
    assert.equal(mux.exe, engines.ffmpeg);
    assert.ok(!mux.args.includes("pipe:0") && !mux.args.includes("-progress"));
    assert.equal(mux.args.at(-1), p.temp);
    assert.equal(job.temporary.length, 1);
  }
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
        rangeSuffix: false,
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
        rangeSuffix: false,
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
        rangeSuffix: false,
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

// Writes a placeholder AVI like MMD's (FFV1 with its FOURCC patched to MMDE).
function placeholderAvi(file) {
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=16x16:r=60:d=1",
    "-c:v",
    "ffv1",
    file,
  ]);
  const bytes = fs.readFileSync(file);
  for (
    let i = bytes.indexOf("FFV1");
    i >= 0 && i < 4096;
    i = bytes.indexOf("FFV1", i + 4)
  )
    bytes.write("MMDE", i, "latin1");
  fs.writeFileSync(file, bytes);
}
// Runs a plan with BGRA frames whose alpha is 255 on the left half, 0 on the
// right (or 255 everywhere when opaque).
async function render(p, width, height, frames, opaque = false) {
  const enc = spawn(p.exe, p.args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  enc.stderr.on("data", (d) => (err += d));
  const frame = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      frame.set([0x20, 0x40, 0xc0, opaque || x < width / 2 ? 255 : 0], i);
    }
  for (let i = 0; i < frames; i++)
    if (!enc.stdin.write(frame))
      await new Promise((r) => enc.stdin.once("drain", r));
  enc.stdin.end();
  assert.equal(await new Promise((r) => enc.on("close", r)), 0, err);
}
const grayAt = (file, x) =>
  execFileSync(ff, [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=w=2:h=2:x=${x}:y=100,format=gray`,
    "-f",
    "rawvideo",
    "-",
  ])[0];

test(
  "alpha mask option: one FFmpeg writes the video and a lossless _alpha mask; mask-only presets write just the mask",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const { root, mx } = fresh();
    try {
      const width = 320,
        height = 240,
        frames = 30;
      mx.writeConfig({
        rangeSuffix: false,
        settings: {
          ...preset("builtin-1080-sw").settings,
          resizeMode: "source",
          audio: "none",
        },
        presetName: "x",
        maskMode: "with",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const avi = path.join(root, "舞台 A.avi");
      placeholderAvi(avi);
      const runtime = {
        avi,
        width,
        height,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
      };
      const p = mx.plan(runtime);
      assert.equal(p.maskOutput, path.join(root, "舞台 A_alpha.mp4"));
      assert.equal(
        p.args.filter((a) => a === "pipe:0").length,
        1,
        "frames are read once",
      );
      assert.ok(
        p.args[p.args.indexOf("-filter_complex") + 1].startsWith(
          "[0:v]vflip,split=2",
        ),
      );
      await render(p, width, height, frames);
      const notes = [];
      const r = await mx.finish(
        {
          avi,
          temp: p.temp,
          output: p.output,
          frames,
          avgTimePerFrame: 333333,
          startFrame: 0,
          pmm: "",
        },
        mx.readConfig(),
        (m) => notes.push(m),
      );
      assert.equal(r.mask, p.maskOutput, notes.join(" | "));
      assert.ok(
        !fs.existsSync(p.maskTemp) &&
          !fs.existsSync(p.temp) &&
          !fs.existsSync(avi),
      );
      const info = (file) =>
        JSON.parse(
          execFileSync(
            fp,
            ["-v", "error", "-show_streams", "-of", "json", file],
            { encoding: "utf8" },
          ),
        ).streams;
      const [m] = info(r.mask);
      assert.equal(m.codec_name, "h264");
      assert.equal(m.profile, "High 4:4:4 Predictive", "lossless mask");
      assert.equal(Number(m.nb_frames), frames);
      assert.ok(
        grayAt(r.mask, 40) > 230 && grayAt(r.mask, 280) < 20,
        "white where opaque, black where transparent",
      );
      assert.equal(info(r.output)[0].codec_name, "h264");

      // Nothing transparent anywhere: the all-white mask is still kept (the user decides).
      const opaqueAvi = path.join(root, "opaque.avi");
      placeholderAvi(opaqueAvi);
      const po = mx.plan({ ...runtime, avi: opaqueAvi });
      await render(po, width, height, frames, true);
      const opaqueNotes = [];
      const ro = await mx.finish(
        {
          avi: opaqueAvi,
          temp: po.temp,
          output: po.output,
          frames,
          avgTimePerFrame: 333333,
          startFrame: 0,
          pmm: "",
        },
        mx.readConfig(),
        (m) => opaqueNotes.push(m),
      );
      assert.equal(ro.mask, po.maskOutput, opaqueNotes.join(" | "));
      assert.ok(fs.existsSync(po.maskOutput) && !fs.existsSync(po.maskTemp));
      assert.ok(fs.existsSync(po.output), "the video itself is kept");
      assert.ok(
        grayAt(po.maskOutput, 40) > 230 && grayAt(po.maskOutput, 280) > 230,
        "all white",
      );

      // RGB24 frames carry no alpha: the export goes on without the mask.
      const p24 = mx.plan({ ...runtime, bits: 24 });
      assert.equal(p24.maskOutput, undefined);
      assert.match(p24.notes.join(), /没有提供 Alpha/);

      // Mask-only preset: the output is the mask itself, named _alpha, no audio.
      mx.writeConfig({
        rangeSuffix: false,
        settings: { ...preset("builtin-4k").settings, alphaMode: "mask" },
        presetName: "mask",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const avi2 = path.join(root, "only.avi");
      placeholderAvi(avi2);
      const q = mx.plan({ ...runtime, avi: avi2 });
      assert.equal(q.output, path.join(root, "only_alpha.mp4"));
      assert.equal(q.maskOutput, undefined);
      await render(q, width, height, frames);
      const r2 = await mx.finish(
        {
          avi: avi2,
          temp: q.temp,
          output: q.output,
          frames,
          avgTimePerFrame: 333333,
          startFrame: 0,
          pmm: "",
        },
        mx.readConfig(),
      );
      assert.equal(r2.audio, "none");
      assert.deepEqual(
        info(r2.output).map((s) => s.codec_type),
        ["video"],
      );
      assert.ok(grayAt(r2.output, 40) > 230 && grayAt(r2.output, 280) < 20);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "export snapshot: finish uses the settings it started with, never overwrites, and a cut-off export can be finished or dropped",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const { root, mx } = fresh();
    try {
      const width = 160,
        height = 120,
        frames = 12;
      mx.writeConfig({
        rangeSuffix: false,
        settings: {
          ...preset("builtin-1080-sw").settings,
          resizeMode: "source",
          audio: "none",
        },
        presetName: "x",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const runtime = (avi) => ({
        avi,
        width,
        height,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
        pmm: "",
        startFrame: 0,
      });
      const job = (p, avi) => ({
        avi,
        temp: p.temp,
        output: p.output,
        frames,
        avgTimePerFrame: 333333,
        startFrame: 0,
        pmm: "",
      });

      // The settings travel with the export: finish works without the
      // current config, and a file that took the name meanwhile is kept.
      const avi = path.join(root, "a.avi");
      placeholderAvi(avi);
      const p = mx.plan(runtime(avi));
      assert.ok(fs.existsSync(mx.snapshotPath(p.temp)));
      await render(p, width, height, frames);
      fs.rmSync(mx.configPath());
      fs.writeFileSync(p.output, "KEEP");
      const notes = [];
      const r = await mx.finish(job(p, avi), undefined, (m) => notes.push(m));
      assert.equal(r.output, path.join(root, "a (2).mp4"), notes.join(" | "));
      assert.equal(fs.readFileSync(p.output, "utf8"), "KEEP");
      assert.ok(!fs.existsSync(mx.snapshotPath(p.temp)), "snapshot removed");
      assert.deepEqual(mx.interrupted(), []);

      // MMD gone mid-render: the frames written so far can be finished later.
      mx.writeConfig({
        rangeSuffix: false,
        settings: {
          ...preset("builtin-1080-sw").settings,
          resizeMode: "source",
          audio: "none",
        },
        presetName: "x",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const dead = (q) => {
        const file = mx.snapshotPath(q.temp);
        const snap = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...snap, mmdPid: 2 ** 30 }));
      };
      const b = path.join(root, "b.avi");
      const q = mx.plan(runtime(b));
      await render(q, width, height, frames);
      assert.deepEqual(mx.interrupted(), [], "MMD still running");
      dead(q);
      const [cut] = mx.interrupted();
      assert.equal(cut.output, q.output);
      const rec = await mx.recover(cut.id);
      assert.equal(rec.output, q.output);
      assert.ok(!fs.existsSync(q.temp));
      assert.deepEqual(mx.interrupted(), []);

      const c = path.join(root, "c.avi");
      const d = mx.plan(runtime(c));
      await render(d, width, height, frames);
      dead(d);
      mx.discard(mx.interrupted()[0].id);
      assert.ok(!fs.existsSync(d.temp) && !fs.existsSync(d.output));
      assert.deepEqual(mx.interrupted(), []);
      assert.throws(() => mx.discard("../x"), /无效/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the rendered video sets the length: short or missing WAV audio never drops frames",
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
        rangeSuffix: false,
        settings: {
          ...preset("builtin-1080-sw").settings,
          resizeMode: "source",
        },
        presetName: "x",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const width = 160,
        height = 120,
        frames = 90; // 3 s at 30 fps
      const exportAt = async (name, startFrame) => {
        const avi = path.join(root, name + ".avi");
        placeholderAvi(avi);
        const p = mx.plan({
          avi,
          width,
          height,
          bits: 32,
          bottomUp: true,
          avgTimePerFrame: 333333,
        });
        await render(p, width, height, frames);
        const notes = [];
        const r = await mx.finish(
          {
            avi,
            temp: p.temp,
            output: p.output,
            frames,
            avgTimePerFrame: 333333,
            startFrame,
            pmm,
          },
          undefined,
          (m) => notes.push(m),
        );
        const streams = JSON.parse(
          execFileSync(
            fp,
            [
              "-v",
              "error",
              "-count_packets",
              "-show_streams",
              "-of",
              "json",
              r.output,
            ],
            { encoding: "utf8" },
          ),
        ).streams;
        return { r, notes, streams, temp: p.temp };
      };
      // 29 s into a 30 s song: 1 s of music, 3 s of video.
      const short = await exportAt("short", 870);
      const v = short.streams.find((s) => s.codec_type === "video");
      const a = short.streams.find((s) => s.codec_type === "audio");
      assert.equal(Number(v.nb_read_packets), frames, short.notes.join("\n"));
      assert.equal(short.r.audio, "wav");
      assert.ok(
        Math.abs(Number(a.duration) - 3) < 0.05,
        "audio padded to 3 s, got " + a.duration,
      );
      assert.ok(!fs.existsSync(short.temp));
      // Starting after the song ends: no audio, every frame kept.
      const past = await exportAt("past", 960);
      assert.equal(past.r.audio, "none");
      assert.match(past.notes.join("\n"), /超过工程 WAV 的结尾/);
      assert.equal(
        Number(
          past.streams.find((s) => s.codec_type === "video").nb_read_packets,
        ),
        frames,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "MMD frame range in the name (_0400-0444f) and in the file's tag, mask named alike",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const { root, mx } = fresh();
    try {
      mx.writeConfig({
        settings: {
          ...preset("builtin-1080-sw").settings,
          resizeMode: "source",
          audio: "none",
        },
        presetName: "x",
        maskMode: "with",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const avi = path.join(root, "舞台.avi");
      placeholderAvi(avi);
      const runtime = {
        avi,
        width: 160,
        height: 120,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 166667,
        startFrame: 400,
      };
      const p = mx.plan(runtime);
      await render(p, 160, 120, 90);
      const r = await mx.finish(
        {
          avi,
          temp: p.temp,
          output: p.output,
          frames: 90,
          avgTimePerFrame: 166667,
          startFrame: 400,
          pmm: "",
        },
        undefined,
      );
      // 90 frames at 60 fps = 45 MMD frames: 400–444.
      assert.equal(r.output, path.join(root, "舞台_0400-0444f.mp4"));
      assert.equal(r.mask, path.join(root, "舞台_0400-0444f_alpha.mp4"));
      const tags = JSON.parse(
        execFileSync(
          fp,
          [
            "-v",
            "error",
            "-show_entries",
            "format_tags=comment",
            "-of",
            "json",
            r.output,
          ],
          { encoding: "utf8" },
        ),
      ).format.tags;
      const tag = require("../backend/core.cjs").readTag(tags.comment);
      assert.equal(tag.mmd.start, 400);
      assert.equal(tag.enc.encoder, "libx264");
      assert.equal(tag.enc.quality, 21);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
