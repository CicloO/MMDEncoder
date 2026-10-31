"use strict";
const fs = require("node:fs");
const { appError, serializeError } = require("./errors.cjs");
// Reads actual source/output metadata. Queue membership and process resources
// remain with their existing owners; no settings or application State enters.
function createFileDetails({
  isToolsBusy,
  requireMediaJob,
  requireJob,
  locate,
  ffprobe,
  run,
  inputArgs,
}) {
  return async function readDetails(payload) {
    if (isToolsBusy()) throw appError("DETAILS_TOOLS_BUSY");
    // payload.media: a job from the audio / video tools queue
    const job = payload.media
      ? requireMediaJob(payload.id)
      : requireJob(payload.id);
    await locate();
    const result = {};
    for (const [key, file] of payload.media
      ? [
          ["before", job.path],
          ...(job.audioPath ? [["audio", job.audioPath]] : []),
          ["after", job.output],
        ]
      : [
          ["before", job.path],
          ["after", job.output],
          ["mask", job.maskOutput],
        ]) {
      if (!file || !fs.existsSync(file)) {
        result[key] = serializeError(
          appError(
            key === "before"
              ? "DETAILS_SOURCE_MISSING"
              : "DETAILS_OUTPUT_MISSING",
          ),
        );
        continue;
      }
      try {
        const r = await run(
          ffprobe(),
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            // A PNG sequence is read as the video it becomes.
            ...(key === "before" && !payload.media && job.sequence
              ? inputArgs(job)
              : [file]),
          ],
          { timeout: 30000 },
        );
        result[key] = {
          path: key === "before" && job.sequence ? job.sequence.pattern : file,
          ...JSON.parse(r.stdout),
        };
      } catch (e) {
        const error = appError("DETAILS_READ_FAILED", { detail: e.message });
        if (e.runnerErrorData) error.params = { error: serializeError(e) };
        result[key] = {
          path: file,
          ...serializeError(error),
        };
      }
    }
    return result;
  };
}
module.exports = { createFileDetails };
