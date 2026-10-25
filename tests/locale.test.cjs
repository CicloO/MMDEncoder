require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createService } = require("../backend/service.cjs");
const { createPreferences } = require("../backend/preferences.cjs");
const registry = require("../locales/registry.json");
const testRegistry = {
  ...registry,
  locales: [
    ...registry.locales,
    { id: "en-XA", name: "Pseudo", file: "test-only" },
  ],
};

test("locale runtime refreshes subscriptions, supports plural forms and falls back to source copy", async () => {
  const { createTranslator } = await import("../locales/runtime.mjs");
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: {
      "zh-CN": {
        count: "{count} 项",
        sourceOnly: "源文案",
        empty: "源文案",
        text: "路径：{path}",
      },
      "en-XA": {
        count: { one: "⟦ {count} item ··· ⟧", other: "⟦ {count} items ··· ⟧" },
        empty: "",
      },
    },
  });
  const received = [];
  const off = runtime.subscribe(() => received.push(runtime.getLocale()));
  assert.equal(runtime.setLocale("en-XA"), "en-XA");
  assert.equal(runtime.t("count", { count: 1 }), "⟦ 1 item ··· ⟧");
  assert.equal(runtime.t("count", { count: 120 }), "⟦ 120 items ··· ⟧");
  assert.equal(runtime.t("sourceOnly"), "源文案");
  assert.equal(runtime.t("empty"), "源文案");
  assert.equal(runtime.t("text", { path: "$&/{other}" }), "路径：$&/{other}");
  assert.equal(runtime.t("text"), "路径：{path}");
  assert.equal(runtime.t("future.key"), "future.key");
  runtime.setLocale("en-XA");
  assert.deepEqual(received, ["en-XA"]);
  assert.equal(runtime.setLocale("unknown"), "zh-CN");
  off();
  runtime.setLocale("en-XA");
  assert.deepEqual(received, ["en-XA", "zh-CN"]);
  assert.equal(
    runtime.number(12345.5),
    new Intl.NumberFormat("en-XA").format(12345.5),
  );
  assert.equal(
    runtime.unit(2, "second"),
    new Intl.NumberFormat("en-XA", { style: "unit", unit: "second" }).format(2),
  );
  assert.equal(
    runtime.bytes(1536),
    new Intl.NumberFormat("en-XA", {
      style: "unit",
      unit: "kilobyte",
      maximumFractionDigits: 2,
    }).format(1.5),
  );
  assert.equal(
    runtime.dateTime(0, { timeZone: "UTC", year: "numeric" }),
    new Intl.DateTimeFormat("en-XA", {
      timeZone: "UTC",
      year: "numeric",
    }).format(new Date(0)),
  );
});

test("preparation defaults to Chinese, reserves system mode and ignores unsupported locale values", () => {
  const preferences = createPreferences();
  assert.equal(preferences.normalize(undefined), null);
  assert.equal(preferences.normalize(null), null);
  for (const value of ["ja", "en", "unknown", 42, {}, false]) {
    assert.equal(preferences.normalize(value), "zh-CN");
    assert.equal(preferences.resolve(value), "zh-CN");
  }
  assert.equal(preferences.resolve(null), "zh-CN");
  assert.deepEqual(
    registry.locales.map((l) => l.id),
    ["zh-CN"],
  );
});

test("locale is persisted before broadcast, survives restart and leaves presets, jobs, settings and RTX evidence unchanged", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-locale-"));
  const events = [];
  const options = {
    dataDir,
    localeRegistry: testRegistry,
    onUpdate(state) {
      const saved = JSON.parse(
        fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
      );
      assert.equal(saved.preferences.locale, state.preferences.locale);
      events.push(state.locale);
    },
  };
  let svc = createService(options);
  try {
    const before = svc.getState();
    assert.equal(before.preferences.locale, null);
    assert.equal(before.locale, "zh-CN");
    const state = await svc.invoke("setLocale", { locale: "en-XA" });
    assert.equal(state.locale, "en-XA");
    for (const key of [
      "settings",
      "jobs",
      "presets",
      "presetConflicts",
      "enhancements",
      "engineInfo",
      "detecting",
      "running",
    ])
      assert.deepEqual(state[key], before[key], key);
    assert.deepEqual(events, ["en-XA"]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
    );
    assert.equal(saved.settings.locale, undefined);
    assert.ok(saved.presets.every((p) => !Object.hasOwn(p.settings, "locale")));
    svc.dispose();
    svc = createService({ ...options, onUpdate: undefined });
    assert.equal(svc.getState().locale, "en-XA");
    assert.equal(svc.getState().preferences.locale, "en-XA");
    // The released registry does not contain the test language.
    svc.dispose();
    svc = createService({ dataDir });
    assert.equal(svc.getState().locale, "zh-CN");
    assert.equal(svc.getState().preferences.locale, "zh-CN");
    await svc.invoke("setLocale", { locale: null });
    assert.equal(svc.getState().preferences.locale, null);
    assert.equal(svc.getState().locale, "zh-CN");
  } finally {
    svc.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed preference persistence rolls back memory and does not broadcast an unsaved locale", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-locale-fail-"));
  const events = [];
  const svc = createService({
    dataDir,
    localeRegistry: testRegistry,
    onUpdate: (s) => events.push(s.locale),
  });
  try {
    fs.mkdirSync(path.join(dataDir, "settings.json"));
    await assert.rejects(svc.invoke("setLocale", { locale: "en-XA" }));
    assert.equal(svc.getState().locale, "zh-CN");
    assert.equal(svc.getState().preferences.locale, null);
    assert.deepEqual(events, []);
  } finally {
    svc.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
