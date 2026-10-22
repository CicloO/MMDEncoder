"use strict";
// Installs the MMD export plugin DLL for the current Windows user (no admin):
// copy into %LOCALAPPDATA%\MMDEncoder\mmd-plugin\bin\<hash>\ and register it
// under HKCU with regsvr32. A folder per build lets an update register a new
// DLL while an open MMD still has the old one loaded.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const CLSID = "{DC3F6BD1-923F-467A-BF73-F115AF705033}";
const BARE = CLSID.slice(1, -1);
const DLL = "MMDEncoderPlugin.dll";
const binDir = () =>
  path.join(process.env.LOCALAPPDATA || "", "MMDEncoder", "mmd-plugin", "bin");
const system32 = () =>
  path.join(process.env.SystemRoot || "C:\\Windows", "System32");

function run(exe, args) {
  return new Promise((resolve) =>
    execFile(
      exe,
      args,
      { windowsHide: true, timeout: 30000, encoding: "utf8" },
      (error, stdout) =>
        resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout || "" }),
    ),
  );
}

function hash(file) {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
  } catch {
    return "";
  }
}

// Path of the DLL the current user has registered, or "".
async function registeredPath() {
  const r = await run(path.join(system32(), "reg.exe"), [
    "query",
    `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\InprocServer32`,
    "/ve",
  ]);
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout);
  return m ? m[1] : "";
}

async function status(bundled) {
  const registered = await registeredPath();
  const installed = !!registered && fs.existsSync(registered);
  const available = !!bundled && fs.existsSync(bundled);
  return {
    available,
    installed,
    // Registered, but the DLL it points to is gone: MMD cannot load it.
    broken: !!registered && !installed,
    path: installed ? registered : "",
    upToDate: installed && available && hash(registered) === hash(bundled),
  };
}

// install.log: who installed or removed which build, and what the registry
// pointed to before and after. The registry was twice found pointing back to
// an older, deleted build; this records enough to see what did it.
function journal(event, details) {
  let version = "";
  try {
    version = require(path.join(__dirname, "..", "package.json")).version;
  } catch {}
  try {
    const dir = path.join(binDir(), "..", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "install.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        event,
        app: process.execPath,
        version,
        pid: process.pid,
        ...details,
      }) + "\n",
    );
  } catch {}
}

async function install(bundled) {
  if (!bundled || !fs.existsSync(bundled))
    throw Error("这个版本没有附带 MMD 导出插件");
  const dir = path.join(binDir(), hash(bundled).slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, DLL);
  if (hash(target) !== hash(bundled)) fs.copyFileSync(bundled, target);
  const before = await registeredPath();
  const r = await run(path.join(system32(), "regsvr32.exe"), ["/s", target]);
  if (r.code !== 0)
    throw Error("注册插件失败（regsvr32 退出码 " + r.code + "）");
  const after = await registeredPath();
  if (after.toLowerCase() !== target.toLowerCase()) {
    journal("install-failed", {
      bundled,
      target,
      before,
      after,
      regsvr32: r.code,
    });
    throw Error("注册插件后没有在注册表里找到它");
  }
  // Keep this build and the previous one: the registry has been seen pointing
  // back to an older build, and that DLL must still be there when it does.
  const removed = await cleanup([dir, before && path.dirname(before)]);
  journal("install", { bundled, target, before, after, removed });
  return status(bundled);
}

async function uninstall(bundled) {
  const registered = await registeredPath();
  if (registered && fs.existsSync(registered))
    await run(path.join(system32(), "regsvr32.exe"), ["/s", "/u", registered]);
  else if (registered)
    // The registered DLL is gone, so it cannot unregister itself: remove the
    // keys DllRegisterServer wrote (see mmd-plugin/src/plugin.cpp).
    for (const key of [
      `HKCU\\Software\\Classes\\DirectShow\\MediaObjects\\Categories\\33d9a760-90c8-11d0-bd43-00a0c911ce86\\${BARE}`,
      `HKCU\\Software\\Classes\\DirectShow\\MediaObjects\\${BARE}`,
      `HKCU\\Software\\Classes\\CLSID\\${CLSID}`,
    ])
      await run(path.join(system32(), "reg.exe"), ["delete", key, "/f"]);
  const removed = await cleanup([], { all: true });
  journal("uninstall", { registered, removed });
  return status(bundled);
}

// Remove builds older than the ones in keep (the new build and the previously
// registered one) plus the newest other folder, so two builds always remain;
// the folder the registry points to is never removed. A DLL still loaded by an
// open MMD cannot be deleted and stays until next time.
async function cleanup(keep, { all = false } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(binDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const registered = all ? "" : await registeredPath();
  const kept = new Set(
    [...keep, registered && path.dirname(registered)]
      .filter(Boolean)
      .map((p) => p.toLowerCase()),
  );
  const folders = entries.map((e) => path.join(binDir(), e.name));
  const others = folders
    .filter((full) => !kept.has(full.toLowerCase()))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  // Fewer than two builds kept here: the newest other one is the previous.
  const keptHere = folders.length - others.length;
  if (!all && keptHere < 2 && others.length) others.shift();
  const removed = [];
  for (const full of others)
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(path.basename(full));
    } catch {}
  return removed;
}

module.exports = { CLSID, status, install, uninstall, registeredPath, cleanup };
