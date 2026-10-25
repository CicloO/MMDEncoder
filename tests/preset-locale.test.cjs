require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../backend/core.cjs");
const { createService } = require("../backend/service.cjs");
const registry = require("../locales/registry.json");
const source = require("../locales/zh-CN.json");
const { createTranslator } = require("../locales/runtime.mjs");
const { presetDisplayName } = require("../locales/preset-names.mjs");
const baseline = require("./fixtures/i18n/preset-baseline.json");
const hash = (x) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const legacySettings = ({ maskFormat, ...settings }) => {
  assert.equal(maskFormat, "lossless");
  return settings;
};
const commands = (p) =>
  core.buildCommands(
    {
      path: "source.mkv",
      meta: {
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 1,
        hasAlpha: true,
        audio: { channels: 2 },
      },
    },
    p.settings,
    { ffmpeg: "ffmpeg", nvencc: "NVEncC" },
    {
      output: "out." + p.settings.container,
      maskOutput: "mask." + p.settings.container,
    },
  );
function fixture(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-locale-"));
  const file = path.join(dir, "settings.json");
  if (saved)
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, settings: core.DEFAULTS, ...saved }),
    );
  let svc;
  const open = () =>
    (svc = createService({
      dataDir: dir,
      mmdPluginDll: "",
      localeRegistry: {
        ...registry,
        locales: [...registry.locales, { id: "en-XA" }],
      },
    }));
  open();
  t.after(() => {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    get svc() {
      return svc;
    },
    saved: () => JSON.parse(fs.readFileSync(file)),
    restart() {
      svc.dispose();
      open();
    },
  };
}

test("all seven defaults keep pre-migration settings, commands and persisted fingerprints", async (t) => {
  const f = fixture(t);
  for (const golden of baseline.presets) {
    const p = f.svc.getState().presets.find((p) => p.id === golden.id);
    assert.equal(p.name, golden.name);
    assert.equal(source[p.nameKey], golden.name);
    assert.equal(p.nameSource, "builtin");
    assert.equal(
      hash(legacySettings(p.settings)),
      golden.settingsHash,
      p.id + " settings",
    );
    const pipeline = commands(p);
    assert.ok(
      pipeline.every(
        (c) =>
          typeof c.stage?.stage === "string" &&
          typeof c.stage.message === "string",
      ),
    );
    // Only the planned stage contract changed. Compare every other byte of
    // the command record, including all arguments, with the original fixture.
    const diagnostic = JSON.parse(
      JSON.stringify(pipeline, (key, value) =>
        key === "stage" && typeof value === "object" ? value.message : value,
      ),
    );
    assert.equal(hash(diagnostic), golden.commandsHash, p.id + " command");
    await f.svc.invoke("savePreset", {
      id: p.id,
      name: p.name,
      settings: p.settings,
    });
    const override = f.saved().builtins[p.id];
    assert.equal(override.base, golden.fingerprint, p.id + " base");
    assert.equal(override.nameSource, "builtin");
    assert.equal(hash(legacySettings(override.settings)), golden.settingsHash);
  }
});

test("settings edits preserve default-name origin; explicit renames, personal and legacy overrides preserve user names", async (t) => {
  const f = fixture(t);
  const get = (id) => f.svc.getState().presets.find((p) => p.id === id);
  let p = get("builtin-4k-sw");
  await f.svc.invoke("savePreset", {
    id: p.id,
    name: p.name,
    settings: { ...p.settings, quality: 20 },
  });
  p = get(p.id);
  assert.equal(p.nameSource, "builtin");
  assert.equal(p.settingsEdited, true);
  assert.equal(p.edited, true);
  f.restart();
  assert.equal(get(p.id).nameSource, "builtin");
  assert.equal(get(p.id).settingsEdited, true);
  // Explicit intent matters even when the text equals the current source name.
  await f.svc.invoke("renamePreset", { id: p.id, name: p.name });
  assert.equal(get(p.id).nameSource, "user");
  await f.svc.invoke("renamePreset", {
    id: "builtin-prores422",
    name: "My 素材",
  });
  assert.equal(get("builtin-prores422").settingsEdited, false);
  await f.svc.invoke("savePreset", {
    name: "Personal 用户",
    settings: p.settings,
  });
  f.restart();
  assert.equal(get(p.id).nameSource, "user");
  assert.equal(get("builtin-prores422").name, "My 素材");
  assert.ok(
    f.svc
      .getState()
      .presets.some((p) => !p.builtin && p.name === "Personal 用户"),
  );
  // An old settings-only override and a same-text rename were indistinguishable.
  const old = baseline.presets[0];
  const legacy = fixture(t, {
    builtins: {
      [old.id]: {
        name: old.name,
        settings: core.BUILTINS[0].settings,
        base: old.fingerprint,
      },
    },
  });
  assert.equal(legacy.svc.getState().presets[0].nameSource, "user");
  await legacy.svc.invoke("setLocale", { locale: "en-XA" });
  legacy.restart();
  assert.equal(legacy.svc.getState().presets[0].nameSource, "user");
});

test("locale never changes saved preset data, ordering, case-insensitive conflicts or unknown records", async (t) => {
  const unknown = {
    id: "personal-bad",
    name: "Future",
    settings: { encoder: "future-encoder" },
  };
  const f = fixture(t, { presets: [unknown] });
  const p = f.svc.getState().presets.find((p) => p.id === "builtin-prores422");
  await f.svc.invoke("renamePreset", { id: p.id, name: "My Material" });
  await f.svc.invoke("hidePreset", { id: p.id, hidden: true });
  await f.svc.invoke("reorderPresets", {
    ids: f.svc
      .getState()
      .presets.map((p) => p.id)
      .reverse(),
  });
  const saved = f.saved();
  for (const locale of ["en-XA", "zh-CN", "en-XA"]) {
    await f.svc.invoke("setLocale", { locale });
    const after = f.saved();
    for (const field of [
      "settings",
      "presets",
      "builtins",
      "deletedBuiltins",
      "presetOrder",
    ])
      assert.deepEqual(after[field], saved[field], field);
    await assert.rejects(
      f.svc.invoke("renamePreset", {
        id: "builtin-alpha",
        name: "my material",
      }),
      (e) => e.code === "PRESET_DUPLICATE",
    );
  }
  assert.deepEqual(f.saved().presets, [unknown]);
});

test("mask choices survive personal preset persistence, import and MMD configuration while absent legacy fields default to lossless", async (t) => {
  const { maskFormat, ...oldSettings } = core.DEFAULTS;
  const f = fixture(t, {
    presets: [{ id: "old", name: "Old mask preset", settings: oldSettings }],
  });
  assert.equal(
    f.svc.getState().presets.find((p) => p.id === "old").settings.maskFormat,
    "lossless",
  );
  for (const format of ["lossless", "gpu-lossy", "x264-lossy"]) {
    await f.svc.invoke("savePreset", {
      name: "Mask " + format,
      settings: { ...core.DEFAULTS, alphaMask: true, maskFormat: format },
    });
  }
  f.restart();
  const mine = f.svc
    .getState()
    .presets.filter((p) => p.name.startsWith("Mask "));
  assert.deepEqual(
    mine.map((p) => p.settings.maskFormat),
    ["lossless", "gpu-lossy", "x264-lossy"],
  );
  const copies = JSON.parse(JSON.stringify(mine)).map((p) => ({
    ...p,
    name: p.name + " imported",
  }));
  await f.svc.invoke("importPresets", { presets: copies });
  for (const p of mine)
    assert.equal(
      f.svc.getState().presets.find((q) => q.name === p.name + " imported")
        .settings.maskFormat,
      p.settings.maskFormat,
    );
  const mx = require("../backend/mmd-export.cjs");
  mx.writeConfig({
    presets: mine,
    engines: { ffmpeg: "ff", ffprobe: "fp" },
    appExe: process.execPath,
    helper: path.resolve("backend/mmd-export.cjs"),
  });
  for (const p of mine)
    assert.equal(
      mx.readConfig({ presetId: p.id, maskMode: "with", followMmd: true })
        .settings.maskFormat,
      p.settings.maskFormat,
    );
});

test("display-name collisions identify only translated defaults; user names and technical values stay exact", () => {
  const pseudo = {
    [core.BUILTINS[0].nameKey]: "Same",
    [core.BUILTINS[1].nameKey]: "Same",
  };
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: { "zh-CN": source, "en-XA": pseudo },
    initialLocale: "en-XA",
  });
  const mine = {
    ...core.BUILTINS[0],
    id: "mine",
    builtin: false,
    name: "Same",
  };
  const peers = [core.BUILTINS[0], core.BUILTINS[1], mine];
  assert.equal(presetDisplayName(runtime, mine, peers), "Same");
  assert.match(presetDisplayName(runtime, peers[0], peers), /builtin-4k/);
  assert.match(presetDisplayName(runtime, peers[1], peers), /builtin-4k-sw/);
  assert.equal(
    presetDisplayName(runtime, { ...peers[0], nameSource: "user" }, peers),
    peers[0].name,
  );
  assert.equal(
    presetDisplayName(runtime, { ...peers[0], nameKey: "future-key" }),
    peers[0].name,
  );
  runtime.setLocale("zh-CN");
  assert.equal(presetDisplayName(runtime, peers[0]), baseline.presets[0].name);
});
