// Actual service preview and native copy dispatcher, with clipboard captured.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pseudoCatalog } from "./fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
const { ff } = require("./engines.cjs");
const baseline = process.argv.includes("--baseline"),
  root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/copy-command-")),
  input = path.join(dir, "User source '{x}.mkv"),
  data = path.join(dir, "data");
execFileSync(
  ff,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=64x64:r=30:d=0.2",
    "-c:v",
    "ffv1",
    input,
  ],
  { windowsHide: true },
);
const source = require("../locales/zh-CN.json"),
  pseudo = pseudoCatalog(source);
Object.assign(pseudo, {
  "command.outputExists": 'Output fixture exists: "$value" ` {literal}',
  "command.failed": 'Encoding fixture failed: "$value" ` {literal}',
  "command.pipeFailed": 'Pipe fixture failed {code}: "$value" ` {literal}',
  "command.requiresPowerShell7":
    'Requires fixture PowerShell 7: "$value" ` {literal}',
});
const catalog = path.join(dir, "test-only.json");
fs.writeFileSync(catalog, JSON.stringify(pseudo));
const registry = {
  ...require("../locales/registry.json"),
  locales: [
    ...require("../locales/registry.json").locales,
    { id: "en-XA", name: "Test English", file: catalog },
  ],
};
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({
    version: require("../package.json").version,
    main: "main.cjs",
  }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `
const {createRequire}=require('node:module'),native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});native('../locales/registry.json').locales=${JSON.stringify(registry.locales)};const d=native('../backend/detect.cjs'),create=d.createDetector,core=native('../backend/core.cjs');d.createDetector=options=>({...create(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});const service=native('../backend/service.cjs'),make=service.createService;service.createService=options=>make({...options,localeRegistry:${JSON.stringify(registry)}});const u=native('../backend/update.cjs');u.checkForUpdate=async current=>({current,latest:current,newer:false,url:u.RELEASES_URL});const {clipboard}=native('electron');global.copies=[];clipboard.writeText=value=>global.copies.push(value);native('./main.cjs');`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: data,
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible();
  const invoke = (action, payload) =>
    page.evaluate(
      ([action, payload]) => window.encoder.invokeResult(action, payload),
      [action, payload],
    );
  await invoke("add", { paths: [input] });
  await expect
    .poll(async () => {
      const s = await invoke("state");
      return !s.detecting && s.jobs[0]?.status === "ready";
    })
    .toBe(true);
  const state = await invoke("state"),
    id = state.jobs[0].id;
  const first = await invoke("copyCommand", { id });
  assert.deepEqual(first.errors, []);
  let copies = await app.evaluate(() => global.copies);
  assert.equal(copies.length, 1);
  assert.equal(copies[0], first.command);
  assert.ok(copies[0].includes("输出已存在，停止以避免覆盖"));
  assert.ok(copies[0].includes("User source ''{x}.mkv"));
  let translated = null;
  if (!baseline) {
    await invoke("setLocale", { locale: "en-XA" });
    const next = await invoke("copyCommand", { id });
    copies = await app.evaluate(() => global.copies);
    assert.equal(copies.length, 2);
    assert.equal(copies[1], next.command);
    assert.ok(copies[1].includes("Output fixture exists:"));
    assert.ok(copies[1].includes("Encoding fixture failed:"));
    assert.ok(copies[1].includes("`$value"));
    assert.ok(copies[1].includes('`"'));
    assert.deepEqual(
      copies[1].split("\r\n").filter((x) => x.startsWith("& ")),
      copies[0].split("\r\n").filter((x) => x.startsWith("& ")),
    );
    const after = await invoke("state");
    assert.deepEqual(after.settings, state.settings);
    assert.deepEqual(after.presets, state.presets);
    assert.equal(after.jobs[0].status, "ready");
    translated = copies[1].replaceAll(dir, "<testdir>");
  }
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        baseline,
        checks: [
          "actual-preview-copy-uses-generated-parameters-and-literal-user-path",
          ...(baseline
            ? []
            : ["copy-time-saved-locale-changes-only-script-messages"]),
        ],
        sourceScript: copies[0].replaceAll(dir, "<testdir>"),
        translated,
      },
      null,
      2,
    ),
  );
  console.log("Native generated copy command PASS", dir);
} catch (error) {
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        copies: await app.evaluate(() => global.copies),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
