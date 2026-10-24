"use strict";
// Runs the audio alignment (align.cjs) in a process of its own, started in
// Node mode (ELECTRON_RUN_AS_NODE), so a long track's working buffers (a
// few hundred MB for ten minutes) never sit in the app's main process.
// Input: MMD_ALIGN_JOB = { ffmpeg, reference, target }; output: the result
// as JSON on stdout, or the error message on stderr with exit code 1.
const { align } = require("./align.cjs");

const job = JSON.parse(process.env.MMD_ALIGN_JOB || "{}");
align({ ffmpeg: job.ffmpeg }, job.reference, job.target).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  (e) => {
    process.stderr.write(e.message);
    process.exitCode = 1;
  },
);
