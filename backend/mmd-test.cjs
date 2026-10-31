"use strict";
// Short synthetic export shared by the desktop app and plugin helper.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const mmdExport = require("./mmd-export.cjs");
const { appError, summary } = require("./errors.cjs");

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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
    if (timedOut) throw appError("MMD_TEST_TIMEOUT", { seconds: 60 });
    if (code !== 0)
      throw appError("MMD_TEST_ENCODE_FAILED", {
        exitCode: code,
        detail: stderr.trim().split("\n").slice(-3).join(" "),
      });
    if (!fs.existsSync(plan.temp)) throw appError("MMD_TEST_VIDEO_MISSING");
    if (plan.maskTemp && !fs.existsSync(plan.maskTemp))
      throw appError("MMD_TEST_MASK_MISSING");
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
      throw appError("MMD_TEST_NO_FRAMES");
    return {
      ok: true,
      video,
      at: new Date().toISOString(),
      ...summary(plan.maskTemp ? "MMD_TEST_MASK_PASSED" : "MMD_TEST_PASSED", {
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      }),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (snapshot) fs.rmSync(snapshot, { force: true });
  }
}
module.exports = { testExport };
