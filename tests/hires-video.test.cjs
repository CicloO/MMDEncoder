const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { ff, fp } = require("./engines.cjs");
const core = require("../backend/core.cjs");

const audioOf = (file) =>
  JSON.parse(
    execFileSync(
      fp,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_streams",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  ).streams[0];
async function until(f) {
  for (let i = 0; i < 600 && !f(); i++)
    await new Promise((r) => setTimeout(r, 100));
}

test("Hi-Res needs FLAC or PCM; adding the setting does not mark built-ins as changed", () => {
  const s = { ...core.DEFAULTS, hiRes: true, audio: "aac" };
  assert.ok(core.validate(s).some((e) => e.includes("Hi-Res")));
  assert.deepEqual(
    core
      .validate({ ...s, audio: "flac", container: "mkv" })
      .filter((e) => e.includes("Hi-Res")),
    [],
  );
  // Settings saved by 1.4.2 recorded built-ins' fingerprints without hiRes.
  const shipped = core.BUILTINS[0];
  // 1.4.2 had neither hiRes nor editFriendly (nor upscaler, added later).
  const {
    hiRes,
    editFriendly,
    upscaler,
    audioFade,
    artcnnModel,
    maskFormat,
    ...before
  } = shipped.settings;
  assert.equal(upscaler, "lanczos");
  assert.equal(editFriendly, false);
  assert.equal(hiRes, false);
  assert.equal(maskFormat, "lossless");
  const old = crypto
    .createHash("sha256")
    .update(JSON.stringify([shipped.name, before]))
    .digest("hex")
    .slice(0, 16);
  assert.equal(
    old,
    require("./fixtures/i18n/preset-baseline.json").presets.find(
      (p) => p.id === shipped.id,
    ).fingerprint,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hires-fp-"));
  try {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(
      path.join(root, "data", "settings.json"),
      JSON.stringify({
        version: 1,
        settings: core.DEFAULTS,
        builtins: {
          [shipped.id]: {
            name: "我的 4K",
            base: old,
            settings: { ...before, quality: 25 },
          },
        },
      }),
    );
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(root, "data"),
      mmdPluginDll: "",
    });
    try {
      const st = svc.getState();
      assert.deepEqual(st.presetConflicts, [], "no update prompt");
      assert.equal(st.presets.find((p) => p.id === shipped.id).name, "我的 4K");
    } finally {
      svc.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "video page Hi-Res: FLAC in MKV and 24-bit PCM in MOV at twice 44.1 kHz",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hires-video-"));
    const input = path.join(dir, "clip.mp4");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=sample_rate=44100:duration=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      input,
    ]);
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const state = () => svc.getState();
    try {
      await until(() => state().located && !state().detecting);
      await svc.invoke("add", { paths: [input] });
      await until(() => state().jobs.every((j) => j.status !== "probing"));
      const base = {
        encoder: "libx264",
        outputMode: "source",
        nameTemplate: "{name}_{index}",
        resizeMode: "source",
        fps: "source",
        alphaMode: "discard",
        alphaMask: false,
      };
      for (const [audio, container, codec] of [
        ["flac", "mkv", "flac"],
        ["pcm_s16le", "mov", "pcm_s24le"],
      ]) {
        await svc.invoke("settings", {
          patch: { ...base, audio, container, hiRes: true },
        });
        if (state().jobs[0].status !== "ready")
          await svc.invoke("requeue", { id: state().jobs[0].id });
        await svc.invoke("start");
        await until(() => !state().running);
        const job = state().jobs[0];
        assert.equal(job.status, "done", job.error || job.log);
        const a = audioOf(job.output);
        assert.deepEqual(
          [
            a.codec_name,
            Number(a.sample_rate),
            Number(a.bits_per_raw_sample || a.bits_per_sample),
          ],
          [codec, 88200, 24],
        );
      }
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "MMD export with a Hi-Res preset: the cut WAV becomes 88.2 kHz / 24-bit FLAC",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hires-mmd-"));
    process.env.LOCALAPPDATA = path.join(root, "local");
    delete require.cache[require.resolve("../backend/mmd-export.cjs")];
    const mx = require("../backend/mmd-export.cjs");
    try {
      const wav = path.join(root, "music.wav");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=sample_rate=44100:duration=10",
        wav,
      ]);
      const pmm = path.join(root, "scene.pmm");
      fs.writeFileSync(
        pmm,
        Buffer.from("Polygon Movie maker 0002\0" + wav + "\0", "latin1"),
      );
      mx.writeConfig({
        settings: {
          ...core.DEFAULTS,
          encoder: "libx264",
          container: "mkv",
          audio: "flac",
          hiRes: true,
          resizeMode: "source",
        },
        presetName: "Hi-Res",
        engines: { ffmpeg: ff, ffprobe: fp },
        appExe: "",
        helper: "",
      });
      const avi = path.join(root, "out.avi");
      fs.writeFileSync(avi, "");
      const p = mx.plan({
        avi,
        width: 64,
        height: 64,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
      });
      const enc = spawn(p.exe, p.args, { stdio: ["pipe", "ignore", "ignore"] });
      const frame = Buffer.alloc(64 * 64 * 4, 0x80);
      for (let i = 0; i < 30; i++)
        if (!enc.stdin.write(frame))
          await new Promise((r) => enc.stdin.once("drain", r));
      enc.stdin.end();
      assert.equal(await new Promise((r) => enc.on("close", r)), 0);
      fs.rmSync(avi);
      const notes = [];
      const r = await mx.finish(
        {
          avi,
          temp: p.temp,
          output: p.output,
          frames: 30,
          avgTimePerFrame: 333333,
          startFrame: 30,
          pmm,
        },
        undefined,
        (m) => notes.push(m),
      );
      assert.equal(r.audio, "wav", notes.join("\n"));
      const a = audioOf(r.output);
      assert.deepEqual(
        [a.codec_name, Number(a.sample_rate), Number(a.bits_per_raw_sample)],
        ["flac", 88200, 24],
      );
      assert.match(
        notes.join("\n"),
        /Hi-Res：44\.1 kHz \/ 16-bit → 88\.2 kHz \/ 24-bit/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
