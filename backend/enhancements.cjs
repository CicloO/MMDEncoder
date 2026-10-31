const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const core = require("./core.cjs");
const { appError, validationError, summary } = require("./errors.cjs");
function signature(s) {
  return JSON.stringify([
    s.encoder,
    s.bitDepth,
    s.chroma,
    s.vsr,
    s.vsrScale,
    s.vsrQuality,
    s.vsrStrength,
    s.vfg,
    s.vfgMultiplier,
    s.vfgMode,
    s.vfgModelDir,
    s.resizeMode,
    s.resizeAxis,
    s.keepAspect,
    s.width,
    s.height,
    s.fps,
  ]);
}
async function probe(s, engines, run) {
  const issues = core.validateIssues(s);
  if (issues.length) throw validationError(issues);
  if (!s.vsr && !s.vfg) throw appError("RTX_FEATURE_REQUIRED");
  if (s.vfg) {
    if (process.platform !== "win32") throw appError("VFG_WINDOWS_REQUIRED");
    const v = await run(engines.nvencc, ["--version"], { timeout: 10000 });
    const n = (v.stdout + v.stderr).match(/NVEncC[^\n]*?\s(\d+)\.(\d+)/);
    if (!n || Number(n[1]) * 100 + Number(n[2]) < 936)
      throw appError("VFG_VERSION_REQUIRED");
    const gpu = await run(engines.nvencc, ["--check-device"], {
      timeout: 10000,
    });
    if (!/RTX\s*(?:40|50)\d\d|Ada|Blackwell/i.test(gpu.stdout + gpu.stderr))
      throw appError("VFG_GPU_REQUIRED");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-rtx-"));
  try {
    const input = path.join(temp, "input.mkv");
    await run(
      engines.ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1280x720:r=24:d=0.25",
        "-c:v",
        "ffv1",
        input,
      ],
      { timeout: 30000 },
    );
    const commands = core.buildCommands(
      {
        path: input,
        meta: {
          width: 1280,
          height: 720,
          fps: 24,
          hasAlpha: false,
          codec: "ffv1",
        },
      },
      { ...s, audio: "none", container: "mkv", alphaMask: false },
      engines,
      { output: path.join(temp, "output.mkv") },
    );
    let log = "";
    for (const c of commands) {
      const r = c.pipeFrom
        ? await run.piped(c, { timeout: 180000 })
        : await run(c.exe, c.args, { timeout: 180000 });
      log += r.stdout + r.stderr;
    }
    const actual = await run(
      engines.ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        path.join(temp, "output.mkv"),
      ],
      { timeout: 15000 },
    );
    const video = JSON.parse(actual.stdout).streams?.find(
      (stream) => stream.codec_type === "video",
    );
    const expected = core.dimensions(s, { width: 1280, height: 720 });
    if (
      !video ||
      video.width !== expected.width ||
      video.height !== expected.height
    )
      throw appError("RTX_TRIAL_SIZE_MISMATCH");
    const [n, d] = String(video.avg_frame_rate || "0/1")
      .split("/")
      .map(Number);
    const expectedFps =
      (core.parseFps(s.fps)?.value ?? 24) * (s.vfg ? s.vfgMultiplier : 1);
    if (!Number.isFinite(n / d) || Math.abs(n / d - expectedFps) > 0.1)
      throw appError("RTX_TRIAL_FPS_MISMATCH");
    return (
      log +
      "\n" +
      summary("RTX_VERIFIED_OUTPUT", {
        width: video.width,
        height: video.height,
        fps: video.avg_frame_rate,
      }).message +
      "\n"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { signature, probe };
