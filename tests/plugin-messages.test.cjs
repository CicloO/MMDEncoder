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
