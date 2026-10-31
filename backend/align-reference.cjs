"use strict";
const { spawn } = require("node:child_process");
const { referenceTiming, parseFrameRate } = require("./audio-timing.mjs");
const { appError } = require("./errors.cjs");

// The alignment worker owns this ffprobe just as it owns its PCM decoder.
// Cancellation waits for the child to close before the worker reports failure.
function probeReference(ffprobe, file, signal) {
  if (signal?.aborted) return Promise.reject(appError("ALIGN_CANCELLED"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    let stdout = "",
      stderr = "",
      launchError;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => (stdout += text));
    child.stderr.on("data", (text) => (stderr = (stderr + text).slice(-4000)));
    child.on("error", (error) => (launchError = error));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(appError("ALIGN_CANCELLED"));
      if (launchError || code !== 0)
        return reject(
          appError("ALIGN_REFERENCE_READ_FAILED", {
            detail: launchError?.message || stderr.trim() || String(code),
          }),
        );
      try {
        const timing = referenceTiming(JSON.parse(stdout));
        if (!parseFrameRate(timing.fpsText))
          throw appError("ALIGN_FRAME_RATE_INVALID", {
            frameRate: timing.fpsText,
          });
        resolve(timing);
      } catch (error) {
        reject(
          error.code
            ? error
            : appError("ALIGN_REFERENCE_READ_FAILED", {
                detail: error.message,
              }),
        );
      }
    });
  });
}
module.exports = { probeReference };
