require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createService } = require("../backend/service.cjs"),
  core = require("../backend/core.cjs");
const { serializeError } = require("../backend/errors.cjs");
const source = require("../locales/zh-CN.json");
const { load } = require("./load-typescript.cjs");
function fixture(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-message-"));
  if (saved)
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(saved));
  const service = createService({ dataDir: dir, mmdPluginDll: "" });
  t.after(() => {
    service.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return service;
}
const translated = () => {
  const i = load("src/i18n.ts");
  const catalog = Object.fromEntries(
    Object.entries(source)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => [k, `Test ${k}: ${v}`]),
  );
  i.localeRuntime.registerCatalog("en-XA", catalog);
  return { i, catalog };
};
test("preset schema and multi-issue failures preserve source fallback and refresh every cause after JSON", async (t) => {
  const service = fixture(t),
    { i } = translated();
  for (const settings of [
    { quality: "bad" },
    { encoder: "unknown-test-encoder", quality: -1, audioBitrate: 1 },
  ]) {
    let caught;
    try {
      await service.invoke("importPresets", {
        presets: [{ name: "User {name}", settings }],
      });
    } catch (e) {
      caught = e;
    }
    assert.equal(caught.code, "PRESET_SETTINGS_INVALID");
    const data = JSON.parse(JSON.stringify(serializeError(caught)));
    assert.equal(
      i.errorMessage(data),
      data.message,
      "unchanged source sentence",
    );
    const causes = data.params.error ? [data.params.error] : data.params.errors;
    assert.ok(causes.length);
    i.setLocale("en-XA");
    const display = i.errorMessage(data);
    for (const cause of causes)
      assert.ok(display.includes("Test error." + cause.code));
    i.setLocale("zh-CN");
    assert.equal(
      service.getState().presets.some((p) => p.name === "User {name}"),
      false,
      "invalid import is atomic",
    );
  }
  const foreign = "Error invoking remote method 'external': Error: 未知 {raw}";
  assert.ok(
    i
      .errorMessage({
        code: "PRESET_SETTINGS_INVALID",
        message: "fallback",
        params: { error: { message: foreign, params: {} } },
      })
      .endsWith(foreign),
  );
});
test("unreadable personal preset notice refreshes nested causes without altering saved user content", (t) => {
  const saved = {
    version: 1,
    settings: core.DEFAULTS,
    presets: [
      { id: "user-bad", name: "User 原名 {x}", settings: { quality: "bad" } },
    ],
  };
  const service = fixture(t, saved),
    notice = JSON.parse(JSON.stringify(service.getState().noticeData)),
    { i } = translated();
  assert.equal(notice.code, "PRESET_UNREADABLE");
  assert.equal(i.summaryMessage(notice), notice.message);
  i.setLocale("en-XA");
  const text = i.summaryMessage(notice);
  assert.ok(text.includes("User 原名 {x}"));
  assert.ok(text.includes("Test error.PRESET_SETTINGS_INVALID"));
  assert.ok(text.includes("Test error.SETTINGS_FIELD_INVALID"));
});
test("preset notices reproject default names and collisions while keeping personal and renamed names exact", () => {
  const { i } = translated(),
    builtin = {
      id: "builtin-4k",
      name: "Source default",
      builtin: true,
      nameKey: "preset.default4kHardware",
      nameSource: "builtin",
    },
    personal = { id: "user", name: "User {raw}", builtin: false };
  for (const code of ["PRESET_APPLIED", "PRESET_OVERWRITTEN"]) {
    const value = {
      code,
      message: "fallback",
      params: {
        name: builtin.name,
        preset: builtin,
        peers: [builtin, personal],
      },
    };
    assert.ok(i.summaryMessage(value).includes(source[builtin.nameKey]));
    i.setLocale("en-XA");
    assert.ok(i.summaryMessage(value).includes("Test " + builtin.nameKey));
    value.params.preset = {
      ...builtin,
      name: "Renamed 中文 {p}",
      nameSource: "user",
    };
    assert.ok(i.summaryMessage(value).includes("Renamed 中文 {p}"));
    value.params.preset = personal;
    assert.ok(i.summaryMessage(value).includes("User {raw}"));
    i.setLocale("zh-CN");
    value.params.preset = builtin;
    value.params.peers = [
      builtin,
      { ...personal, name: source[builtin.nameKey] },
    ];
    assert.ok(i.summaryMessage(value).includes("builtin-4k"));
  }
});
