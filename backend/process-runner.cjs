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
          e.timedOut = timed;
          reject(e);
        } else resolve({ stdout, stderr });
      };
      child.on("error", (e) => done(e));
      child.on("close", (code) => done(null, code));
    });
  }
  // Start the whole chain concurrently. Only the last stdout is text;
  // intermediate stdout is binary and is consumed by the next process.
  async function runPiped(c, options = {}) {
    if (isDisposed()) return Promise.reject(Error("应用已关闭"));
    const processes = commandProcesses(c),
      group = [],
      closed = [];
    let stdout = "",
      stderr = "",
      failure,
      timer;
    const stop = (error) => {
      failure ||= error;
      for (const child of group) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    };
    const controller = {
      kill: () => stop(Object.assign(Error("编码已取消"), { cancelled: true })),
    };
    if (options.encoding) setActive(controller);
    const data = (stream, b) => {
      const s = b.toString();
      if (stream === "out") stdout = (stdout + s).slice(-1024 * 1024);
      else stderr = (stderr + s).slice(-1024 * 1024);
      options.onData?.(s, stream);
    };
    try {
      for (let i = 0; i < processes.length; i++) {
        const p = processes[i];
        const child = spawn(p.exe, p.args, {
          windowsHide: true,
          stdio: [i ? "pipe" : options.stdin || "ignore", "pipe", "pipe"],
          shell: false,
        });
        group.push(child);
        children.add(child);
        closed.push(
          new Promise((resolve) =>
            child.once("close", () => {
              children.delete(child);
              resolve();
            }),
          ),
        );
        child.on("error", (e) => stop(Object.assign(e, { processIndex: i })));
        child.on("exit", (code, signal) => {
          if (code !== 0)
            stop(
              Object.assign(Error("管道进程退出：" + (code ?? signal)), {
                code,
                processIndex: i,
              }),
            );
        });
        child.stderr.on("data", (b) => data("err", b));
        if (i) {
          child.stdin.on("error", (e) =>
            stop(Object.assign(e, { processIndex: i })),
          );
          group[i - 1].stdout.pipe(child.stdin);
        }
      }
      group.at(-1).stdout.on("data", (b) => data("out", b));
      if (options.timeout)
        timer = setTimeout(
          () => stop(Object.assign(Error("引擎运行超时"), { timedOut: true })),
          options.timeout,
        );
    } catch (e) {
      stop(e);
    }
    await Promise.all(closed);
    clearTimeout(timer);
    if (getActive() === controller) setActive(null);
    if (failure) {
      const error = Error(stderr.trim().slice(-3000) || failure.message);
      Object.assign(error, {
        stdout,
        stderr,
        code: failure.code,
        systemCode: failure.code,
        timedOut: !!failure.timedOut,
        cancelled: !!failure.cancelled,
        processIndex: failure.processIndex,
      });
      throw error;
    }
    return { stdout, stderr };
  }
  run.piped = runPiped; // for callers that only get run (RTX check)

  return run;
}
module.exports = { createRunner };
