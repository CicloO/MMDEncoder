"use strict";
// CLI used by the plugin: MMD_EXPORT_MODE=plan|finish, MMD_EXPORT_JOB=<json>.
async function main({ plan, finish, remember, readConfig }) {
  const mode = process.env.MMD_EXPORT_MODE;
  const job = JSON.parse(process.env.MMD_EXPORT_JOB || "{}");
  if (mode === "test") {
    try {
      const config = job.selection ? readConfig(job.selection) : readConfig();
      const result = await require("./mmd-test.cjs").testExport(config);
      process.stdout.write(JSON.stringify(result));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (mode === "plan") {
    try {
      process.stdout.write(JSON.stringify({ ok: true, ...plan(job) }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (mode === "finish") {
    const lines = [];
    const log = (m) => lines.push(m);
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
      });
    } catch (e) {
      remember({
        ok: false,
        error: e.message,
        output: job.output,
        avi: job.avi,
        notes: lines,
      });
      process.exitCode = 1;
    }
  }
}
module.exports = { main };
