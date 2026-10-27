require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pluginMessages } = require("../backend/plugin-messages.cjs");
const { createService } = require("../backend/service.cjs");
const mx = require("../backend/mmd-export.cjs");
const source = require("../locales/zh-CN.json");
const keys = require("../locales/plugin-keys.json");
const core = require("../backend/core.cjs");

test("plugin preset display snapshots localize defaults while helper names and settings stay unchanged", () => {
  const p = core.BUILTINS[0];
  const mine = { ...p, id: "user", builtin: false, name: "My 用户预设" };
  const config = mx.writeConfig({
    presets: [p, mine],
    engines: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    locale: "en-XA",
    catalogs: {
      "zh-CN": source,
      "en-XA": { [p.nameKey]: "⟦ Expanded preset ··· ⟧" },
    },
  });
  assert.equal(config.presets[0].displayName, "⟦ Expanded preset ··· ⟧");
  assert.equal(config.presets[0].name, p.name);
  assert.deepEqual(config.presets[0].settings, p.settings);
  assert.equal(config.presets[1].displayName, mine.name);
  assert.equal(config.presets[1].settings.presetName, mine.name);
});

test("plugin config contains only its finite translated subset, with Chinese fallback and unchanged preset data", () => {
  const pseudo = { "plugin.title": "⟦ Native title ··· ⟧" };
  const localized = pluginMessages("en-XA", {
    "zh-CN": source,
    "en-XA": pseudo,
  });
  assert.equal(localized.locale, "en-XA");
  assert.equal(localized.messages["plugin.title"], pseudo["plugin.title"]);
  assert.equal(localized.messages["plugin.cancel"], source["plugin.cancel"]);
  assert.deepEqual(Object.keys(localized.messages), keys);
  assert.equal(localized.messages["background.label"], undefined);
  assert.equal(pluginMessages("unknown").locale, "zh-CN");
  execFileSync(process.execPath, ["scripts/plugin-messages.mjs", "--check"]);
});

test("the service persists locale before writing its standalone plugin snapshot, without renaming presets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-plugin-locale-"));
  const svc = createService({ dataDir: dir });
  try {
    const original = svc.getState().presets;
    await svc.invoke("setLocale", { locale: "unknown" });
    const stored = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.json"), "utf8"),
    );
    const config = JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
    assert.equal(stored.preferences.locale, "zh-CN");
    assert.equal(config.locale, "zh-CN");
    assert.equal(config.messages["plugin.title"], source["plugin.title"]);
    assert.deepEqual(
      config.presets.map(({ id, name, settings }) => ({ id, name, settings })),
      original.map(({ id, name, settings }) => ({ id, name, settings })),
    );
    assert.deepEqual(svc.getState().presets, original);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("service plugin snapshots use registered catalogs and preserve builtin display metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-plugin-catalog-"));
  const preset = core.BUILTINS[0];
  const pseudo = {
    "plugin.title": "⟦ Native title ··· ⟧",
    [preset.nameKey]: "⟦ Expanded default ··· ⟧",
  };
  const svc = createService({
    dataDir: dir,
    localeRegistry: {
      ...require("../locales/registry.json"),
      locales: [{ id: "zh-CN" }, { id: "en-XA" }],
    },
    localeCatalogs: { "zh-CN": source, "en-XA": pseudo },
  });
  try {
    const original = svc.getState().presets;
    await svc.invoke("setLocale", { locale: "en-XA" });
    const config = JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
    assert.equal(config.locale, "en-XA");
    assert.equal(config.messages["plugin.title"], pseudo["plugin.title"]);
    assert.equal(config.messages["plugin.cancel"], source["plugin.cancel"]);
    assert.equal(
      config.presets.find((p) => p.id === preset.id).displayName,
      pseudo[preset.nameKey],
    );
    assert.deepEqual(svc.getState().presets, original);
    await svc.invoke("renamePreset", { id: preset.id, name: "User 用户改名" });
    const renamed = JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
    assert.equal(
      renamed.presets.find((p) => p.id === preset.id).displayName,
      "User 用户改名",
    );
    await svc.invoke("setLocale", { locale: "zh-CN" });
    const restored = JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
    assert.equal(restored.locale, "zh-CN");
    assert.equal(
      restored.presets.find((p) => p.id === preset.id).displayName,
      "User 用户改名",
    );
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MMD plan/test helpers keep coded failures and params in their JSON result", () => {
  for (const mode of ["plan", "test"]) {
    const result = JSON.parse(
      execFileSync(process.execPath, ["backend/mmd-export.cjs"], {
        env: {
          ...process.env,
          MMD_EXPORT_MODE: mode,
          MMD_EXPORT_JOB: "{invalid",
        },
        encoding: "utf8",
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorData.code, "MMD_REQUEST_INVALID");
    assert.ok(result.errorData.params.detail);
    assert.equal(result.error, result.errorData.message);
  }
});

test("native snapshots include every error code reachable from MMD command validation", () => {
  const ts = require("typescript");
  const needed = new Set([
    "error.VALIDATION_FAILED",
    "error.MMD_ALPHA_REQUIRED",
    "message.MMD_MASK_SKIPPED",
  ]);
  for (const file of [
    "backend/settings-validation.cjs",
    "backend/filter.cjs",
    "backend/commands.cjs",
    "backend/mask-settings.cjs",
  ]) {
    const tree = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(tree),
          arg = node.arguments[name === "check" ? 1 : 0];
        if (
          ["appError", "validationIssue", "check"].includes(name) &&
          arg &&
          ts.isStringLiteral(arg) &&
          /^[A-Z][A-Z0-9_]+$/.test(arg.text)
        )
          needed.add("error." + arg.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const key of needed) assert.ok(keys.includes(key), key);
});
