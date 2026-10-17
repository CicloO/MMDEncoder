const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const core = require("./core.cjs");
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
  const errors = core.validate(s);
  if (errors.length) throw Error(errors.join("；"));
  if (!s.vsr && !s.vfg) throw Error("请先启用 VSR 或 VFG");
  if (s.vfg) {
    if (process.platform !== "win32") throw Error("VFG 仅支持 Windows");
    const v = await run(engines.nvencc, ["--version"], { timeout: 10000 });
    const n = (v.stdout + v.stderr).match(/NVEncC[^\n]*?\s(\d+)\.(\d+)/);
    if (!n || Number(n[1]) * 100 + Number(n[2]) < 936)
      throw Error("VFG 需要 NVEncC 9.36 或更新版本");
    const gpu = await run(engines.nvencc, ["--check-device"], {
      timeout: 10000,
    });
    if (!/RTX\s*(?:40|50)\d\d|Ada|Blackwell/i.test(gpu.stdout + gpu.stderr))
      throw Error("VFG 需要 Ada / Blackwell GPU，当前设备架构未通过识别");
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
      const r = await run(c.exe, c.args, { timeout: 180000 });
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
      throw Error("RTX 试编码输出尺寸与所选设置不符");
    const [n, d] = String(video.avg_frame_rate || "0/1")
      .split("/")
      .map(Number);
    const expectedFps =
      (core.parseFps(s.fps)?.value ?? 24) * (s.vfg ? s.vfgMultiplier : 1);
    if (!Number.isFinite(n / d) || Math.abs(n / d - expectedFps) > 0.1)
      throw Error("RTX 试编码帧率与所选倍率不符");
    return (
      log +
      "\n已验证输出：" +
      video.width +
      "x" +
      video.height +
      " / " +
      video.avg_frame_rate +
      " FPS\n"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { signature, probe };
