"use strict";
// NVEncC presets in the MMD export plugin. The plugin starts one process and
// writes MMD's raw frames to its stdin; NVEncC needs FFmpeg in front of it
// (frame conversion, the optional mask) and FFmpeg after it (the container
// and its tags). So the plugin starts MMDEncoder.exe in Node mode with this
// script, which runs those steps: the first with MMD's frames on FFmpeg's
// stdin, piped on to NVEncC, then the rest one after another.
// MMD_PIPE_JOB = { steps: [{ exe, args, pipeFrom?: { exe, args } }],
// temporary: [files to delete at the end] }. FFmpeg's and NVEncC's messages
// go to this process's stderr (the plugin's FFmpeg log).
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const job = JSON.parse(process.env.MMD_PIPE_JOB || "{}");
const exited = (child) =>
  new Promise((resolve) => {
    child.on("error", (e) => {
      process.stderr.write(e.message + "\n");
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
async function run(step) {
  if (!step.pipeFrom) {
    const child = spawn(step.exe, step.args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return exited(child);
  }
  const source = spawn(step.pipeFrom.exe, step.pipeFrom.args, {
    windowsHide: true,
    stdio: ["inherit", "pipe", "inherit"],
  });
  const encoder = spawn(step.exe, step.args, {
    windowsHide: true,
    stdio: ["pipe", "ignore", "inherit"],
  });
  // Drain the parent's readable stream as well as feeding the encoder. Passing
  // source.stdout as a child descriptor leaves its 'close' event pending on
  // Windows, and Node can exit with an unresolved promise before the remux.
  source.stdout.pipe(encoder.stdin);
  encoder.stdin.on("error", () => source.kill());
  encoder.once("close", () => {
    if (source.exitCode === null) source.kill();
  });
  const [a, b] = await Promise.all([exited(source), exited(encoder)]);
  return a || b;
}
(async () => {
  let code = 0;
  for (const step of job.steps || []) {
    code = await run(step);
    if (code) break;
  }
  for (const file of job.temporary || []) fs.rmSync(file, { force: true });
  process.exit(code);
})();
