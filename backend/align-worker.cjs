"use strict";
// Runs the audio alignment (align.cjs) or a waveform preview's decode in a
// process of its own, started in Node mode (ELECTRON_RUN_AS_NODE), so a long
// track's buffers (a few hundred MB for ten minutes) never sit in the app's
// main process.
// Input: MMD_ALIGN_JOB = { mode: "align", ffmpeg, reference, target } or
// { mode: "preview", ffmpeg, file, rate, length }. Output on stdout: the
// alignment as JSON, or the preview's mono 16-bit samples as raw bytes; an
// error message on stderr with exit code 1.
// A "cancel" line on stdin, or stdin closing (the app quit or was killed),
// stops the work and its FFmpeg.
const { align, decodeS16 } = require("./align.cjs");

const job = JSON.parse(process.env.MMD_ALIGN_JOB || "{}");
const stop = new AbortController();
process.stdin.on("data", (b) => String(b).includes("cancel") && stop.abort());
process.stdin.on("end", () => stop.abort());
process.stdin.on("error", () => stop.abort());
const done = (code) => process.exit(code);
(job.mode === "preview"
  ? decodeS16(job.ffmpeg, job.file, job.rate, {
      length: job.length,
      signal: stop.signal,
    }).then((pcm) => new Promise((r) => process.stdout.write(pcm, r)))
  : align({ ffmpeg: job.ffmpeg }, job.reference, job.target, {
      signal: stop.signal,
    }).then(
      (result) =>
        new Promise((r) => process.stdout.write(JSON.stringify(result), r)),
    )
).then(
  () => done(0),
  (e) =>
    process.stderr.write(stop.signal.aborted ? "已取消" : e.message, () =>
      done(1),
    ),
);
