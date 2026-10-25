"use strict";
const { spawn } = require("node:child_process");
const { commandProcesses } = require("./command-processes.cjs");
function createRunner({ isDisposed, children, getActive, setActive }) {
  function run(
    exe,
    args,
    { timeout = 0, onData, encoding = false, stdin } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (isDisposed()) return reject(Error("应用已关闭"));
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
      });
      children.add(child);
      if (stdin) {
        // The reader may stop early (error, cancel); the writer then fails.
        child.stdin.on("error", () => {});
        stdin.pipe(child.stdin);
      }
      if (encoding) setActive(child);
      let stdout = "",
        stderr = "",
        timed = false;
      const timer = timeout
        ? setTimeout(() => {
            timed = true;
            child.kill();
          }, timeout)
        : null;
      const data = (stream, b) => {
        const s = b.toString();
        if (stream === "out") stdout = (stdout + s).slice(-1024 * 1024);
        else stderr = (stderr + s).slice(-1024 * 1024);
        onData?.(s, stream);
      };
      child.stdout.on("data", (b) => data("out", b));
      child.stderr.on("data", (b) => data("err", b));
      let settled = false;
      const done = (err, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (getActive() === child) setActive(null);
        if (err || code !== 0) {
          const e = Error(
            timed
              ? "引擎运行超时"
              : err
                ? err.message
                : stderr.trim().slice(-3000) || "编码器退出：" + code,
          );
          e.stdout = stdout;
          e.stderr = stderr;
          e.code = code;
          e.systemCode = err?.code;
          reject(e);
        } else resolve({ stdout, stderr });
      };
      child.on("error", (e) => done(e));
      child.on("close", (code) => done(null, code));
    });
  }
  // A command fed by another program's output (FFmpeg -> NVEncC). Fails if
  // either side fails: a writer that stops early would otherwise look like
  // a short but complete video to the reader.
  function runPiped(c, options) {
    if (isDisposed()) return Promise.reject(Error("应用已关闭"));
    const [source, destination] = commandProcesses(c);
    const writer = spawn(source.exe, source.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    children.add(writer);
    let stderr = "",
      failure = null;
    writer.stderr.on("data", (b) => {
      const s = b.toString();
      stderr = (stderr + s).slice(-64 * 1024);
      options.onData?.(s, "err");
    });
    writer.on("error", (e) => (failure = e));
    const written = new Promise((resolve) =>
      writer.on("close", (code) => {
        children.delete(writer);
        resolve(code);
      }),
    );
    const read = run(destination.exe, destination.args, {
      ...options,
      stdin: writer.stdout,
    });
    read.catch(() => writer.kill());
    return Promise.allSettled([read, written]).then(([r, code]) => {
      if (r.status === "rejected") throw r.reason;
      if (failure || code.value !== 0)
        throw Error(
          failure?.message ||
            stderr.trim().slice(-3000) ||
            "预处理退出：" + code.value,
        );
      return r.value;
    });
  }
  run.piped = runPiped; // for callers that only get run (RTX check)

  return run;
}
module.exports = { createRunner };
