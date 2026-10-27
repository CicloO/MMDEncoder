"use strict";
const { appError, serializeError } = require("./errors.cjs");
// CLI used by the plugin: MMD_EXPORT_MODE=plan|finish, MMD_EXPORT_JOB=<json>.
async function main({ plan, finish, remember, readConfig }) {
  const mode = process.env.MMD_EXPORT_MODE;
  const failure = (error, fallback) => {
    const data = serializeError(
      error?.code ? error : appError(fallback, { detail: error.message }),
    );
    process.stdout.write(
      JSON.stringify({ ok: false, error: data.message, errorData: data }),
    );
  };
  let job;
  try {
    job = JSON.parse(process.env.MMD_EXPORT_JOB || "{}");
  } catch (error) {
    failure(error, "MMD_REQUEST_INVALID");
    return;
  }
  if (mode === "test") {
    try {
      const config = job.selection ? readConfig(job.selection) : readConfig();
      const result = await require("./mmd-test.cjs").testExport(config);
      process.stdout.write(JSON.stringify(result));
    } catch (e) {
      failure(e, "MMD_TEST_FAILED");
    }
    return;
  }
  if (mode === "plan") {
    try {
      process.stdout.write(JSON.stringify({ ok: true, ...plan(job) }));
    } catch (e) {
      failure(e, "MMD_PLAN_FAILED");
    }
    return;
  }
  if (mode === "finish") {
    const lines = [];
    const notesData = [];
    const log = (m, data) => {
      lines.push(m);
      if (data) notesData.push(data);
    };
    const started = Date.now();
    try {
      const r = await finish(job, undefined, log);
      remember({
        ok: true,
        ...r,
        frames: job.frames,
        startFrame: job.startFrame,
        // Seconds, measured by the plugin in MMD (setup, render, time MMD
        // waited for the encoder, FFmpeg's finish after the last frame) and
        // here (adding audio, moving files).
        ...(job.timing && typeof job.timing === "object"
          ? {
              timing: {
                ...job.timing,
                finish: (Date.now() - started) / 1000,
              },
            }
          : {}),
        notes: lines,
        ...(notesData.length ? { notesData } : {}),
      });
    } catch (e) {
      remember({
        ok: false,
        error: e.message,
        errorData: serializeError(e),
        output: job.output,
        avi: job.avi,
        notes: lines,
        ...(notesData.length ? { notesData } : {}),
      });
      process.exitCode = 1;
    }
  }
}
module.exports = { main };
