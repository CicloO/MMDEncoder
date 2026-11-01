const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport } = require("../backend/bug-report.cjs");

test("error report names the app, machine, tools, task and full log", () => {
  const text = buildReport({
    version: "1.7.2",
    versions: { electron: "40.0.0", chrome: "140.0", node: "24.0.0" },
    gpu: {
      gpuDevice: [
        {
          vendorId: 0x10de,
          deviceId: 0x2684,
          driverVersion: "32.0.15.7680",
          active: true,
        },
      ],
    },
    locale: "zh-CN",
    engineInfo: {
      ffmpeg: "C:/t/ffmpeg.exe",
      ffprobe: "C:/t/ffprobe.exe",
      nvencc: "C:/t/NVEncC64.exe",
    },
    tools: {
      installed: { ffmpeg: { version: "9.0.2" }, nvencc: { version: "9.36" } },
    },
    engines: [{ id: "libx264" }, { id: "nvencc:h264" }],
    job: {
      status: "failed",
      path: "I:/User 素材/in.mov",
      output: "I:/User 素材/Encoded/in.mp4",
      error: "编码失败",
      errorData: { code: "ENCODE_FAILED" },
      meta: { width: 2848, height: 1602 },
      settings: { encoder: "nvencc:h264", vsrScale: 2 },
      log: "not repeated",
    },
    log: "Resolution is over limit.: 5696x3204",
    now: new Date("2026-11-01T00:00:00Z"),
  });
  for (const part of [
    "App: 1.7.2",
    "Electron: 40.0.0",
    "GPU 1: vendor 0x10de device 0x2684 driver 32.0.15.7680 (active)",
    "FFmpeg: 9.0.2 (C:/t/ffmpeg.exe)",
    "NVEncC: 9.36 (C:/t/NVEncC64.exe)",
    "Encoders: libx264, nvencc:h264",
    "Source: I:/User 素材/in.mov",
    "Error code: ENCODE_FAILED",
    '"vsrScale":2',
    "Resolution is over limit.: 5696x3204\n",
  ])
    assert.ok(text.includes(part), part);
  assert.match(text, /^Windows: .+\n/m);
  assert.match(text, /^CPU: .+ × \d+\n/m);
  assert.ok(!text.includes("not repeated"));
  // Without a task (the detection log) the task block is left out.
  assert.ok(!buildReport({ version: "1.7.2", log: "" }).includes("Task\n"));
});
