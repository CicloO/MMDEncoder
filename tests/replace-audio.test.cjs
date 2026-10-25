const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const { ff, fp } = require("./engines.cjs");

const streams = (file) =>
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
const run = (args) =>
  execFileSync(
    ff,
    args.filter((a, i, all) => a !== "-progress" && all[i - 1] !== "-progress"),
    { stdio: "pipe" },
  );

test("replacement audio: NVEncC packaging takes it as input 1, cut to the video", () => {
  const job = {
    path: "C:/v.avi",
    meta: {
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 4,
      codec: "rawvideo",
    },
    audioPath: "C:/song.wav",
    audioMeta: { codec: "pcm_s16le", sampleRate: 44100, channels: 2 },
    audioDuration: 200,
  };
  const s = {
    ...core.DEFAULTS,
    encoder: "nvencc:h264",
    preset: "p4",
    audio: "aac",
  };
  const cmds = core.buildCommands(
    job,
    s,
    { ffmpeg: "ff", nvencc: "nv" },
    { output: "C:/o.mp4" },
  );
  const pack = cmds[0].pipeTo.args;
  assert.deepEqual(pack.slice(pack.indexOf("-t"), pack.indexOf("-t") + 4), [
    "-t",
    "4.000000",
    "-i",
    "C:/song.wav",
  ]);
  assert.ok(!pack.includes("C:/v.avi"), "the video's own audio is not read");
  assert.equal(pack[pack.lastIndexOf("-map") + 1], "1:a:0");
  // Without a replacement nothing changes.
  const plain = core.buildCommands(
    {
      ...job,
      audioPath: undefined,
      meta: { ...job.meta, audio: job.audioMeta },
    },
    s,
    { ffmpeg: "ff", nvencc: "nv" },
    { output: "C:/o.mp4" },
  );
  assert.ok(plain[0].pipeTo.args.includes("1:a:0?"));
});

test(
  "replacement audio on the video page: a silent video gets the song, cut and faded at the video's end",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replace-audio-"));
    try {
      const video = path.join(dir, "video.mp4");
      run([
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=3",
        "-c:v",
        "libx264",
        video,
      ]);
      const song = path.join(dir, "song.wav");
      run([
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6,volume=8",
        song,
      ]);
      const meta = core.metadata(streams(video));
      assert.equal(meta.audio, undefined);
      const a = streams(song).streams[0];
      const out = path.join(dir, "out.mp4");
      const [cmd] = core.buildCommands(
        {
          path: video,
          meta,
          audioPath: song,
          audioMeta: core.audioInfo(a),
          audioDuration: Number(a.duration),
        },
        {
          ...core.DEFAULTS,
          encoder: "libx264",
          preset: "ultrafast",
          audio: "aac",
          audioFade: 0.5,
        },
        { ffmpeg: ff },
        { output: out },
      );
      run(cmd.args);
      const info = streams(out);
      const audio = info.streams.find((x) => x.codec_type === "audio");
      assert.equal(audio.codec_name, "aac");
      assert.ok(
        Math.abs(Number(audio.duration) - 3) < 0.1,
        "audio cut to the video: " + audio.duration,
      );
      // Faded out at the video's end, not the song's.
      assert.match(cmd.args.join(" "), /afade=t=out:st=2\.500000:d=0\.5/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
