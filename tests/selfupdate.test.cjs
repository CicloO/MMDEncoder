const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { assetsFor, RELEASES_URL } = require("../backend/update.cjs");
const { createUpdater } = require("../backend/selfupdate.cjs");
const extractor = path.resolve(__dirname, "../assets/7za.exe");

function portable(dir, version, extra = {}) {
  fs.mkdirSync(path.join(dir, "resources", "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "MMDEncoder.exe"), "exe " + version);
  fs.writeFileSync(
    path.join(dir, "resources", "app", "package.json"),
    JSON.stringify({ version }),
  );
  for (const [name, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}
// A release ZIP shaped like scripts/zip-portable.mjs output, served by a fake fetch.
function release(root, version, { tamper = false } = {}) {
  const src = path.join(root, "build", "MMDEncoder");
  portable(src, version, {
    "新文件.txt": "new",
    "resources/app/backend/install-update.cjs": "// helper",
  });
  const zip = path.join(root, `MMDEncoder-${version}-win-x64.zip`);
  execFileSync(extractor, ["a", "-tzip", zip, "MMDEncoder" + path.sep], {
    cwd: path.dirname(src),
    windowsHide: true,
  });
  const sha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(zip))
    .digest("hex");
  const base = RELEASES_URL + "/download/v" + version + "/";
  const info = {
    newer: true,
    latest: version,
    assets: assetsFor(
      {
        assets: [
          {
            name: path.basename(zip),
            size: fs.statSync(zip).size,
            browser_download_url: base + path.basename(zip),
          },
          {
            name: path.basename(zip) + ".sha256",
            browser_download_url: base + path.basename(zip) + ".sha256",
          },
        ],
      },
      version,
    ),
  };
  const fetchImpl = async (url) => {
    if (url.endsWith(".sha256"))
      return {
        ok: true,
        text: async () =>
          (tamper ? "0".repeat(64) : sha) + "  " + path.basename(zip),
      };
    return {
      ok: true,
      body: fs.createReadStream(zip),
      headers: { get: () => String(fs.statSync(zip).size) },
    };
  };
  return { info, fetchImpl };
}

test("release assets must come from this repository's downloads", () => {
  const name = "MMDEncoder-1.3.0-win-x64.zip";
  const good = RELEASES_URL + "/download/v1.3.0/";
  const r = (url) =>
    assetsFor(
      {
        assets: [
          { name, browser_download_url: url + name, size: 5 },
          {
            name: name + ".sha256",
            browser_download_url: url + name + ".sha256",
          },
        ],
      },
      "1.3.0",
    );
  assert.equal(r(good).zipUrl, good + name);
  assert.equal(r("https://example.com/"), null);
  assert.equal(assetsFor({ assets: [] }, "1.3.0"), null);
});

test(
  "update downloads, verifies, swaps program files and keeps data",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-selfupdate-"));
    try {
      const appDir = path.join(root, "程序 目录");
      portable(appDir, "1.0.0", {
        "旧文件.txt": "old",
        "data/settings.json": '{"version":1}',
      });
      const { info, fetchImpl } = release(root, "1.0.1");
      const logDir = path.join(appDir, "data", "logs");
      const updater = createUpdater({
        appDir,
        version: "1.0.0",
        extractor,
        logDir,
        fetchImpl,
      });
      assert.equal(updater.supported(), "");
      await updater.download(info);
      assert.equal(updater.state.phase, "ready");
      assert.equal(
        fs.readFileSync(path.join(appDir, "MMDEncoder.exe"), "utf8"),
        "exe 1.0.0",
        "nothing changes before install",
      );
      // A pid that is not running: the helper starts the swap right away.
      // Node stands in for the new exe in Node mode; the real helper runs.
      updater.install(2 ** 30, {
        relaunch: false,
        runner: process.execPath,
        helper: path.resolve(__dirname, "../backend/install-update.cjs"),
      });
      const log = path.join(logDir, "update.log");
      for (let i = 0; i < 200; i++) {
        if (
          fs.existsSync(log) &&
          /更新完成|更新失败/.test(fs.readFileSync(log, "utf8")) &&
          !fs.existsSync(path.join(appDir, ".update", "old"))
        )
          break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(fs.readFileSync(log, "utf8"), /更新完成/);
      assert.equal(
        fs.readFileSync(path.join(appDir, "MMDEncoder.exe"), "utf8"),
        "exe 1.0.1",
      );
      assert.equal(
        fs.readFileSync(path.join(appDir, "新文件.txt"), "utf8"),
        "new",
      );
      assert.equal(fs.existsSync(path.join(appDir, "旧文件.txt")), false);
      assert.equal(
        fs.readFileSync(path.join(appDir, "data", "settings.json"), "utf8"),
        '{"version":1}',
      );
      assert.equal(fs.existsSync(path.join(appDir, ".update", "old")), false);
      updater.cleanup();
      assert.equal(fs.existsSync(path.join(appDir, ".update")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a tampered download is rejected and leaves the program untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-selfupdate-"));
  try {
    const appDir = path.join(root, "app");
    portable(appDir, "1.0.0");
    const { info, fetchImpl } = release(root, "1.0.1", { tamper: true });
    const updater = createUpdater({
      appDir,
      version: "1.0.0",
      extractor,
      logDir: path.join(root, "logs"),
      fetchImpl,
    });
    await assert.rejects(updater.download(info), /SHA-256/);
    assert.equal(updater.state.phase, "failed");
    assert.throws(() => updater.install(), /尚未下载完成/);
    assert.equal(fs.existsSync(path.join(appDir, ".update")), false);
    assert.match(
      createUpdater({
        appDir: root,
        version: "1.0.0",
        extractor,
        logDir: root,
      }).supported(),
      /开发版或非便携目录/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a kept recovery copy (.update/old) survives cleanup, failed and successful downloads and the next install",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-selfupdate-"));
    try {
      const appDir = path.join(root, "app");
      portable(appDir, "1.0.0");
      // Several earlier failed restores, each kept in its own numbered folder.
      const kept_ = ["old", "old-2", "old-3"].map((n) =>
        path.join(appDir, ".update", n, "preserved.txt"),
      );
      for (const p of kept_) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "earlier program files");
      }
      const kept = () => {
        for (const p of kept_)
          assert.equal(fs.readFileSync(p, "utf8"), "earlier program files", p);
      };
      const logDir = path.join(root, "logs");
      const make = (fetchImpl) =>
        createUpdater({
          appDir,
          version: "1.0.0",
          extractor,
          logDir,
          fetchImpl,
        });

      make().cleanup();
      kept();
      // Network error, then a checksum mismatch.
      const offline = make(async () => {
        throw Error("offline");
      });
      const { info } = release(root, "1.0.1");
      await assert.rejects(offline.download(info), /offline/);
      kept();
      const bad = release(path.join(root, "bad"), "1.0.1", { tamper: true });
      fs.mkdirSync(path.join(root, "bad"), { recursive: true });
      await assert.rejects(make(bad.fetchImpl).download(bad.info), /SHA-256/);
      kept();
      // A good download and install: the swap uses its own backup folder.
      const good = release(path.join(root, "good"), "1.0.1");
      const updater = make(good.fetchImpl);
      await updater.download(good.info);
      kept();
      updater.install(2 ** 30, {
        relaunch: false,
        runner: process.execPath,
        helper: path.resolve(__dirname, "../backend/install-update.cjs"),
      });
      const log = path.join(logDir, "update.log");
      for (let i = 0; i < 200; i++) {
        if (
          fs.existsSync(log) &&
          /更新完成|更新失败/.test(fs.readFileSync(log, "utf8")) &&
          !fs.existsSync(path.join(appDir, ".update", "old-4"))
        )
          break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(fs.readFileSync(log, "utf8"), /更新完成/);
      assert.equal(
        fs.readFileSync(path.join(appDir, "MMDEncoder.exe"), "utf8"),
        "exe 1.0.1",
      );
      kept();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "after updating, the app is relaunched as an app, not in the helper's Node mode",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-relaunch-"));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    try {
      const appDir = path.join(root, "app");
      const newDir = path.join(root, "new");
      fs.mkdirSync(appDir);
      fs.mkdirSync(newDir);
      // The "new version" is Node itself named MMDEncoder.exe; a preload hook
      // records the environment it was started with.
      fs.copyFileSync(process.execPath, path.join(newDir, "MMDEncoder.exe"));
      const seen = path.join(root, "seen.json");
      const hook = path.join(root, "hook.cjs");
      fs.writeFileSync(
        hook,
        `if (require("path").basename(process.execPath) === "MMDEncoder.exe") {
  require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    pid: process.pid,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    job: process.env.MMD_UPDATE_JOB ?? null,
  }));
  process.exit(0);
}`,
      );
      const log = path.join(root, "update.log");
      const { spawn } = require("node:child_process");
      const helper = spawn(
        process.execPath,
        [path.resolve(__dirname, "../backend/install-update.cjs")],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            NODE_OPTIONS: "--require " + JSON.stringify(hook),
            ELECTRON_RUN_AS_NODE: "1",
            MMD_UPDATE_JOB: JSON.stringify({
              appDir,
              newDir,
              backup: path.join(root, "old"),
              pid: 0,
              log,
              keep: [],
              relaunch: true,
            }),
          },
        },
      );
      await new Promise((r) => helper.on("close", r));
      for (let i = 0; i < 100 && !fs.existsSync(seen); i++)
        await new Promise((r) => setTimeout(r, 100));
      assert.match(fs.readFileSync(log, "utf8"), /更新完成/);
      const { pid, ...environment } = JSON.parse(fs.readFileSync(seen, "utf8"));
      const running = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      };
      for (let i = 0; i < 100 && running(); i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        running(),
        false,
        "the test relaunch process must exit before cleanup",
      );
      assert.deepEqual(environment, {
        runAsNode: null,
        job: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
