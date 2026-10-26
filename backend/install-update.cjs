"use strict";
// Update helper, run by the current (app-only) or new (full) executable in Node mode
// (ELECTRON_RUN_AS_NODE) from <app>\.update\new. It waits for the old app to
// exit, moves the old program files to <app>\.update\old, copies the new ones in
// (copy, because this helper runs from them), keeps the data folder, and puts
// everything back if any step fails. No PowerShell: security tools flag hidden
// PowerShell, and this needs no console window.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appError, sourceText } = require("./errors.cjs");

// The process entry and importable operation share this transaction owner.
async function installUpdate(job) {
  const {
    appDir,
    newDir,
    backup,
    pid,
    log,
    keep = [],
    relaunch = true,
    kind = "full",
  } = job;
  const exeOf = () => path.join(appDir || "", "MMDEncoder.exe");

  function write(message) {
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(
        log,
        `[${new Date().toISOString()}] ${message}\n`,
        "utf8",
      );
    } catch {}
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function alive(id) {
    try {
      process.kill(id, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  }
  // Files of a just-closed app can stay locked for a moment; retry ~20 s.
  async function retry(action, code, file) {
    for (let i = 0; ; i++) {
      try {
        return action();
      } catch (e) {
        if (i >= 40) throw appError(code, { file, detail: e.message });
        await sleep(500);
      }
    }
  }
  function start() {
    if (!relaunch) return;
    try {
      const exe = exeOf();
      // This helper runs in Node mode; the app must not inherit that, or it
      // would start as Node instead of opening its window.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.MMD_UPDATE_JOB;
      const child = spawn(exe, [], {
        cwd: appDir,
        detached: true,
        stdio: "ignore",
        env,
      });
      child.on("error", (e) =>
        write(sourceText("update.log.relaunchFailed", { detail: e.message })),
      );
      child.unref();
    } catch (e) {
      write(sourceText("update.log.relaunchFailed", { detail: e.message }));
    }
  }

  async function main() {
    if (!appDir || !newDir || !backup || !log)
      throw appError("UPDATE_JOB_INVALID");
    write(sourceText("update.log.started", { path: appDir }));
    const deadline = Date.now() + 120000;
    while (pid && alive(pid)) {
      if (Date.now() > deadline) {
        write(sourceText("update.log.waitTimeout"));
        return;
      }
      await sleep(300);
    }
    const names = (dir) => fs.readdirSync(dir).filter((n) => !keep.includes(n));
    const incoming =
      kind === "app" ? [path.join("resources", "app")] : names(newDir);
    const moved = [],
      placed = [];
    fs.mkdirSync(backup, { recursive: true });
    try {
      for (const name of kind === "app" ? incoming : names(appDir)) {
        fs.mkdirSync(path.dirname(path.join(backup, name)), {
          recursive: true,
        });
        await retry(
          () => fs.renameSync(path.join(appDir, name), path.join(backup, name)),
          "UPDATE_MOVE_FAILED",
          name,
        );
        moved.push(name);
      }
      for (const name of incoming) {
        placed.push(name);
        await retry(
          () =>
            fs.cpSync(path.join(newDir, name), path.join(appDir, name), {
              recursive: true,
              errorOnExist: true,
              force: false,
            }),
          "UPDATE_PLACE_FAILED",
          name,
        );
      }
      write(sourceText("update.log.completed"));
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (e) {
        write(sourceText("update.log.cleanupDeferred", { detail: e.message }));
      }
    } catch (e) {
      write(sourceText("update.log.restoring", { detail: e.message }));
      try {
        // Only what this run put in place is removed; old files only ever moved
        // to the backup folder and now move back.
        for (const name of placed)
          fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
        for (const name of moved)
          await retry(
            () =>
              fs.renameSync(path.join(backup, name), path.join(appDir, name)),
            "UPDATE_RESTORE_FAILED",
            name,
          );
        fs.rmSync(backup, { recursive: true, force: true });
        write(sourceText("update.log.restored"));
      } catch (r) {
        write(
          sourceText("update.log.restoreFailed", {
            path: backup,
            detail: r.message,
          }),
        );
      }
    }
    start();
  }
  return main().catch((e) =>
    write(sourceText("update.log.failed", { detail: e.message })),
  );
}

if (require.main === module)
  void installUpdate(JSON.parse(process.env.MMD_UPDATE_JOB || "{}"));

module.exports = { installUpdate };
