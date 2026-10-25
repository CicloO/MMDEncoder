// Standalone real-DLL settings acceptance. The app must be closed: the test
// temporarily writes the same Known Folder config which MMD reads.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pseudoCatalog } from "../../tests/fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const actualLocal = process.env.LOCALAPPDATA;
const { ff, fp, nv } = require("../../tests/engines.cjs");
process.env.LOCALAPPDATA = actualLocal;
const mx = require("../../backend/mmd-export.cjs");
const core = require("../../backend/core.cjs");
const source = require("../../locales/zh-CN.json");
for (const name of ["MMDEncoder.exe", "MikuMikuDance.exe"]) {
  if (
    execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    }).includes(name)
  )
    throw Error(`Close ${name} before native locale acceptance`);
}
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/native-locale-"));
const paths = [mx.configPath(), mx.selectionPath()];
const original = paths.map((file) =>
  fs.existsSync(file) ? fs.readFileSync(file) : null,
);
const build = path.join(root, "mmd-plugin/build");
const logsDir = path.join(path.dirname(mx.configPath()), "logs");
const pseudo = pseudoCatalog(source);
// Keep the protocol's technical success/failure mark first; expand its copy.
pseudo["plugin.testPassedShort"] = "✓ ⟦ {seconds} 秒秒 ··· ⟧";
pseudo["plugin.testFailedShort"] = "✗ ⟦ 失败失败 ··· ⟧";
function dialog(name, mask, save = false) {
  const before = new Set(fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []);
  const out = execFileSync(
    path.join(build, "mmd-sim.exe"),
    [
      "--dialog-test",
      path.join(build, "MMDEncoderPlugin.dll"),
      String(mask),
      save ? "save" : "cancel",
    ],
    {
      env: {
        ...process.env,
        MMD_SIM_SCREENSHOT: path.join(dir, name + ".bmp"),
      },
      encoding: "utf8",
      timeout: 100000,
      windowsHide: true,
    },
  );
  assert.match(out, /layoutFits=1/, out);
  assert.doesNotMatch(out, /unexpected message box/);
  const log = fs
    .readdirSync(logsDir)
    .filter((file) => !before.has(file) && !file.endsWith("-ffmpeg.log"))
    .map((file) => fs.readFileSync(path.join(logsDir, file), "utf8"))
    .join("\n");
  return { out, log };
}
try {
  const config = mx.writeConfig({
    settings: {
      ...core.DEFAULTS,
      encoder: "libx264",
      container: "mp4",
      preset: "ultrafast",
      audio: "none",
    },
    presetId: "locale-fixture",
    presetName: "User name 用户改名",
    engines: { ffmpeg: ff, ffprobe: fp, nvencc: nv },
    appExe: path.join(root, "release/MMDEncoder/MMDEncoder.exe"),
    helper: path.join(root, "backend/mmd-export.cjs"),
    locale: "en-XA",
    catalogs: { "zh-CN": source, "en-XA": pseudo },
  });
  const checkFile = path.join(dir, "formatter.json");
  fs.writeFileSync(checkFile, JSON.stringify(config));
  const formatted = JSON.parse(
    execFileSync(path.join(build, "message-check.exe"), [checkFile], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.equal(formatted.title, pseudo["plugin.title"]);
  assert.equal(formatted.brief, "✓ ⟦ 2.2 秒秒 ··· ⟧");
  assert.equal(formatted.unknown, "external fallback {raw}");
  const beforeSelection = fs.readFileSync(mx.selectionPath());
  const cancelled = dialog("pseudo-settings", 1);
  assert.ok(cancelled.out.includes(pseudo["plugin.title"]), cancelled.out);
  assert.match(cancelled.out, /testResult=✓ ⟦/);
  assert.ok(
    cancelled.log.includes(
      pseudo["message.MMD_TEST_MASK_PASSED"].split("{seconds}")[0],
    ),
    cancelled.log,
  );
  assert.deepEqual(fs.readFileSync(mx.selectionPath()), beforeSelection);
  const saved = dialog("pseudo-saved", 2, true);
  assert.match(saved.out, /testResult=✓ ⟦/);
  assert.equal(mx.readSelection().maskMode, "only");
  // The next opening reads the newly saved resource snapshot, without an app.
  const fallback = JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
  fallback.locale = "future-locale";
  delete fallback.messages;
  fs.writeFileSync(mx.configPath(), JSON.stringify(fallback));
  const missing = dialog("source-fallback", 0);
  assert.ok(missing.out.includes(source["plugin.title"]));
  assert.match(missing.out, /testResult=✓ .*秒/);
  const broken = {
    ...config,
    engines: {
      ...config.engines,
      ffmpeg: path.join(dir, "missing-ffmpeg.exe"),
    },
  };
  fs.writeFileSync(mx.configPath(), JSON.stringify(broken));
  const failed = dialog("pseudo-failure", 0);
  assert.match(failed.out, /testResult=✗ ⟦/);
  assert.ok(failed.log.includes("⟦ 编码测试失败：编码测试失败："), failed.log);
  assert.ok(
    failed.log.includes("ENOENT") || failed.log.includes("missing-ffmpeg"),
    failed.log,
  );
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify(
      {
        passed: true,
        appClosed: true,
        pseudo: cancelled.out,
        saved: saved.out,
        missing: missing.out,
        failed: failed.out,
      },
      null,
      2,
    ),
  );
  console.log("Native locale PASS", dir);
} finally {
  paths.forEach((file, i) =>
    original[i]
      ? fs.writeFileSync(file, original[i])
      : fs.rmSync(file, { force: true }),
  );
}
