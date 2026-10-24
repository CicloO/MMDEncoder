"use strict";
// Short synthetic export shared by the desktop app and plugin helper.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const mmdExport = require("./mmd-export.cjs");

async function testExport(
  config = mmdExport.readConfig(),
  children = new Set(),
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmdencoder-export-test-"));
  const started = Date.now();
  let snapshot = "";
  try {
    const width = 640,
      height = 360,
      frames = 30;
    const plan = mmdExport.plan(
      {
        avi: path.join(dir, "test.avi"),
        width,
        height,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
      },
      config,
    );
    snapshot = mmdExport.snapshotPath(plan.temp);
    const child = spawn(plan.exe, plan.args, {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      // NVEncC presets run MMDEncoder.exe in Node mode (mmd-pipe.cjs).
      ...(plan.env ? { env: { ...process.env, ...plan.env } } : {}),
    });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdin.on("error", () => {});
    // Settles once, whether FFmpeg fails to start, exits early or hangs.
    const exited = new Promise((resolve) => {
      child.once("error", (e) => {
        stderr += "\n" + e.message;
        resolve(-1);
      });
      child.once("close", (code) => resolve(code ?? -1));
    });
    const timer = setTimeout(() => {
      stderr += "\n测试编码超过 60 秒未结束，已停止";
      child.kill();
    }, 60000);
    let gone = false;
    exited.then(() => (gone = true));
    const frame = Buffer.alloc(width * height * 4, 0x80);
    for (let i = 0; i < frames && !gone; i++)
      if (!child.stdin.write(frame))
        // Wait for room in the pipe, or for FFmpeg to be gone.
        await Promise.race([
          new Promise((r) => child.stdin.once("drain", r)),
          exited,
        ]);
    if (!gone) child.stdin.end();
    const code = await exited;
    clearTimeout(timer);
    children.delete(child);
    if (code !== 0)
      throw Error(
        "编码失败（退出码 " +
          code +
          "）：" +
          stderr.trim().split("\n").slice(-3).join(" "),
      );
    if (!fs.existsSync(plan.temp)) throw Error("没有生成测试文件");
    if (plan.maskTemp && !fs.existsSync(plan.maskTemp))
      throw Error("没有生成 Alpha 遮罩测试文件");
    const { stdout } = await promisify(execFile)(
      config.engines.ffprobe,
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,nb_read_frames",
        "-of",
        "json",
        plan.temp,
      ],
      { windowsHide: true, timeout: 15000 },
    );
    const video = JSON.parse(stdout).streams?.[0];
    if (!video || !(Number(video.nb_read_frames) > 0))
      throw Error("测试文件没有可用的视频帧");
    return {
      ok: true,
      video,
      at: new Date().toISOString(),
      message: `测试编码通过${plan.maskTemp ? "（含 Alpha 遮罩）" : ""}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (snapshot) fs.rmSync(snapshot, { force: true });
  }
}
module.exports = { testExport };
