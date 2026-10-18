"use strict";
// In-place update of the portable build: download the release ZIP, check its
// SHA-256 against the release's .sha256 file, extract it next to the program,
// then a helper (install-update.cjs) swaps the program files after the app exits. The
// user's data folder is never touched; a failed swap restores the old files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const EXE = "MMD Encoder.exe";
const HELPER = path.join("resources", "app", "backend", "install-update.cjs");
// Files and folders in the program directory the swap leaves alone.
const KEEP = ["data", ".update"];

// True when this looks like an extracted portable build we may rewrite.
function isPortableDir(dir) {
  return (
    fs.existsSync(path.join(dir, EXE)) &&
    fs.existsSync(path.join(dir, "resources", "app", "package.json"))
  );
}

function writable(dir) {
  const probe = path.join(dir, ".update-write-test-" + process.pid);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function createUpdater({
  appDir,
  version,
  extractor,
  logDir,
  fetchImpl = fetch,
}) {
  const work = path.join(appDir, ".update");
  const state = { phase: "idle", received: 0, total: 0, error: "", latest: "" };
  let prepared = null;

  function supported() {
    if (!isPortableDir(appDir))
      return "开发版或非便携目录不能自动更新，请打开下载页手动更新";
    if (!writable(appDir))
      return "程序目录没有写入权限，请打开下载页手动更新，或把软件放到可写的文件夹";
    return "";
  }

  async function download(info) {
    if (state.phase === "downloading") throw Error("正在下载更新");
    if (!info?.newer || !info.assets)
      throw Error("这个版本没有可自动安装的压缩包，请打开下载页手动更新");
    const blocked = supported();
    if (blocked) throw Error(blocked);
    Object.assign(state, {
      phase: "downloading",
      received: 0,
      total: info.assets.size,
      error: "",
      latest: info.latest,
    });
    prepared = null;
    try {
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const zip = path.join(work, info.assets.zipName);
      const headers = { "User-Agent": "MMDEncoder/" + version };
      const sums = await fetchImpl(info.assets.shaUrl, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      if (!sums.ok) throw Error("校验文件下载失败：" + sums.status);
      const expected = /^[0-9a-f]{64}/i.exec((await sums.text()).trim())?.[0];
      if (!expected) throw Error("校验文件格式无效");
      const response = await fetchImpl(info.assets.zipUrl, { headers });
      if (!response.ok || !response.body)
        throw Error("压缩包下载失败：" + response.status);
      state.total =
        Number(response.headers.get("content-length")) || state.total;
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(zip);
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          state.received += chunk.length;
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (hash.digest("hex").toLowerCase() !== expected.toLowerCase())
        throw Error("压缩包校验失败（SHA-256 不一致），已放弃更新");
      state.phase = "extracting";
      const unpacked = path.join(work, "new");
      await new Promise((resolve, reject) =>
        execFile(
          extractor,
          ["x", "-y", "-o" + unpacked, zip],
          { windowsHide: true, timeout: 300000 },
          (e, _o, stderr) =>
            e ? reject(Error("解压失败：" + (stderr || e.message))) : resolve(),
        ),
      );
      fs.rmSync(zip, { force: true });
      const newDir = path.join(unpacked, "MMDEncoder");
      if (!isPortableDir(newDir))
        throw Error("压缩包内容不是 MMD Encoder 便携版");
      if (!fs.existsSync(path.join(newDir, HELPER)))
        throw Error("新版本不支持自动更新，请打开下载页手动更新");
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(newDir, "resources", "app", "package.json"),
          "utf8",
        ),
      );
      if (pkg.version !== info.latest)
        throw Error(
          `压缩包版本 ${pkg.version} 与发行版本 ${info.latest} 不一致`,
        );
      if (fs.existsSync(path.join(newDir, "data")))
        throw Error("压缩包意外包含 data 文件夹，已放弃更新");
      prepared = { newDir, latest: info.latest };
      state.phase = "ready";
    } catch (e) {
      Object.assign(state, { phase: "failed", error: e.message });
      fs.rmSync(work, { recursive: true, force: true });
      throw e;
    }
  }

  // Start the helper that waits for this process to exit, swaps the files and
  // relaunches. The caller quits the app right after. The helper runs from the
  // new version (its own exe in Node mode), so no PowerShell or console window.
  function install(
    pid = process.pid,
    { relaunch = true, runner, helper } = {},
  ) {
    if (state.phase !== "ready" || !prepared) throw Error("更新尚未下载完成");
    fs.mkdirSync(logDir, { recursive: true });
    const child = spawn(
      runner || path.join(prepared.newDir, EXE),
      [helper || path.join(prepared.newDir, HELPER)],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: work,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          MMD_UPDATE_JOB: JSON.stringify({
            appDir,
            newDir: prepared.newDir,
            backup: path.join(work, "old"),
            pid,
            log: path.join(logDir, "update.log"),
            keep: KEEP,
            relaunch,
          }),
        },
      },
    );
    child.unref();
    state.phase = "installing";
  }

  // Remove leftovers of an earlier download. A folder "old" means a swap could
  // not be restored; it holds the previous program files, so it is kept.
  function cleanup() {
    if (fs.existsSync(path.join(work, "old"))) return;
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // The helper may still be exiting from .update/new; next start retries.
    }
  }

  return { state, supported, download, install, cleanup };
}

module.exports = { createUpdater, isPortableDir, KEEP };
