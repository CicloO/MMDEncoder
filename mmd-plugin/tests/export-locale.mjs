// Actual DMO failures, translated helper errors and unmodified external causes.
// Only the simulator's own single-button error window may be dismissed.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pseudoCatalog } from "../../tests/fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const actualLocal = process.env.LOCALAPPDATA;
const { ff, fp } = require("../../tests/engines.cjs");
process.env.LOCALAPPDATA = actualLocal;
const mx = require("../../backend/mmd-export.cjs"),
  core = require("../../backend/core.cjs");
const source = require("../../locales/zh-CN.json"),
  pseudo = pseudoCatalog(source);
for (const name of ["MMDEncoder.exe", "MikuMikuDance.exe"])
  assert.ok(
    !execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    }).includes(name),
    `Close ${name} first`,
  );
const dir = fs.mkdtempSync(
  path.join(root, "verification/i18n/native-export-locale-"),
);
const files = [mx.configPath(), mx.selectionPath(), mx.historyPath()];
fs.mkdirSync(path.join(dir, "shared-before"));
const originals = files.map((file) => {
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (bytes !== null)
    fs.writeFileSync(
      path.join(dir, "shared-before", path.basename(file)),
      bytes,
    );
  return bytes;
});
const pending = path.join(path.dirname(mx.configPath()), "pending");
const previousPending = new Set(
  fs.existsSync(pending) ? fs.readdirSync(pending) : [],
);
const build = path.join(root, "mmd-plugin/build"),
  dll = path.join(build, "MMDEncoderPlugin.dll");
const settings = {
  ...core.BUILTINS.find((p) => p.id === "builtin-1080-sw").settings,
  audio: "none",
};
const checks = [];
const text = (key, params = {}, catalog = pseudo) =>
  catalog[key].replace(/\{(\w+)\}/g, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token,
  );
function configured() {
  return mx.writeConfig({
    presets: [{ id: "export-locale", name: "User 预设", settings }],
    engines: { ffmpeg: ff, ffprobe: fp },
    appExe: process.execPath,
    helper: path.join(root, "backend/mmd-export.cjs"),
    locale: "en-XA",
    catalogs: { "zh-CN": source, "en-XA": pseudo },
  });
}
function select(id = "export-locale") {
  mx.writeSelection({ presetId: id, maskMode: "off" });
}
const template = path.join(dir, "template.avi");
execFileSync(
  ff,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=16x16:r=30:d=0.1",
    "-c:v",
    "ffv1",
    template,
  ],
  { windowsHide: true },
);
const bytes = fs.readFileSync(template);
for (
  let at = bytes.indexOf("FFV1");
  at >= 0 && at < 4096;
  at = bytes.indexOf("FFV1", at + 4)
)
  bytes.write("MMDE", at, "latin1");
fs.writeFileSync(template, bytes);
function reject(name, expected, catalog = pseudo) {
  const result = spawnSync(
    path.join(build, "mmd-sim.exe"),
    [
      dll,
      template,
      path.join(dir, name + ".avi"),
      "",
      "160",
      "90",
      "30",
      "0",
      "0",
    ],
    {
      env: {
        ...process.env,
        MMD_SIM_RENDER_ERROR_PREFIX:
          catalog["plugin.exportFailed"].split("{detail}")[0],
      },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(dir, name + ".json"),
    JSON.stringify(
      {
        status: result.status,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ),
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("renderFailure="), result.stdout);
  for (const value of expected)
    assert.ok(result.stdout.includes(value), value + "\n" + result.stdout);
  checks.push(name);
}
try {
  const base = configured();
  select("not-in-config");
  reject("missing-preset", [
    text("plugin.presetFailed", { detail: text("error.MMD_PRESET_MISSING") }),
  ]);
  const invalid = structuredClone(base);
  invalid.presets[0].settings.bitDepth = 7;
  fs.writeFileSync(mx.configPath(), JSON.stringify(invalid));
  select();
  reject("validation-issues", [
    pseudo["error.VALIDATION_FAILED"],
    text("error.SETTING_VALUE_INVALID", { field: "bitDepth" }),
    pseudo["error.ENCODER_DEPTH_UNSUPPORTED"],
  ]);
  const unknown =
    "Foreign diagnostic {raw}\n" + "x".repeat(1200) + " END 用户🧪";
  const helper = path.join(dir, "helper.cjs");
  fs.writeFileSync(
    helper,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, error: unknown, errorData: { code: "FUTURE_NATIVE_CAUSE", params: {}, message: unknown } }))});`,
  );
  fs.writeFileSync(mx.configPath(), JSON.stringify({ ...base, helper }));
  reject("unknown-cause", [unknown]);
  fs.writeFileSync(helper, `process.stdout.write(${JSON.stringify(unknown)});`);
  reject("invalid-reply", [text("plugin.planMissing", { detail: unknown })]);
  fs.writeFileSync(mx.configPath(), JSON.stringify({ ...base, appExe: "" }));
  reject("incomplete-config", [pseudo["plugin.configIncomplete"]]);
  const missingExe = path.join(dir, "User {missing}.exe");
  fs.writeFileSync(
    mx.configPath(),
    JSON.stringify({
      ...base,
      engines: { ...base.engines, ffmpeg: missingExe },
    }),
  );
  reject("encoder-launch", [
    text("plugin.encoderStartFailed", { path: missingExe }),
  ]);
  fs.writeFileSync(mx.configPath(), "{invalid");
  reject("source-fallback", [source["plugin.configMissing"]], source);
  const fixture = {
    ...base,
    fixtureError: {
      code: "VALIDATION_FAILED",
      params: {},
      message: "source fallback",
      issues: [
        {
          code: "MMD_RECOVERY_EMPTY",
          params: { path: "User {raw}.mkv" },
          message: "raw fallback",
        },
      ],
    },
  };
  // The formatter's fallback for an unknown issue remains its full original text.
  fixture.fixtureError.issues.push({
    code: "FUTURE_CAUSE",
    params: {},
    message: unknown,
  });
  const formatterFile = path.join(dir, "formatter.json");
  fs.writeFileSync(formatterFile, JSON.stringify(fixture));
  const formatted = JSON.parse(
    execFileSync(path.join(build, "message-check.exe"), [formatterFile], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.equal(
    formatted.error,
    pseudo["error.VALIDATION_FAILED"] + "\nraw fallback\n" + unknown,
  );
  checks.push("formatter-issues-and-unknown-fallback");
} finally {
  files.forEach((file, i) =>
    originals[i] === null
      ? fs.rmSync(file, { force: true })
      : fs.writeFileSync(file, originals[i]),
  );
  files.forEach((file, i) =>
    assert.deepEqual(
      fs.existsSync(file) ? fs.readFileSync(file) : null,
      originals[i],
    ),
  );
  if (fs.existsSync(pending))
    for (const name of fs.readdirSync(pending)) {
      if (previousPending.has(name)) continue;
      const file = path.join(pending, name),
        value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value.avi && path.dirname(path.resolve(value.avi)) === dir)
        fs.rmSync(file);
    }
}
fs.writeFileSync(
  path.join(dir, "results.json"),
  JSON.stringify({ passed: true, checks, sharedRestored: true }, null, 2),
);
console.log("Native export locale PASS", dir);
