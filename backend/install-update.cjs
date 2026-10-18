"use strict";
// Update helper, run by the NEW version's "MMDEncoder.exe" in Node mode
// (ELECTRON_RUN_AS_NODE) from <app>\.update\new. It waits for the old app to
// exit, moves the old program files to <app>\.update\old, copies the new ones in
// (copy, because this helper runs from them), keeps the data folder, and puts
// everything back if any step fails. No PowerShell: security tools flag hidden
// PowerShell, and this needs no console window.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const job = JSON.parse(process.env.MMD_UPDATE_JOB || "{}");
const { appDir, newDir, backup, pid, log, keep = [], relaunch = true } = job;
// Relaunch whichever name the new version ships (it was "MMD Encoder.exe" before).
const exeOf = () =>
  ["MMDEncoder.exe", "MMD Encoder.exe"]
    .map((n) => path.join(appDir || "", n))
    .find((p) => fs.existsSync(p)) || path.join(appDir || "", "MMDEncoder.exe");

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
async function retry(action, what) {
  for (let i = 0; ; i++) {
    try {
      return action();
    } catch (e) {
      if (i >= 40) throw Error(`${what}失败（文件可能被占用）：${e.message}`);
      await sleep(500);
    }
  }
}
function start() {
  if (!relaunch) return;
  try {
    const exe = exeOf();
    spawn(exe, [], { cwd: appDir, detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    write("无法自动重新打开软件：" + e.message);
  }
}

async function main() {
  if (!appDir || !newDir || !backup || !log) throw Error("缺少更新参数");
  write("开始更新：" + appDir);
  const deadline = Date.now() + 120000;
  while (pid && alive(pid)) {
    if (Date.now() > deadline) {
      write("等待软件退出超时，未做任何修改");
      return;
    }
    await sleep(300);
  }
  const names = (dir) => fs.readdirSync(dir).filter((n) => !keep.includes(n));
  const incoming = names(newDir);
  const moved = [],
    placed = [];
  fs.mkdirSync(backup, { recursive: true });
  try {
    for (const name of names(appDir)) {
      await retry(
        () => fs.renameSync(path.join(appDir, name), path.join(backup, name)),
        "移动旧文件 " + name,
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
        "放入新文件 " + name,
      );
    }
    write("更新完成");
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (e) {
      write("旧文件稍后清理：" + e.message);
    }
  } catch (e) {
    write("更新失败，正在还原旧版本：" + e.message);
    try {
      // Only what this run put in place is removed; old files only ever moved
      // to the backup folder and now move back.
      for (const name of placed)
        fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
      for (const name of moved)
        await retry(
          () => fs.renameSync(path.join(backup, name), path.join(appDir, name)),
          "还原 " + name,
        );
      fs.rmSync(backup, { recursive: true, force: true });
      write("已还原旧版本");
    } catch (r) {
      write("还原失败，旧文件保存在：" + backup + "；" + r.message);
    }
  }
  start();
}
main().catch((e) => write("更新出错：" + e.message));
