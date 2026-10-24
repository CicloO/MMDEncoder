const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { align, gccPhat } = require("../backend/align.cjs");
const { ff } = require("./engines.cjs");

const run = (args) => execFileSync(ff, ["-v", "error", ...args]);

test("GCC-PHAT finds a known lag in noise", () => {
  // A deterministic noise and the same noise 123 samples later, quieter.
  let x = 1;
  const rnd = () =>
    ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const ref = Float32Array.from({ length: 4000 }, rnd);
  const tgt = new Float32Array(6000);
  for (let i = 0; i < ref.length; i++) tgt[i + 123] = ref[i] * 0.3;
  const c = gccPhat(ref, tgt);
  let best = c.min;
  for (let k = c.min; k <= c.max; k++) if (c.at(k) > c.at(best)) best = k;
  assert.equal(best, 123);
});

test(
  "alignment: offsets either way, a different mix and codec, to the sample; unrelated audio is flagged",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-"));
    const tools = { ffmpeg: ff };
    const near = (got, want, tol, what) =>
      assert.ok(
        Math.abs(got - want) <= tol,
        `${what}: ${got.toFixed(6)} s, expected ${want} s`,
      );
    try {
      // A 40 s "song": pink noise with a beat-like tremolo.
      const song = path.join(dir, "song.wav");
      const noise = (seed) =>
        `anoisesrc=d=40:c=pink:r=48000:seed=${seed},tremolo=f=1.7:d=0.9`;
      run(["-f", "lavfi", "-i", noise(7), song]);

      // The reference is a video whose sound starts 3.217 s into the song,
      // with another EQ, half the level, 44.1 kHz AAC (like an MMD render).
      const clip = path.join(dir, "render.mp4");
      run([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=20",
        "-ss",
        "3.217",
        "-t",
        "20",
        "-i",
        song,
        "-af",
        "equalizer=f=1000:t=q:w=1:g=-8,highpass=f=120,volume=0.5,aresample=44100",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        clip,
      ]);
      let r = await align(tools, clip, song);
      assert.ok(r.reliable, "confidence " + r.confidence);
      near(r.offset, 3.217, 0.0005, "reference from the middle of the song");

      // The target lacks the first 2.5 s: pad that much before it.
      const late = path.join(dir, "late.flac");
      run(["-ss", "2.5", "-i", song, late]);
      r = await align(tools, song, late);
      assert.ok(r.reliable);
      near(r.offset, -2.5, 0.0005, "target starting later");

      // To the sample: 12345 samples at 48 kHz.
      const cut = path.join(dir, "cut.wav");
      run(["-i", song, "-af", "atrim=start_sample=12345", cut]);
      r = await align(tools, cut, song);
      near(r.offset, 12345 / 48000, 1.5 / 48000, "sample offset");

      // AAC both ways, where the fine pass starts past the beginning: the
      // reference opens with 2 s of silence, then the song from 10 s.
      const quiet = path.join(dir, "quiet.m4a");
      run([
        "-ss",
        "10",
        "-t",
        "20",
        "-i",
        song,
        "-af",
        "adelay=2000:all=1",
        "-c:a",
        "aac",
        quiet,
      ]);
      r = await align(tools, quiet, song);
      near(r.offset, 8, 0.0005, "AAC reference with a silent start");
      const songAac = path.join(dir, "song.m4a");
      run(["-i", song, "-c:a", "aac", "-b:a", "192k", songAac]);
      const excerpt = path.join(dir, "excerpt.wav");
      run(["-ss", "12", "-t", "15", "-i", song, excerpt]);
      r = await align(tools, excerpt, songAac);
      near(r.offset, 12, 0.0005, "AAC target");

      // Different audio: no clear match.
      const other = path.join(dir, "other.wav");
      run(["-f", "lavfi", "-i", noise(99), other]);
      r = await align(tools, other, song);
      assert.ok(!r.reliable, "unrelated audio flagged, ratio " + r.confidence);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
