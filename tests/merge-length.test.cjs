const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const media = require("../backend/media.cjs");
const { ff, fp } = require("./engines.cjs");

// Each stream's length; MKV keeps it in the DURATION tag (hh:mm:ss.fff…).
const seconds = (t) =>
  t ? t.split(":").reduce((a, v) => a * 60 + Number(v), 0) : NaN;
const lengths = (file) =>
  Object.fromEntries(
    JSON.parse(
      execFileSync(fp, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,duration:stream_tags=DURATION",
        "-of",
        "json",
        file,
      ]),
    ).streams.map((s) => [
      s.codec_type,
      Number(s.duration) || seconds(s.tags?.DURATION),
    ]),
  );
const strip = (a) =>
  a.filter((x, i, all) => x !== "-progress" && all[i - 1] !== "-progress");

test(
  "a merge lasts as long as the video: longer audio is cut, shorter audio padded with silence",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-length-"));
    try {
      const video = path.join(dir, "video.mp4");
      execFileSync(ff, [
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
      const audio = (name, d) => {
        const f = path.join(dir, name);
        execFileSync(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=440:duration=${d}`,
          f,
        ]);
        return f;
      };
      const long = audio("long.wav", 6),
        short = audio("short.wav", 1),
        shortAac = path.join(dir, "short.m4a");
      execFileSync(ff, ["-v", "error", "-i", short, "-c:a", "aac", shortAac]);
      const merge = (audioInput, audioFormat, name) => {
        const output = path.join(dir, name);
        const p = {
          operation: "merge",
          input: video,
          audioInput,
          audioFormat,
          container: "mkv",
          videoDuration: 3,
          fade: 0,
          output,
        };
        execFileSync(ff, strip(media.command(p, { ffmpeg: ff }, output).args), {
          stdio: "pipe",
        });
        return lengths(output);
      };
      const near = (a, b, what) =>
        assert.ok(Math.abs(a - b) < 0.1, `${what}: ${a} ≠ ${b}`);
      let l = merge(long, "aac", "long.mkv");
      near(l.video, 3, "video kept");
      near(l.audio, 3, "longer audio cut at the video's end");
      l = merge(short, "aac", "short.mkv");
      near(l.video, 3, "video kept");
      near(l.audio, 3, "shorter audio padded to the video's end");
      // A copied track cannot be padded: the video still keeps its length.
      l = merge(shortAac, "copy", "copy.mkv");
      near(l.video, 3, "video kept with a short copied track");
      near(l.audio, 1, "copied track as it is");
      l = merge(long, "copy", "copy-long.mkv");
      near(l.audio, 3, "longer copied track cut");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
