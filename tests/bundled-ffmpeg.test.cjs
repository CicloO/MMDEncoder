require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { ff } = require("./engines.cjs");
const { createService } = require("../backend/service.cjs");

// A release carries FFmpeg in resources/ffmpeg; developer mode (source runs,
// or data/developer-tools) keeps the downloaded one first.
test("the built-in FFmpeg is used in a release, the download in developer mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-bundled-"));
  const bundled = { dir: path.dirname(ff), version: "9.0.2" };
  const open = (options) =>
    createService({
      dataDir: path.join(dir, "data"),
      toolsRoot: path.join(dir, "tools"),
      mmdPluginDll: "",
      ...options,
    });
  let svc = open({ bundledFfmpeg: bundled, developerTools: false });
  try {
    await svc.invoke("mmdStatus").catch(() => {});
    await new Promise((resolve) => {
      const wait = () =>
        svc.getState().located ? resolve() : setTimeout(wait, 50);
      wait();
    });
    let state = svc.getState();
    assert.equal(state.engineInfo.ffmpeg, path.join(bundled.dir, "ffmpeg.exe"));
    assert.equal(
      state.engineInfo.ffprobe,
      path.join(bundled.dir, "ffprobe.exe"),
    );
    assert.deepEqual(state.tools.bundled, { ffmpeg: "9.0.2" });
    svc.dispose();

    // A release whose resources/ffmpeg is missing (a program-only update
    // from before FFmpeg was built in) keeps downloading and says so.
    svc = open({ bundledFfmpeg: null, developerTools: false });
    assert.deepEqual(svc.getState().tools.bundled, { missing: true });
    svc.dispose();

    // Developer mode: no FFmpeg restriction and no hint.
    svc = open({ bundledFfmpeg: bundled, developerTools: true });
    state = svc.getState();
    assert.equal(state.tools.bundled ?? null, null);
  } finally {
    svc.dispose();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
