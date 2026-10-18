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
  fs.writeFileSync(path.join(dir, "MMD Encoder.exe"), "exe " + version);
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
        fs.readFileSync(path.join(appDir, "MMD Encoder.exe"), "utf8"),
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
        fs.readFileSync(path.join(appDir, "MMD Encoder.exe"), "utf8"),
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
