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
    path: installed ? registered : "",
    upToDate: installed && available && hash(registered) === hash(bundled),
  };
}

async function install(bundled) {
  if (!bundled || !fs.existsSync(bundled))
    throw Error("这个版本没有附带 MMD 导出插件");
  const dir = path.join(binDir(), hash(bundled).slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, DLL);
  if (hash(target) !== hash(bundled)) fs.copyFileSync(bundled, target);
  const r = await run(path.join(system32(), "regsvr32.exe"), ["/s", target]);
  if (r.code !== 0)
    throw Error("注册插件失败（regsvr32 退出码 " + r.code + "）");
  if ((await registeredPath()).toLowerCase() !== target.toLowerCase())
    throw Error("注册插件后没有在注册表里找到它");
  cleanup(dir);
  return status(bundled);
}

async function uninstall(bundled) {
  const registered = await registeredPath();
  if (registered && fs.existsSync(registered))
    await run(path.join(system32(), "regsvr32.exe"), ["/s", "/u", registered]);
  cleanup("");
  return status(bundled);
}

// Remove other builds; a DLL still loaded by an open MMD stays until next time.
function cleanup(keep) {
  let entries = [];
  try {
    entries = fs.readdirSync(binDir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(binDir(), e.name);
    if (keep && full.toLowerCase() === keep.toLowerCase()) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { CLSID, status, install, uninstall, registeredPath };
