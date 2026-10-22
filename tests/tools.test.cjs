require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { createTools, trusted } = require("../backend/tools.cjs");
test("download source policy rejects HTTP, credentials and unrelated hosts", () => {
  for (const url of [
    "http://github.com/a",
    "https://evil.example/a",
    "https://github.com@evil.example/a",
    "https://github.com:444/a",
  ])
    assert.throws(() => trusted(url));
  assert.equal(
    trusted("https://release-assets.githubusercontent.com/a"),
    "https://release-assets.githubusercontent.com/a",
  );
});
test("staged install, hash failure rollback, offline reuse and duplicate lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-tools-test-"));
  let version = "1",
    bad = false,
    offline = false,
    unblock;
  const bytes = Buffer.from("fixture archive");
  const release = () => [
    {
      id: "ffmpeg",
      version,
      url: "https://www.gyan.dev/fixture.7z",
      sha256: bad
        ? "0".repeat(64)
        : crypto.createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const manager = createTools({
    root,
    resolveReleases: async () => {
      if (offline) throw Error("offline");
      if (unblock) await new Promise((r) => (unblock = r));
      return release();
    },
    downloadRequest: async () => new Response(bytes),
    extract: async (_exe, args) => {
      if (args[0] === "l")
        return "Path = bin/ffmpeg.exe\nPath = bin/ffprobe.exe";
      const dest = args.find((a) => a.startsWith("-o")).slice(2);
      fs.mkdirSync(path.join(dest, "bin"));
      for (const n of ["ffmpeg", "ffprobe"])
        fs.writeFileSync(path.join(dest, "bin", n + ".exe"), "fixture");
      return "";
    },
    verify: async () => "version",
  });
  try {
    await manager.run(true);
    const old = manager.paths().ffmpeg;
    assert.ok(fs.existsSync(old));
    version = "2";
    bad = true;
    await assert.rejects(manager.run(true), /SHA-256/);
    assert.equal(manager.paths().ffmpeg, old);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "active.json"))).ffmpeg
        .version,
      "1",
    );
    offline = true;
    await assert.rejects(manager.run(), /offline/);
    assert.equal(createTools({ root }).paths().ffmpeg, old);
    offline = false;
    bad = false;
    unblock = () => {};
    const pending = manager.run(true);
    await assert.rejects(manager.run(true), /正在进行/);
    unblock();
    unblock = null;
    await pending;
    assert.notEqual(manager.paths().ffmpeg, old);
    assert.ok(fs.existsSync(old));
    assert.ok(!fs.readdirSync(root).some((n) => n.startsWith("staging-")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("unsafe archive paths rejected before extraction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-tools-path-"));
  let extracted = false;
  const m = createTools({
    root,
    resolveReleases: async () => [
      {
        id: "nvencc",
        version: "1",
        url: "https://github.com/rigaya/NVEnc/a.7z",
      },
    ],
    downloadRequest: async () => new Response("test"),
    extract: async (_e, args) => {
      if (args[0] === "l") return "Path = ../../outside.exe";
      extracted = true;
    },
  });
  try {
    await assert.rejects(m.run(true), /不安全路径/);
    assert.equal(extracted, false);
    assert.equal(fs.existsSync(path.join(root, "active.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("install location can move installed tools, reuse an existing install and be remembered", async () => {
  const { createService } = require("../backend/service.cjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-tools-move-"));
  try {
    const from = path.join(base, "a"),
      to = path.join(base, "b"),
      data = path.join(base, "data");
    fs.mkdirSync(path.join(from, "ffmpeg-1"), { recursive: true });
    fs.writeFileSync(path.join(from, "ffmpeg-1", "ffmpeg.exe"), "");
    fs.writeFileSync(path.join(from, "ffmpeg-1", "ffprobe.exe"), "");
    fs.writeFileSync(
      path.join(from, "active.json"),
      JSON.stringify({ ffmpeg: { version: "1", directory: "ffmpeg-1" } }),
    );
    const tools = createTools({ root: from });
    assert.equal(tools.state.installed.ffmpeg.version, "1");
    fs.mkdirSync(path.join(base, "busy"));
    fs.writeFileSync(path.join(base, "busy", "x.txt"), "");
    assert.throws(() => tools.relocate(path.join(base, "busy")), /空文件夹/);
    assert.throws(() => tools.relocate(path.join(from, "sub")), /之内/);
    tools.relocate(to);
    assert.equal(tools.state.root, to);
    assert.equal(fs.existsSync(path.join(from, "active.json")), false);
    assert.ok(tools.paths().ffmpeg.startsWith(to));
    // A folder that already holds an installation is reused as-is.
    const again = createTools({ root: path.join(base, "empty") });
    again.relocate(to);
    assert.equal(again.state.installed.ffmpeg.version, "1");

    // The service remembers the choice in data/tools-location.json.
    const prev = process.env.MMD_TEST_TOOLS_ROOT;
    delete process.env.MMD_TEST_TOOLS_ROOT;
    try {
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(
        path.join(data, "tools-location.json"),
        JSON.stringify({ root: to }),
      );
      const svc = createService({ dataDir: data, toolsRoot: undefined });
      try {
        assert.equal(svc.getState().tools.root, to);
      } finally {
        svc.dispose();
      }
    } finally {
      if (prev !== undefined) process.env.MMD_TEST_TOOLS_ROOT = prev;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a move that fails halfway puts everything back; a half-moved folder is not taken as an installation", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-tools-fail-"));
  const rename = fs.renameSync;
  try {
    const from = path.join(base, "a"),
      to = path.join(base, "b");
    fs.mkdirSync(path.join(from, "ffmpeg-1"), { recursive: true });
    fs.writeFileSync(path.join(from, "ffmpeg-1", "ffmpeg.exe"), "");
    fs.writeFileSync(path.join(from, "ffmpeg-1", "ffprobe.exe"), "");
    fs.writeFileSync(
      path.join(from, "active.json"),
      JSON.stringify({ ffmpeg: { version: "1", directory: "ffmpeg-1" } }),
    );
    const tools = createTools({ root: from });
    const before = tools.paths().ffmpeg;
    assert.ok(before);
    // The tool folder cannot be moved (in use, no permission, …).
    fs.renameSync = (a, b) => {
      if (String(a).includes("ffmpeg-1") && String(a).startsWith(from)) {
        const e = Error("EACCES: permission denied");
        e.code = "EACCES";
        throw e;
      }
      return rename(a, b);
    };
    assert.throws(() => tools.relocate(to), /已恢复原位置/);
    fs.renameSync = rename;
    assert.equal(tools.state.root, from);
    assert.equal(tools.paths().ffmpeg, before);
    assert.ok(fs.existsSync(path.join(from, "active.json")));
    assert.equal(fs.existsSync(path.join(to, "active.json")), false);

    // A target holding only a manifest (what the old code left) is refused.
    const half = path.join(base, "half");
    fs.mkdirSync(half);
    fs.copyFileSync(
      path.join(from, "active.json"),
      path.join(half, "active.json"),
    );
    assert.throws(() => tools.relocate(half), /不完整/);
    assert.equal(tools.paths().ffmpeg, before);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
