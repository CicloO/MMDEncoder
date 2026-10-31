require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createTools } = require("../backend/tools.cjs");

test("local archives detect tool families offline, verify every executable before one activation, preserve previous tools on failure and share the install lock", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-local-tools-"));
  const root = path.join(base, "tools"),
    archive = path.join(base, "User 工具.zip");
  fs.writeFileSync(archive, "archive snapshot");
  let names = ["ffmpeg.exe", "ffprobe.exe"],
    unsafe = false,
    fail = false,
    pause,
    release;
  let extracted = 0,
    onlineCalls = 0;
  const verified = [];
  const manager = createTools({
    root,
    resolveReleases: async () => {
      onlineCalls++;
      throw Error("must remain offline");
    },
    downloadRequest: async () => {
      onlineCalls++;
      throw Error("must remain offline");
    },
    extract: async (_exe, args) => {
      if (pause)
        await new Promise((resolve) => {
          release = resolve;
        });
      if (args[0] === "l")
        return unsafe
          ? "Path = ../outside.exe"
          : names.map((name) => "Path = bin/" + name).join("\n");
      extracted++;
      const dest = args.find((arg) => arg.startsWith("-o")).slice(2);
      fs.mkdirSync(path.join(dest, "bin"));
      for (const name of names)
        fs.writeFileSync(path.join(dest, "bin", name), "fixture executable");
      return "";
    },
    verify: async (exe, args) => {
      verified.push(path.basename(exe));
      if (fail && /NVEncC/.test(exe))
        throw Error("foreign executable diagnostic stays exact");
      return /NVEncC/.test(exe)
        ? "NVEncC (x64) 9.05 (r3456)"
        : "ffmpeg version 9.0.2-full_build";
    },
  });
  try {
    for (const invalid of [
      undefined,
      null,
      "relative.zip",
      path.join(base, "wrong.exe"),
    ])
      await assert.rejects(manager.installLocal(invalid), {
        code: "TOOLS_ARCHIVE_INVALID",
      });
    await manager.installLocal(archive);
    const ff = manager.paths().ffmpeg;
    assert.ok(ff && manager.paths().ffprobe);
    assert.equal(manager.state.installed.ffmpeg.version, "9.0.2-full_build");
    assert.equal(manager.state.installed.ffmpeg.source, "local");
    assert.equal(manager.state.installed.ffmpeg.verifiedHash, false);
    assert.match(manager.state.installed.ffmpeg.sha256, /^[a-f0-9]{64}$/);
    const original = fs.readFileSync(archive, "utf8");
    names = ["ffmpeg.exe"];
    await assert.rejects(manager.installLocal(archive), {
      code: "TOOLS_EXECUTABLE_MISSING",
    });
    assert.equal(manager.paths().ffmpeg, ff);
    names = ["README.txt"];
    await assert.rejects(manager.installLocal(archive), {
      code: "TOOLS_ARCHIVE_UNRECOGNIZED",
    });
    const count = extracted;
    unsafe = true;
    await assert.rejects(manager.installLocal(archive), {
      code: "TOOLS_UNSAFE_ARCHIVE_PATH",
    });
    assert.equal(extracted, count);
    unsafe = false;
    names = ["ffmpeg.exe", "ffprobe.exe", "NVEncC64.exe"];
    fail = true;
    const oldManifest = fs.readFileSync(path.join(root, "active.json"), "utf8");
    await assert.rejects(
      manager.installLocal(archive),
      /foreign executable diagnostic stays exact/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "active.json"), "utf8"),
      oldManifest,
    );
    assert.equal(manager.paths().nvencc, undefined);
    fail = false;
    await manager.installLocal(archive);
    assert.notEqual(manager.paths().ffmpeg, ff);
    assert.ok(manager.paths().nvencc);
    assert.equal(manager.state.installed.nvencc.version, "9.05");
    assert.equal(
      manager.state.installed.ffmpeg.directory,
      manager.state.installed.nvencc.directory,
    );
    assert.deepEqual(Object.keys(createTools({ root }).paths()).sort(), [
      "ffmpeg",
      "ffprobe",
      "nvencc",
    ]);
    pause = true;
    const pending = manager.installLocal(archive);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(manager.installLocal(archive), { code: "TOOLS_BUSY" });
    await assert.rejects(manager.run(true), { code: "TOOLS_BUSY" });
    pause = false;
    release();
    await pending;
    assert.equal(onlineCalls, 0);
    assert.equal(fs.readFileSync(archive, "utf8"), original);
    assert.ok(
      !fs.readdirSync(root).some((name) => name.startsWith("staging-")),
    );
    assert.equal(manager.state.busy, false);
    assert.equal(manager.state.errorData, null);
    assert.ok(
      verified.includes("ffprobe.exe") && verified.includes("NVEncC64.exe"),
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
