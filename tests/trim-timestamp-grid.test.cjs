const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ff, fp } = require("./engines.cjs");
const trim = require("../backend/trim.cjs");

test("millisecond-rounded CFR remains trimmable after MP4 remux; a real timing gap stays refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-rounded-grid-"));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  try {
    for (const gap of [false, true]) {
      const file = path.join(dir, gap ? "gap.mp4" : "rounded.mp4");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-vf",
        "settb=1/1000,setpts=round(N*1000/30)" +
          (gap ? "+100*floor(N/60)" : ""),
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1/1000",
        "-c:v",
        "libx264",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-video_track_timescale",
        "16000",
        file,
      ]);
      const index = await trim.index({ ffmpeg: ff, ffprobe: fp }, file);
      if (gap) {
        assert.equal(index.supported, false);
        assert.equal(index.reasonData.code, "TRIM_VFR_UNSUPPORTED");
      } else {
        assert.equal(index.supported, true);
        assert.equal(index.frames.length, 120);
        assert.equal(index.timeBase.den, 16000);
        const steps = index.frames
          .slice(1)
          .map((f, i) => f.pts - index.frames[i].pts);
        // The old tick-relative test rejects this 528/544-tick alternation.
        assert.ok(
          Math.max(...steps) - Math.min(...steps) > Math.min(...steps) * 0.02,
        );
        assert.deepEqual(
          index.frames.filter((f) => f.safe).map((f) => f.frame),
          [0, 30, 60, 90],
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
