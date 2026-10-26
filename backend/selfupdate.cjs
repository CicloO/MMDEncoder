"use strict";
// In-place update of the portable build: download the release ZIP, check its
// SHA-256 against the release's .sha256 file, extract it next to the program,
// then a helper (install-update.cjs) swaps the program files after the app exits. The
// user's data folder is never touched; a failed swap restores the old files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { appError, serializeError, restoreError } = require("./errors.cjs");

const EXE = "MMDEncoder.exe";
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
  electronVersion = process.versions.electron,
  fetchImpl = fetch,
}) {
  const work = path.join(appDir, ".update");
  const state = {
    phase: "idle",
    received: 0,
    total: 0,
    error: "",
    errorData: null,
    packageKind: "full",
    fallbackData: null,
    latest: "",
  };
  let prepared = null;

  function supported() {
    if (!isPortableDir(appDir))
      return serializeError(appError("UPDATE_NOT_PORTABLE"));
    if (!writable(appDir))
      return serializeError(appError("UPDATE_NOT_WRITABLE"));
    return null;
  }

  async function download(info) {
    if (["downloading", "extracting", "installing"].includes(state.phase))
      throw appError("UPDATE_ALREADY_DOWNLOADING");
    if (!info?.newer || !info.assets) throw appError("UPDATE_ASSET_MISSING");
    const blocked = supported();
    if (blocked) throw restoreError(blocked);
    Object.assign(state, {
      phase: "downloading",
      received: 0,
      total: info.assets.size,
      error: "",
      errorData: null,
      fallbackData: null,
      latest: info.latest,
    });
    prepared = null;
    try {
      try {
        await prepareAsset(info.assets);
      } catch (error) {
        if (info.assets.kind !== "app" || !info.assets.fallback) throw error;
        state.fallbackData = serializeError(error);
        await prepareAsset(info.assets.fallback);
      }
    } catch (e) {
      const errorData = serializeError(e);
      Object.assign(state, {
        phase: "failed",
        error: errorData.message,
        errorData,
      });
      clearWork();
      throw e;
    }
  }

  async function prepareAsset(asset) {
    Object.assign(state, {
      phase: "downloading",
      received: 0,
      total: asset.size,
      packageKind: asset.kind || "full",
    });
    clearWork();
    fs.mkdirSync(work, { recursive: true });
    const zip = path.join(work, asset.zipName);
    const headers = { "User-Agent": "MMDEncoder/" + version };
    const sums = await fetchImpl(asset.shaUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!sums.ok)
      throw appError("UPDATE_CHECKSUM_DOWNLOAD", { status: sums.status });
    const expected = /^[0-9a-f]{64}/i.exec((await sums.text()).trim())?.[0];
    if (!expected) throw appError("UPDATE_CHECKSUM_FORMAT");
    if (asset.sha256 && expected.toLowerCase() !== asset.sha256.toLowerCase())
      throw appError("UPDATE_CHECKSUM_MISMATCH");
    const response = await fetchImpl(asset.zipUrl, { headers });
    if (!response.ok || !response.body)
      throw appError("UPDATE_ARCHIVE_DOWNLOAD", { status: response.status });
    state.total = Number(response.headers.get("content-length")) || state.total;
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
      throw appError("UPDATE_CHECKSUM_MISMATCH");
    if (asset.size && state.received !== asset.size)
      throw appError("UPDATE_SIZE_MISMATCH");
    state.phase = "extracting";
    const unpacked = path.join(work, "new");
    await new Promise((resolve, reject) =>
      execFile(
        extractor,
        ["x", "-y", "-o" + unpacked, zip],
        { windowsHide: true, timeout: 300000 },
        (e, _o, stderr) =>
          e
            ? reject(
                appError("UPDATE_EXTRACT_FAILED", {
                  detail: stderr || e.message,
                }),
              )
            : resolve(),
      ),
    );
    fs.rmSync(zip, { force: true });
    const appOnly = asset.kind === "app";
    const newDir = appOnly ? unpacked : path.join(unpacked, "MMDEncoder");
    if (appOnly) {
      if (
        fs.readdirSync(unpacked).join() !== "resources" ||
        fs.readdirSync(path.join(unpacked, "resources")).join() !== "app" ||
        !fs.existsSync(path.join(newDir, "resources", "app", "package.json"))
      )
        throw appError("UPDATE_INVALID_APP_PACKAGE");
    } else if (!isPortableDir(newDir)) throw appError("UPDATE_INVALID_PACKAGE");
    if (!fs.existsSync(path.join(newDir, HELPER)))
      throw appError("UPDATE_HELPER_MISSING");
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(newDir, "resources", "app", "package.json"),
        "utf8",
      ),
    );
    if (pkg.version !== state.latest)
      throw appError("UPDATE_VERSION_MISMATCH", {
        actual: pkg.version,
        expected: state.latest,
      });
    if (
      appOnly &&
      (pkg.electronVersion !== electronVersion ||
        asset.electronVersion !== electronVersion)
    )
      throw appError("UPDATE_RUNTIME_MISMATCH");
    if (fs.existsSync(path.join(newDir, "data")))
      throw appError("UPDATE_PACKAGE_HAS_DATA");
    prepared = { newDir, latest: state.latest, kind: asset.kind || "full" };
    state.phase = "ready";
  }

  // Start the helper that waits for this process to exit, swaps the files and
  // relaunches. The caller quits the app right after. The helper runs from the
  // staged version in Node mode, using the installed exe for app-only packages
  // and the new exe for full packages. No PowerShell or console window.
  function install(
    pid = process.pid,
    { relaunch = true, runner, helper } = {},
  ) {
    if (state.phase !== "ready" || !prepared)
      throw appError("UPDATE_NOT_READY");
    fs.mkdirSync(logDir, { recursive: true });
    const child = spawn(
      runner ||
        path.join(prepared.kind === "app" ? appDir : prepared.newDir, EXE),
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
            kind: prepared.kind,
            backup: freshBackup(),
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
    return child.pid;
  }

  // A folder "old" (or "old-2", …) means a swap could not be restored: it
  // holds earlier program files the user may still need, so nothing here ever
  // deletes it — not a new download, not a failed one, not the next install.
  const isRecovery = (name) => /^old(-\d+)?$/.test(name);
  // Remove what downloads left behind (zip, unpacked "new"), keeping "old*".
  function clearWork() {
    let names = [];
    try {
      names = fs.readdirSync(work);
    } catch {
      return;
    }
    for (const name of names)
      if (!isRecovery(name))
        try {
          fs.rmSync(path.join(work, name), { recursive: true, force: true });
        } catch {
          // The helper may still be exiting from .update/new; next start retries.
        }
    try {
      if (!fs.readdirSync(work).length) fs.rmdirSync(work);
    } catch {}
  }
  // The install helper deletes its backup folder after a good swap, so it
  // gets one that holds nothing else.
  function freshBackup() {
    for (let n = 1; ; n++) {
      const dir = path.join(work, n === 1 ? "old" : "old-" + n);
      if (!fs.existsSync(dir)) return dir;
    }
  }
  function cleanup() {
    clearWork();
  }

  return { state, supported, download, install, cleanup };
}

module.exports = { createUpdater, isPortableDir, KEEP };
