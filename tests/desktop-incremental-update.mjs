// Release-equivalent builds and real Electron helper transactions. All versions,
// payload markers, settings and downloads below live in this test's own folder.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./isolate.cjs");
const { checkForUpdate, RELEASES_URL } = require("../backend/update.cjs");
const { createUpdater } = require("../backend/selfupdate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const resumed =
  process.argv[2] === "--resume" ? path.resolve(process.argv[3]) : null;
const dir =
  resumed ||
  fs.mkdtempSync(path.join(root, "verification/i18n/incremental-real-"));
assert.equal(path.dirname(dir), path.join(root, "verification/i18n"));
assert.ok(path.basename(dir).startsWith("incremental-real-"));
const runFile = promisify(execFile);
async function run(exe, args, options = {}) {
  const { stdout, stderr } = await runFile(exe, args, {
    windowsHide: true,
    maxBuffer: 16 << 20,
    ...options,
  });
  fs.appendFileSync(path.join(dir, "build.log"), stdout + stderr);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function tree(folder, exclude = []) {
  exclude = exclude.map((name) => path.normalize(name));
  const result = {};
  async function walk(current) {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, e.name),
        relative = path.relative(folder, file);
      if (
        exclude.some(
          (name) => relative === name || relative.startsWith(name + path.sep),
        )
      )
        continue;
      if (e.isDirectory()) await walk(file);
      else result[relative] = await digest(file);
    }
  }
  await walk(folder);
  return result;
}
async function build(version) {
  const source = path.join(dir, "source-" + version),
    portable = path.join(dir, "build-" + version);
  fs.mkdirSync(source);
  for (const name of [
    "src",
    "desktop",
    "backend",
    "locales",
    "assets",
    "scripts",
    "package.json",
    "index.html",
    "tsconfig.json",
    "vite.config.mjs",
    "DESIGN.md",
    "README.md",
    "LICENSE",
    "docs/THIRD-PARTY-NOTICES.md",
    "mmd-plugin/build/MMDEncoderPlugin.dll",
  ]) {
    const target = path.join(source, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, name), target, { recursive: true });
  }
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(source, "node_modules"),
    "junction",
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json")));
  pkg.version = version;
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(
    path.join(source, "assets/update-acceptance.txt"),
    "build " + version,
  );
  if (version !== "1.6.2")
    fs.writeFileSync(
      path.join(source, "assets/obsolete-acceptance.txt"),
      "removed by the complete app tree",
    );
  const cwd = source;
  await run(process.execPath, [path.join(source, "scripts/tokens.mjs")], {
    cwd,
  });
  await run(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    { cwd },
  );
  await run(
    process.execPath,
    [path.join(root, "node_modules/vite/bin/vite.js"), "build"],
    { cwd },
  );
  await run(process.execPath, [path.join(source, "scripts/package.mjs")], {
    cwd,
    env: { ...process.env, MMD_PACKAGE_DEST: portable },
  });
  console.log("Isolated portable build", version, portable);
  return { source, portable };
}
async function inspect(appDir, expected) {
  const app = await electron.launch({
    executablePath: path.join(appDir, "MMDEncoder.exe"),
    args: [],
    env: {
      ...process.env,
      MMD_ENCODER_TEST: "1",
      MMD_ENCODER_DATA: path.join(appDir, "data"),
      MMD_ENCODER_TOOLS_ROOT: path.join(dir, "no-tools"),
    },
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow();
    const setup = page.getByRole("dialog", { name: "编码引擎", exact: true });
    await expect(setup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "视频队列" })).toBeVisible();
    const info = await page.evaluate(() =>
      window.encoder.invokeResult("aboutInfo"),
    );
    assert.equal(info.version, expected);
    const actual = await app.evaluate(({ app }) => ({
      electron: process.versions.electron,
      packaged: app.isPackaged,
    }));
    assert.equal(actual.packaged, true);
    return actual;
  } finally {
    await app.close();
  }
}
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function transaction(updater, log, expected, lockedFile) {
  let locker;
  if (lockedFile) {
    locker = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$file = [System.IO.File]::Open($env:MMD_UPDATE_LOCK_FILE, 'Open', 'Read', 'None'); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $file.Dispose()",
      ],
      {
        windowsHide: true,
        env: { ...process.env, MMD_UPDATE_LOCK_FILE: lockedFile },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await new Promise((resolve, reject) => {
      locker.stdout.on("data", (data) => {
        if (data.toString().includes("LOCKED")) resolve();
      });
      locker.once("error", reject);
      locker.once("exit", (code) =>
        reject(Error("File locker exited before handoff: " + code)),
      );
    });
  }
  try {
    const pid = updater.install(0, { relaunch: false });
    assert.ok(pid > 0);
    for (let i = 0; i < 500 && running(pid); i++) await sleep(100);
    assert.equal(
      running(pid),
      false,
      "the actual Electron helper must finish before inspection",
    );
    const text = fs.readFileSync(log, "utf8");
    assert.match(text, expected);
    return { pid, log, text };
  } finally {
    if (locker) {
      const closed = new Promise((resolve) => locker.once("close", resolve));
      locker.stdin.end("done\n");
      await closed;
    }
  }
}
const evidence = resumed
  ? JSON.parse(fs.readFileSync(path.join(dir, "failure.json")))
  : { testOnlyVersions: true, builds: {}, scenarios: [] };
delete evidence.error;
try {
  // Three local builds cover an adjacent update and a skipped-version update;
  // the repository and user portable build keep their real version unchanged.
  for (const version of ["1.6.0", "1.6.1", "1.6.2"]) {
    if (!resumed) evidence.builds[version] = await build(version);
    else
      for (const name of [
        "backend/update.cjs",
        "backend/selfupdate.cjs",
        "backend/install-update.cjs",
        "scripts/package.mjs",
        "scripts/zip-portable.mjs",
        "src/AboutDialog.tsx",
        "src/App.tsx",
        "locales/zh-CN.json",
      ])
        assert.equal(
          await digest(path.join(root, name)),
          await digest(path.join(evidence.builds[version].source, name)),
          "resume requires unchanged product sources: " + name,
        );
  }
  const target = evidence.builds["1.6.2"],
    archives = path.join(dir, "archives");
  if (!resumed)
    await run(
      process.execPath,
      [path.join(target.source, "scripts/zip-portable.mjs")],
      {
        cwd: target.source,
        env: {
          ...process.env,
          MMD_PACKAGE_DEST: target.portable,
          MMD_ARCHIVE_DEST: archives,
        },
      },
    );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(archives, "MMDEncoder-1.6.2-update.json")),
  );
  evidence.manifest = manifest;
  evidence.archive = JSON.parse(
    fs.readFileSync(path.join(archives, "archive.json")),
  );
  assert.equal(evidence.archive.appTreesIdentical, true);
  const assets = fs
    .readdirSync(archives)
    .filter((name) => name !== "archive.json")
    .map((name) => ({
      name,
      size: fs.statSync(path.join(archives, name)).size,
      browser_download_url: `${RELEASES_URL}/download/v1.6.2/${name}`,
    }));
  const scenarios = [
    { name: "adjacent-app", from: "1.6.1" },
    { name: "skip-version-app", from: "1.6.0" },
    { name: "runtime-mismatch-full", from: "1.6.1", differentRuntime: true },
    { name: "app-file-lock-rollback", from: "1.6.1", lock: true },
  ];
  for (const scenario of scenarios) {
    if (
      resumed &&
      evidence.scenarios.some((item) => item.name === scenario.name)
    )
      continue;
    const appDir = fs.mkdtempSync(path.join(dir, scenario.name + "-")),
      old = evidence.builds[scenario.from];
    fs.cpSync(old.portable, appDir, { recursive: true });
    const actual = await inspect(appDir, scenario.from);
    const settings = path.join(appDir, "data/settings.json");
    const parsed = fs.existsSync(settings)
      ? JSON.parse(fs.readFileSync(settings))
      : {};
    parsed.updateAcceptance = { value: "保留 {a}", scenario: scenario.name };
    fs.writeFileSync(settings, JSON.stringify(parsed));
    const dataBefore = await tree(path.join(appDir, "data"));
    const runtimeBefore = await tree(appDir, [
      "resources/app",
      "data",
      ".update",
    ]);
    const appBefore = await tree(path.join(appDir, "resources/app"));
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith("/releases/latest"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: "v1.6.2", assets }),
        };
      const file = path.join(archives, url.split("/").at(-1));
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(fs.readFileSync(file)),
        text: async () => fs.readFileSync(file, "utf8"),
        body: file.endsWith(".zip") ? fs.createReadStream(file) : null,
        headers: { get: () => String(fs.statSync(file).size) },
      };
    };
    const info = await checkForUpdate(
      scenario.from,
      fetchImpl,
      scenario.differentRuntime ? "39.0.0" : actual.electron,
    );
    assert.equal(info.assets.kind, scenario.differentRuntime ? "full" : "app");
    const logDir = path.join(appDir, "data/logs");
    const u = createUpdater({
      appDir,
      version: scenario.from,
      electronVersion: actual.electron,
      extractor: path.join(appDir, "resources/app/assets/7za.exe"),
      logDir,
      fetchImpl,
    });
    await u.download(info);
    assert.equal(u.state.phase, "ready");
    assert.deepEqual(await tree(path.join(appDir, "resources/app")), appBefore);
    assert.deepEqual(await tree(path.join(appDir, "data")), dataBefore);
    const log = path.join(logDir, "update.log");
    const tx = await transaction(
      u,
      log,
      scenario.lock ? /已还原旧版本/ : /更新完成/,
      scenario.lock
        ? path.join(appDir, ".update/new/resources/app/dist/index.html")
        : null,
    );
    assert.deepEqual(
      await tree(appDir, ["resources/app", "data", ".update"]),
      scenario.differentRuntime
        ? await tree(target.portable, ["resources/app", "data", ".update"])
        : runtimeBefore,
    );
    assert.equal(fs.readFileSync(settings, "utf8"), JSON.stringify(parsed));
    assert.deepEqual(
      await tree(path.join(appDir, "resources/app")),
      scenario.lock
        ? appBefore
        : await tree(path.join(target.portable, "resources/app")),
    );
    const result = await inspect(
      appDir,
      scenario.lock ? scenario.from : "1.6.2",
    );
    assert.equal(result.electron, actual.electron);
    if (!scenario.differentRuntime)
      assert.equal(
        calls.some((url) => url.endsWith("-win-x64.zip")),
        false,
      );
    evidence.scenarios.push({
      ...scenario,
      appDir,
      selected: info.assets.kind,
      bytes: u.state.received,
      actualRuntime: actual.electron,
      simulatedSelectionRuntime: scenario.differentRuntime
        ? "39.0.0"
        : actual.electron,
      calls,
      ...tx,
    });
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log("Real portable update PASS", scenario.name, u.state.received);
  }
  console.log("Real incremental update acceptance PASS", dir);
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      { ...evidence, error: String(error.stack || error) },
      null,
      2,
    ),
  );
  throw error;
}
