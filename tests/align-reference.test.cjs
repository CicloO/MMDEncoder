require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { createAlignService } = require("../backend/align-service.cjs");
const { ff, fp } = require("./engines.cjs");
const until = async (fn) => {
  const end = Date.now() + 10000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("reference lifecycle timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("reference query returns actual rational video FPS or explicit audio-only 30 FPS without changing PCM", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-align-reference-"));
  const svc = createAlignService({
    engineInfo: () => ({ ffmpeg: ff, ffprobe: fp }),
    locate: async () => {},
  });
  try {
    const video = path.join(dir, "fractional.mkv"),
      audio = path.join(dir, "audio.wav");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x96:r=30000/1001",
      "-frames:v",
      "30",
      "-c:v",
      "libx264",
      video,
    ]);
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1:r=24000",
      audio,
    ]);
    const v = await svc.queries.alignReferenceInfo({
      path: video,
      slot: "reference-info",
    });
    assert.equal(v.fpsText, "30000/1001");
    assert.equal(v.fallback, false);
    assert.equal(v.hasAudio, false);
    const a = await svc.queries.alignReferenceInfo({
      path: audio,
      slot: "reference-info",
    });
    assert.equal(a.fpsText, "30/1");
    assert.equal(a.fallback, true);
    assert.equal(a.hasAudio, true);
    const pcm = await svc.queries.alignPreview({
      path: audio,
      slot: "preview",
    });
    assert.ok(pcm.pcm instanceof Int16Array);
    assert.equal(pcm.pcm.length, 24000);
    await assert.rejects(
      svc.queries.alignReferenceInfo({ path: "relative.wav" }),
      { code: "ALIGN_INPUT_INVALID" },
    );
    const missing = createAlignService({
      engineInfo: () => ({}),
      locate: async () => {},
    });
    await assert.rejects(missing.queries.alignReferenceInfo({ path: audio }), {
      code: "FFPROBE_REQUIRED",
    });
    await assert.rejects(
      svc.queries.alignReferenceInfo({ path: path.join(dir, "missing.wav") }),
      { code: "ALIGN_REFERENCE_READ_FAILED" },
    );
    assert.equal(svc.runningCount(), 0);
  } finally {
    svc.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "reference slot replacement, cancel and worker stdin EOF reap the blocked ffprobe",
  { timeout: 30000 },
  async () => {
    const name = "mmd-reference-" + crypto.randomUUID();
    const pipe = "\\\\.\\pipe\\" + name;
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, resolve);
    });
    const svc = createAlignService({
      engineInfo: () => ({ ffmpeg: ff, ffprobe: fp }),
      locate: async () => {},
    });
    const alive = () =>
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ffprobe.exe' -and $_.CommandLine -like '*${name}*' } | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: "utf8" },
      ).trim();
    let orphan;
    try {
      const first = svc.queries.alignReferenceInfo({
        path: pipe,
        slot: "info",
      });
      const firstCancelled = assert.rejects(first, { code: "ALIGN_CANCELLED" });
      await until(() => sockets.size > 0);
      const second = svc.queries.alignReferenceInfo({
        path: pipe,
        slot: "info",
      });
      const secondCancelled = assert.rejects(second, {
        code: "ALIGN_CANCELLED",
      });
      await firstCancelled;
      await until(() => sockets.size > 0 && svc.runningCount() === 1);
      svc.queries.alignCancel({ slots: ["info"] });
      await secondCancelled;
      await until(() => svc.runningCount() === 0 && !alive());
      orphan = spawn(
        process.execPath,
        [path.resolve("backend/align-worker.cjs")],
        {
          windowsHide: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            MMD_ALIGN_JOB: JSON.stringify({
              mode: "reference",
              ffprobe: fp,
              file: pipe,
            }),
          },
        },
      );
      const closed = new Promise((resolve) => orphan.once("close", resolve));
      orphan.stdout.resume();
      orphan.stderr.resume();
      orphan.stdin.on("error", () => {});
      await until(() => sockets.size > 0);
      orphan.stdin.end();
      assert.equal(await closed, 1);
      await until(() => !alive());
    } finally {
      svc.stopAll();
      if (orphan?.exitCode === null) orphan.kill();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
