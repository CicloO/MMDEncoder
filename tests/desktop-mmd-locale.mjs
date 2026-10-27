// Real main -> saved service locale -> standalone snapshot -> optional real DLL.
// The test registry/catalog and all app data stay in this test's own directory.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pseudoCatalog } from "./fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
const realLocal = process.env.LOCALAPPDATA;
require("./isolate.cjs");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(
  path.join(root, "verification/i18n/mmd-app-locale-"),
);
const source = require("../locales/zh-CN.json");
const pseudo = pseudoCatalog(source);
delete pseudo["plugin.cancel"];
const catalogFile = path.join(dir, "test-only.json");
fs.writeFileSync(catalogFile, JSON.stringify(pseudo));
const registry = {
  ...require("../locales/registry.json"),
  locales: [
    ...require("../locales/registry.json").locales,
    { id: "en-XA", name: "Test English", file: catalogFile },
  ],
};
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({ main: "main.cjs" }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `
const {createRequire}=require('node:module'),native=createRequire(${JSON.stringify(path.join(root, "desktop/main.cjs"))});
native('../locales/registry.json').locales=${JSON.stringify(registry.locales)};
const detector=native('../backend/detect.cjs'),createDetector=detector.createDetector,core=native('../backend/core.cjs');
detector.createDetector=options=>({...createDetector(options),hasLibplacebo:async()=>false,hasNvencLossless:async()=>false,detectionKey:async()=>'',trialEncoders:async({found})=>found(core.ENGINES.find(e=>e.id==='libx264'))});
const updates=native('../backend/update.cjs');updates.checkForUpdate=async current=>({current,latest:current,newer:false,url:updates.RELEASES_URL});
native('./main.cjs');
`,
);
const dataDir = path.join(dir, "data");
const configPath = path.join(
  process.env.LOCALAPPDATA,
  "MMDEncoder/mmd-plugin/mmd-export.json",
);
const selectionPath = path.join(
  process.env.LOCALAPPDATA,
  "MMDEncoder/mmd-plugin/mmd-selection.json",
);
const snapshot = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
const snapshots = {};
for (const restart of [false, true]) {
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [dir],
    env: {
      ...process.env,
      MMD_ENCODER_TEST: "1",
      MMD_ENCODER_DATA: dataDir,
      MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    },
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "视频队列" }).waitFor();
    const invoke = (action, payload) =>
      page.evaluate(
        ([action, payload]) => window.encoder.invoke(action, payload),
        [action, payload],
      );
    await expect
      .poll(async () => {
        const state = await invoke("state");
        return state.located && !state.detecting;
      })
      .toBe(true);
    if (!restart) {
      const before = await invoke("state");
      snapshots.source = snapshot();
      await invoke("setLocale", { locale: "en-XA" });
      snapshots.pseudo = snapshot();
      assert.equal(snapshots.pseudo.locale, "en-XA");
      assert.equal(
        snapshots.pseudo.messages["plugin.title"],
        pseudo["plugin.title"],
      );
      assert.equal(
        snapshots.pseudo.messages["plugin.cancel"],
        source["plugin.cancel"],
      );
      const preset = before.presets.find((p) => p.id === "builtin-1080-sw");
      assert.equal(
        snapshots.pseudo.presets.find((p) => p.id === preset.id).displayName,
        pseudo[preset.nameKey],
      );
      assert.deepEqual((await invoke("state")).presets, before.presets);
      const technical = (c) =>
        c.presets.map(({ id, name, settings }) => ({ id, name, settings }));
      assert.deepEqual(
        technical(snapshots.pseudo),
        technical(snapshots.source),
      );
      assert.deepEqual(snapshots.pseudo.engines, snapshots.source.engines);
      await invoke("renamePreset", {
        id: "builtin-4k-sw",
        name: "User 用户 {raw}",
      });
      assert.equal(
        snapshot().presets.find((p) => p.id === "builtin-4k-sw").displayName,
        "User 用户 {raw}",
      );
      await invoke("mmdExportSet", {
        presetId: "builtin-1080-sw",
        maskMode: "off",
      });
      snapshots.native = snapshot();
      fs.copyFileSync(selectionPath, path.join(dir, "app-selection.json"));
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"))
          .preferences.locale,
        "en-XA",
      );
    } else {
      snapshots.restart = snapshot();
      assert.equal(snapshots.restart.locale, "en-XA");
      assert.equal(
        snapshots.restart.messages["plugin.title"],
        pseudo["plugin.title"],
      );
      assert.equal(
        snapshots.restart.presets.find((p) => p.id === "builtin-4k-sw")
          .displayName,
        "User 用户 {raw}",
      );
      await invoke("setLocale", { locale: "zh-CN" });
      snapshots.restored = snapshot();
      assert.equal(
        snapshots.restored.messages["plugin.title"],
        source["plugin.title"],
      );
      assert.equal(
        snapshots.restored.presets.find((p) => p.id === "builtin-4k-sw")
          .displayName,
        "User 用户 {raw}",
      );
      await invoke("settings", {
        patch: { encoder: "nvencc:hevc", preset: "p4" },
      });
      await invoke("savePreset", { name: "NVEncC User 用户" });
      const chosen = (await invoke("state")).presets.find(
        (p) => p.name === "NVEncC User 用户",
      );
      await page.getByRole("button", { name: "MMD 导出", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "MMD 导出",
        exact: true,
      });
      await expect(
        dialog.locator(`option[value="${chosen.id}"]`),
      ).toBeEnabled();
      await dialog.locator("#mmd-export-preset").selectOption(chosen.id);
      await expect
        .poll(async () => (await invoke("state")).mmd.presetId)
        .toBe(chosen.id);
      await dialog
        .getByRole("button", { name: "测试编码", exact: true })
        .click();
      await expect
        .poll(async () => (await invoke("state")).mmd.test?.ok, {
          timeout: 60000,
        })
        .toBe(true);
      assert.equal((await invoke("state")).mmd.test.code, "MMD_TEST_PASSED");
      snapshots.nvenccSelected = snapshot();
      assert.equal(
        snapshots.nvenccSelected.presets.find((p) => p.id === chosen.id)
          .settings.encoder,
        "nvencc:hevc",
      );
    }
  } finally {
    await app.close();
  }
}
fs.writeFileSync(
  path.join(dir, "snapshots.json"),
  JSON.stringify(snapshots, null, 2),
);
if (process.argv.includes("--native")) {
  for (const name of ["MMDEncoder.exe", "MikuMikuDance.exe"]) {
    const list = execFileSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${name}`, "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.ok(!list.includes(name), `Close ${name} before native acceptance`);
  }
  const actual = path.join(realLocal, "MMDEncoder/mmd-plugin");
  const names = ["mmd-export.json", "mmd-selection.json", "exports.jsonl"];
  const backup = path.join(dir, "shared-before");
  fs.mkdirSync(backup);
  const originals = names.map((name) => {
    const file = path.join(actual, name),
      bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (bytes !== null) fs.writeFileSync(path.join(backup, name), bytes);
    return bytes;
  });
  try {
    fs.mkdirSync(actual, { recursive: true });
    fs.writeFileSync(
      path.join(actual, names[0]),
      JSON.stringify(snapshots.native),
    );
    fs.copyFileSync(
      path.join(dir, "app-selection.json"),
      path.join(actual, names[1]),
    );
    const out = execFileSync(
      path.join(root, "mmd-plugin/build/mmd-sim.exe"),
      [
        "--dialog-test",
        path.join(root, "mmd-plugin/build/MMDEncoderPlugin.dll"),
        "0",
        "cancel",
      ],
      {
        env: {
          ...process.env,
          LOCALAPPDATA: realLocal,
          MMD_SIM_SCREENSHOT: path.join(dir, "native.bmp"),
        },
        encoding: "utf8",
        timeout: 100000,
        windowsHide: true,
      },
    );
    fs.writeFileSync(path.join(dir, "native.log"), out);
    assert.match(out, /layoutFits=1/);
    assert.doesNotMatch(out, /unexpected message box/);
    assert.ok(out.includes(pseudo["plugin.title"]), out);
    assert.ok(out.includes(pseudo["preset.default1080Software"]), out);
    assert.ok(out.includes("presetOption=User 用户 {raw}"), out);
    assert.match(out, /testResult=.*✓/);
    assert.deepEqual(
      fs.readFileSync(path.join(actual, names[1])),
      fs.readFileSync(path.join(dir, "app-selection.json")),
    );
  } finally {
    names.forEach((name, i) =>
      originals[i] === null
        ? fs.rmSync(path.join(actual, name), { force: true })
        : fs.writeFileSync(path.join(actual, name), originals[i]),
    );
    names.forEach((name, i) =>
      assert.deepEqual(
        fs.existsSync(path.join(actual, name))
          ? fs.readFileSync(path.join(actual, name))
          : null,
        originals[i],
      ),
    );
  }
}
fs.writeFileSync(
  path.join(dir, "result.json"),
  JSON.stringify(
    {
      passed: true,
      native: process.argv.includes("--native"),
      realMainAndService: true,
      sharedRestored: process.argv.includes("--native"),
    },
    null,
    2,
  ),
);
console.log("MMD app locale PASS", dir);
