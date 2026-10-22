const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const media = require("../backend/media.cjs");
const trim = require("../backend/trim.cjs");
const { ff, fp } = require("./engines.cjs");

// Peak level (0–1) of a file's audio in a window, decoded as mono samples.
function peak(file, from, length) {
  const raw = execFileSync(ff, [
    "-v",
    "error",
    "-ss",
    String(from),
    "-t",
    String(length),
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-",
  ]);
  let max = 0;
  for (let i = 0; i + 1 < raw.length; i += 2)
    max = Math.max(max, Math.abs(raw.readInt16LE(i)));
  return max / 32768;
}
const duration = (file) =>
  Number(
    execFileSync(fp, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ]).toString(),
  );
// Faded at both ends, full in the middle.
function assertFaded(file, length) {
  assert.ok(peak(file, 0, 0.01) < 0.05, "start fades in");
  assert.ok(peak(file, length / 2, 0.2) > 0.3, "middle at full level");
  assert.ok(peak(file, length - 0.012, 0.01) < 0.05, "end fades out");
}

test("fade filters: both ends, at most half the length, joined with Hi-Res resampling", () => {
  assert.equal(
    media.fadeFilter(1, 10),
    "afade=t=in:st=0:d=1,afade=t=out:st=9.000000:d=1",
  );
  assert.equal(
    media.fadeFilter(2, 1),
    "afade=t=in:st=0:d=0.5,afade=t=out:st=0.500000:d=0.5",
  );
  assert.equal(media.fadeFilter(0, 10), "");
  assert.deepEqual(
    media.withAudioFilter(["-af", "aresample=96000", "-c:a", "flac"], "F"),
    ["-af", "F,aresample=96000", "-c:a", "flac"],
  );
  assert.ok(core.validate({ ...core.DEFAULTS, audioFade: 3 }).length);
  assert.throws(
    () =>
      media.command(
        {
          operation: "audio",
          input: "C:/a.mp4",
          output: "C:/a.mka",
          audioFormat: "copy",
          fade: 1,
          fadeLength: 5,
        },
        { ffmpeg: "ff" },
        "C:/t.mka",
      ),
    /复制原音轨时不能淡入淡出/,
  );
});

test(
  "audio fades for real on the video, media and trim pages",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fade-"));
    try {
      // 4 s of video with a loud steady tone.
      const src = path.join(dir, "src.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4,volume=8",
        "-c:v",
        "libx264",
        "-g",
        "30",
        "-c:a",
        "flac",
        src,
      ]);
      const meta = core.metadata(
        JSON.parse(
          execFileSync(fp, [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            src,
          ]),
        ),
      );
      // Video page.
      const videoOut = path.join(dir, "video.mkv");
      const [cmd] = core.buildCommands(
        { path: src, meta },
        {
          ...core.DEFAULTS,
          container: "mkv",
          audio: "flac",
          audioFade: 1,
          encoder: "libx264",
          preset: "ultrafast",
        },
        { ffmpeg: ff },
        { output: videoOut },
      );
      execFileSync(
        ff,
        cmd.args.filter(
          (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
        ),
        { stdio: "pipe" },
      );
      assertFaded(videoOut, duration(videoOut));
      // Media page: extract audio.
      const audioOut = path.join(dir, "audio.wav");
      const m = media.command(
        {
          operation: "audio",
          input: src,
          output: audioOut,
          audioFormat: "wav",
          fade: 0.5,
          fadeLength: 4,
        },
        { ffmpeg: ff },
        audioOut,
      );
      execFileSync(
        ff,
        m.args.filter(
          (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
        ),
        { stdio: "pipe" },
      );
      assertFaded(audioOut, 4);
      // Trim page: two segments joined, faded only at the ends of the result.
      const idx = await trim.index({ ffmpeg: ff, ffprobe: fp }, src);
      const trimOut = path.join(dir, "trim.mkv");
      await trim.cut(
        { ffmpeg: ff, ffprobe: fp },
        [
          { file: src, idx, from: 0, to: 30 },
          { file: src, idx, from: 60, to: 90 },
        ],
        trimOut,
        { audio: { mode: "reencode", codec: "pcm", fade: 0.5 } },
      );
      assertFaded(trimOut, 2);
      // The join at 1 s is not faded.
      assert.ok(peak(trimOut, 0.95, 0.1) > 0.3, "join stays at full level");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
