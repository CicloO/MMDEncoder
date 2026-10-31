require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const media = require("../backend/media.cjs");
const { compatibility } = require("../backend/compatibility.cjs");
const { validateIssues } = require("../backend/settings-validation.cjs");
const mmdExport = require("../backend/mmd-export.cjs");
const { ff, fp } = require("./engines.cjs");

const settings = (patch) => ({
  ...core.DEFAULTS,
  encoder: "libx264",
  preset: "ultrafast",
  ...patch,
});
const meta = (codec) => ({
  width: 64,
  height: 64,
  fps: 30,
  duration: 1,
  audio: { codec, sampleRate: 48000, channels: 2 },
});
const codes = (s) => validateIssues(s).map((issue) => issue.code);

test("copy is a valid encode audio choice in MP4, MOV and MKV, but not WebM", () => {
  for (const container of ["mp4", "mov", "mkv"])
    assert.deepEqual(codes(settings({ container, audio: "copy" })), []);
  assert.ok(
    codes(settings({ container: "webm", audio: "copy" })).includes(
      "WEBM_AUDIO_UNSUPPORTED",
    ),
  );
});

test("copy cannot fade or go Hi-Res, and the fade conflict offers a fix", () => {
  const faded = settings({ container: "mkv", audio: "copy", audioFade: 1 });
  assert.ok(codes(faded).includes("AUDIO_COPY_FADE"));
  const fix = compatibility(faded).suggestions.find(
    (x) => x.id === "copy-fade",
  );
  assert.deepEqual(fix.patch, { audioFade: 0 });
  assert.ok(
    codes(settings({ container: "mkv", audio: "copy", hiRes: true })).includes(
      "HIRES_AUDIO_FORMAT_INVALID",
    ),
  );
});

test("copied audio maps the source track with -c:a copy and no bitrate or filter", () => {
  const [cmd] = core.buildCommands(
    { path: "C:/in.mp4", meta: meta("aac") },
    settings({ container: "mp4", audio: "copy" }),
    { ffmpeg: "ffmpeg" },
    { output: "C:/out.mp4" },
  );
  const i = cmd.args.indexOf("-c:a");
  assert.equal(cmd.args[i + 1], "copy");
  assert.ok(!cmd.args.includes("-b:a"));
  assert.ok(!cmd.args.includes("-af"));
});

test("copy refuses replacement audio and codecs the container cannot hold", () => {
  const build = (job, container) =>
    core.buildCommands(
      job,
      settings({ container, audio: "copy" }),
      { ffmpeg: "ffmpeg" },
      { output: "C:/out." + container },
    );
  assert.throws(
    () =>
      build(
        {
          path: "C:/in.mp4",
          meta: meta("aac"),
          audioPath: "C:/song.flac",
          audioMeta: { codec: "flac", sampleRate: 48000, channels: 2 },
          audioDuration: 1,
        },
        "mkv",
      ),
    { code: "AUDIO_COPY_REPLACEMENT" },
  );
  assert.throws(
    () => build({ path: "C:/in.mov", meta: meta("pcm_s16le") }, "mp4"),
    {
      code: "AUDIO_COPY_CONTAINER",
    },
  );
  assert.doesNotThrow(() =>
    build({ path: "C:/in.mov", meta: meta("pcm_s16le") }, "mov"),
  );
  assert.equal(media.copyFits("mp4", "flac"), true);
  assert.equal(media.copyFits("mov", "opus"), false);
  assert.equal(media.copyFits("mkv", "pcm_s24le"), true);
});

test("MMD export writes copied PCM as PCM, or AAC in MP4", () => {
  const args = (container) =>
    mmdExport.audioArgs({ ...core.DEFAULTS, audio: "copy", container });
  assert.deepEqual(args("mov"), ["-c:a", "pcm_s16le"]);
  assert.deepEqual(args("mkv"), ["-c:a", "pcm_s16le"]);
  assert.equal(args("mp4")[1], "aac");
  assert.ok(args("mp4").includes("-b:a"));
});

test("a real copy keeps the source audio packets bit for bit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-copy-"));
  try {
    const src = path.join(dir, "src.mp4");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=64x64:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      src,
    ]);
    const probe = (file) =>
      JSON.parse(
        execFileSync(fp, [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ]),
      );
    const out = path.join(dir, "out.mp4");
    const [cmd] = core.buildCommands(
      { path: src, meta: core.metadata(probe(src)) },
      settings({ container: "mp4", audio: "copy" }),
      { ffmpeg: ff },
      { output: out },
    );
    execFileSync(
      ff,
      cmd.args.filter(
        (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
      ),
      { stdio: "pipe" },
    );
    const hash = (file) =>
      execFileSync(ff, [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-f",
        "md5",
        "-",
      ]).toString();
    assert.equal(hash(out), hash(src));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
