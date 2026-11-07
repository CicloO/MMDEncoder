const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A built-in the user edited, then an update shipped a different definition of
// it: the app asks whether to drop the edit or keep it as a personal preset.
test("an update that changes an edited built-in asks before dropping the edit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preset-update-"));
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local");
  delete require.cache[require.resolve("../backend/service.cjs")];
  const { createService } = require("../backend/service.cjs");
  const core = require("../backend/core.cjs");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const shipped = core.BUILTINS.find((p) => p.id === "builtin-alpha");
  const mine = (name, quality) => ({
    name,
    settings: { ...shipped.settings, quality, presetName: name },
    base: "fingerprint-of-an-older-version",
  });
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: core.DEFAULTS,
      presets: [],
      builtins: {
        "builtin-alpha": mine("我的 ProRes", 4),
        "builtin-alpha-mask": mine("我的分离", 25),
      },
    }),
  );
  const open = () => createService({ dataDir, mmdPluginDll: "" });
  let svc = open();
  const state = () => svc.getState();
  const find = (name) => state().presets.find((p) => p.name === name);
  try {
    // Both edits wait for an answer; the built-ins already use the new definition.
    assert.deepEqual(
      state().presetConflicts.map((c) => [c.id, c.name]),
      [
        ["builtin-alpha-mask", "我的分离"],
        ["builtin-alpha", "我的 ProRes"],
      ],
    );
    const alpha = state().presets.find((p) => p.id === "builtin-alpha");
    assert.equal(alpha.name, shipped.name);
    assert.equal(alpha.settings.quality, shipped.settings.quality);

    // Unanswered conflicts survive a restart.
    svc.dispose();
    svc = open();
    assert.equal(state().presetConflicts.length, 2);

    // Keep: a personal copy right after the built-in, with the old settings.
    await svc.invoke("resolvePresetConflict", {
      id: "builtin-alpha",
      keep: true,
    });
    const copy = find("我的 ProRes (Modified)");
    assert.ok(copy && !copy.builtin);
    assert.equal(copy.settings.quality, 4);
    const ids = state().presets.map((p) => p.id);
    assert.equal(ids.indexOf(copy.id), ids.indexOf("builtin-alpha") + 1);

    // Overwrite: the edit is dropped, no copy.
    await svc.invoke("resolvePresetConflict", {
      id: "builtin-alpha-mask",
      keep: false,
    });
    assert.equal(find("我的分离 (Modified)"), undefined);
    assert.equal(state().presetConflicts.length, 0);
    await assert.rejects(
      svc.invoke("resolvePresetConflict", { id: "builtin-alpha", keep: true }),
      /未找到/,
    );

    // Answered: not asked again, and the copy stays a personal preset.
    svc.dispose();
    svc = open();
    assert.equal(state().presetConflicts.length, 0);
    assert.ok(find("我的 ProRes (Modified)"));
  } finally {
    svc.dispose();
    process.env.LOCALAPPDATA = savedLocal;
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("don't overwrite keeps the edited built-in in place, across restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preset-existing-"));
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local");
  delete require.cache[require.resolve("../backend/service.cjs")];
  const { createService } = require("../backend/service.cjs");
  const core = require("../backend/core.cjs");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const shipped = core.BUILTINS.find((p) => p.id === "builtin-alpha");
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: core.DEFAULTS,
      presets: [],
      builtins: {
        "builtin-alpha": {
          name: "我的 ProRes",
          settings: {
            ...shipped.settings,
            quality: 4,
            presetName: "我的 ProRes",
          },
          base: "fingerprint-of-an-older-version",
        },
      },
    }),
  );
  const open = () => createService({ dataDir, mmdPluginDll: "" });
  let svc = open();
  const alpha = () =>
    svc.getState().presets.find((p) => p.id === "builtin-alpha");
  try {
    assert.equal(svc.getState().presetConflicts.length, 1);
    const count = svc.getState().presets.length;
    await svc.invoke("resolvePresetConflict", {
      id: "builtin-alpha",
      existing: true,
    });
    assert.equal(svc.getState().presetConflicts.length, 0);
    // No personal copy; the built-in itself keeps the user's version.
    assert.equal(svc.getState().presets.length, count);
    assert.equal(alpha().name, "我的 ProRes");
    assert.equal(alpha().settings.quality, 4);
    assert.equal(alpha().builtin, true);
    svc.dispose();
    svc = open();
    assert.equal(svc.getState().presetConflicts.length, 0);
    assert.equal(alpha().name, "我的 ProRes");
    assert.equal(alpha().settings.quality, 4);
  } finally {
    svc.dispose();
    process.env.LOCALAPPDATA = savedLocal;
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A stale fingerprint alone is no reason to ask: an edit that is the same as
// the current definition has nothing to overwrite.
test("an edited built-in equal to the current definition raises no conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preset-update-same-"));
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local");
  delete require.cache[require.resolve("../backend/service.cjs")];
  const { createService } = require("../backend/service.cjs");
  const core = require("../backend/core.cjs");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const shipped = core.BUILTINS.find((p) => p.id === "builtin-alpha");
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: core.DEFAULTS,
      presets: [],
      builtins: {
        "builtin-alpha": {
          name: shipped.name,
          settings: { ...shipped.settings },
          base: "fingerprint-of-an-older-version",
          nameSource: "builtin",
        },
      },
    }),
  );
  const svc = createService({ dataDir, mmdPluginDll: "" });
  try {
    assert.equal(svc.getState().presetConflicts.length, 0);
    assert.equal(svc.getState().notice || "", "");
  } finally {
    svc.dispose();
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocal;
  }
});
