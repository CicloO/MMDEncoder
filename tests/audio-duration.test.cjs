require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  streamDuration,
  referenceTiming,
} = require("../backend/audio-timing.mjs");
const core = require("../backend/core.cjs");
const { createService } = require("../backend/service.cjs");
const { ff, fp, nv, engineDir, runCommand } = require("./engines.cjs");

test("stream duration prefers its own seconds or Matroska tag over the container", () => {
  assert.equal(
    streamDuration({ duration: "2", tags: { DURATION: "00:00:04" } }, 5),
    2,
  );
  assert.equal(
    streamDuration({ tags: { DURATION: "01:02:03.125" } }, 5),
    3723.125,
  );
  assert.equal(
    streamDuration({ tags: { "DURATION-eng": "00:00:02.002" } }, 5),
    2.002,
  );
  for (const tag of ["bad", "00:99:00", "-1:00:00", "Infinity"])
    assert.equal(
      streamDuration({ duration: "N/A", tags: { DURATION: tag } }, 5),
      5,
    );
  assert.equal(streamDuration({}, Infinity), 0);
  assert.equal(
    referenceTiming({
      streams: [{ codec_type: "video", tags: { DURATION: "00:00:02" } }],
      format: { duration: "4" },
    }).duration,
    2,
  );
});

test(
  "a two-second video with four-second original audio bounds replacement and merge by video, while copy keeps short audio",
  { timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-audio-duration-"));
    const run = (args) =>
      execFileSync(ff, ["-v", "error", ...args], { maxBuffer: 8 << 20 });
    const probe = (file) =>
      JSON.parse(
        execFileSync(fp, [
          "-v",
          "error",
          "-count_frames",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ]),
      );
    const decode = (file) =>
      run([
        "-i",
        file,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "-",
      ]);
    const until = async (fn) => {
      const end = Date.now() + 30000;
      while (!fn()) {
        if (Date.now() > end) throw Error("duration integration timed out");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    const svc = createService({ engineDir, dataDir: path.join(dir, "data") });
    try {
      const video = path.join(dir, "video.mkv"),
        short = path.join(dir, "short.wav");
      run([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x96:r=30:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=d=4:r=48000",
        "-c:v",
        "libx264",
        "-c:a",
        "pcm_s16le",
        video,
      ]);
      run(["-f", "lavfi", "-i", "sine=d=0.4:r=48000", short]);
      const meta = core.metadata(probe(video)),
        pcm = decode(short);
      assert.equal(meta.duration, 4);
      assert.equal(meta.videoDuration, 2);
      const padded = Buffer.alloc(96000 * 2);
      pcm.copy(padded);
      const check = (file, expected) => {
        assert.deepEqual(decode(file), expected);
        assert.equal(
          Number(
            probe(file).streams.find((s) => s.codec_type === "video")
              .nb_read_frames,
          ),
          60,
        );
      };
      await until(() => svc.getState().located && !svc.getState().detecting);
      const timing = await svc.invoke("alignReferenceInfo", {
        path: video,
        slot: "duration-reference",
      });
      assert.equal(timing.duration, 2);
      await svc.invoke("mediaAdd", { paths: [video] });
      await until(() => svc.getState().mediaJobs[0]?.meta);
      const id = svc.getState().mediaJobs[0].id;
      await svc.invoke("mediaSetAudio", { id, path: short });
      for (const format of ["wav", "copy"]) {
        if (format === "copy") await svc.invoke("mediaRequeue", { id });
        await svc.invoke("mediaStart", {
          operation: "merge",
          audioFormat: format,
          container: "mkv",
          location: "source",
        });
        await until(() => !svc.getState().running);
        const job = svc.getState().mediaJobs[0];
        assert.equal(job.status, "done", job.error);
        check(job.output, format === "copy" ? pcm : padded);
      }
      for (const encoder of ["libx264", "nvencc:h264"]) {
        const output = path.join(dir, encoder.replace(":", "-") + ".mkv");
        const commands = core.buildCommands(
          {
            path: video,
            meta,
            audioPath: short,
            audioMeta: core.audioInfo(probe(short).streams[0]),
            audioDuration: 0.4,
          },
          {
            ...core.DEFAULTS,
            encoder,
            preset: encoder === "libx264" ? "ultrafast" : "p1",
            container: "mkv",
            alphaMode: "discard",
            audio: "pcm_s16le",
            audioFade: 0,
          },
          { ffmpeg: ff, nvencc: nv },
          { output },
        );
        for (const command of commands) runCommand(command);
        check(output, padded);
      }
    } finally {
      svc.dispose();
      await new Promise((resolve) => setTimeout(resolve, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
