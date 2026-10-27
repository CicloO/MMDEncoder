"use strict";
// One MMD render feeds a concurrent FFmpeg -> NVEncC -> FFmpeg chain.
// The plugin's process job owns this helper and all descendants. The helper
// waits for every member; only a successful chain can reach MMD's finish step.
const fs = require("node:fs");
const { createRunner } = require("./process-runner.cjs");
const { commandProcesses } = require("./command-processes.cjs");
const { appError } = require("./errors.cjs");
const job = JSON.parse(process.env.MMD_PIPE_JOB || "{}");
let active;
const run = createRunner({
  isDisposed: () => false,
  children: new Set(),
  getActive: () => active,
  setActive: (value) => {
    active = value;
  },
});
const cancel = () => active?.kill();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
(async () => {
  let started = false;
  try {
    // A previous interrupted render may still be recoverable. Refuse it
    // before launching; failure cleanup must never delete that older file.
    for (const file of job.outputs || []) {
      if (fs.existsSync(file)) throw appError("MMD_PIPE_OUTPUT_EXISTS");
    }
    started = true;
    for (const step of job.steps || []) {
      const options = {
        encoding: true,
        onData: (s) => process.stderr.write(s),
      };
      if (commandProcesses(step).length > 1)
        await run.piped(step, { ...options, stdin: "inherit" });
      else await run(step.exe, step.args, options);
    }
  } catch (e) {
    process.stderr.write(e.message + "\n");
    if (started)
      for (const file of job.outputs || []) fs.rmSync(file, { force: true });
    process.exitCode = 1;
  }
})();
