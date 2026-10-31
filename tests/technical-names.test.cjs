const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../backend/core.cjs");
const { createPresetOperations } = require("../backend/presets.cjs");
const { schema } = require("../backend/settings-schema.cjs");
const { presetDisplayName } = require("../locales/preset-names.mjs");
const { load } = require("./load-typescript.cjs");

test("generated output fallback and metadata sentinels use English while user text stays exact", () => {
  const input = "H:/source/用户输入.mp4";
  const settings = {
    ...core.DEFAULTS,
    outputMode: "source",
    nameTemplate: "{name}_{preset}",
    presetName: "",
  };
  assert.match(
    core.outputPaths(input, settings).output,
    /用户输入_Custom\.mp4$/,
  );
  assert.match(
    core.outputPaths(input, { ...settings, presetName: "用户预设" }).output,
    /用户输入_用户预设\.mp4$/,
  );
  const meta = core.metadata({
    streams: [{ codec_type: "video" }],
    format: {},
  });
  assert.equal(meta.codec, "unknown");
  assert.equal(meta.pixFmt, "unknown");
  assert.equal(
    core.validateIssues({
      ...core.DEFAULTS,
      nameTemplate: "{name}_{preset}_{date}_{index}",
    }).length,
    0,
  );
  assert.ok(
    core
      .validateIssues({ ...core.DEFAULTS, nameTemplate: "{unsupported}" })
      .some((issue) => issue.code === "NAME_TEMPLATE_TOKEN_INVALID"),
  );
});

test("new generated preset suffixes use English, saved user names and translated display names remain separate", () => {
  const ops = createPresetOperations({ schema, reorder: (items) => items });
  const builtin = structuredClone(core.BUILTINS[0]);
  const userName = builtin.name;
  const model = {
    settings: core.DEFAULTS,
    presets: [builtin],
    presetConflicts: [],
  };
  const deletedBuiltins = new Set();
  ops.restore(
    {
      presets: [{ id: "personal", name: userName, settings: builtin.settings }],
    },
    model,
    { deletedBuiltins, unreadable: { builtins: {}, presets: [] } },
  );
  assert.equal(model.presets.find((p) => p.id === "personal").name, userName);
  assert.equal(builtin.name, userName + " (Built-in)");
  const i18n = load("src/i18n.ts");
  assert.equal(
    presetDisplayName(i18n.localeRuntime, builtin, model.presets),
    userName + "（内置）",
  );
  const originalName = "用户修改的预设";
  model.presetConflicts = [
    { id: builtin.id, name: originalName, settings: builtin.settings },
  ];
  model.presets.push({
    id: "existing-copy",
    name: originalName + " (Modified)",
    settings: builtin.settings,
  });
  ops.execute("resolvePresetConflict", { id: builtin.id, keep: true }, model, {
    deletedBuiltins,
  });
  assert.ok(
    model.presets.some((p) => p.name === originalName + " (Modified 2)"),
  );
  assert.ok(
    model.presets.some(
      (p) =>
        p.id === "existing-copy" && p.name === originalName + " (Modified)",
    ),
  );
});

test("reviewed technical exceptions contain no Chinese literals", () => {
  const exceptions = require("../scripts/i18n-exceptions.json");
  for (const entry of exceptions.filter(
    (item) => item.category === "technical",
  ))
    assert.equal(
      /\p{Script=Han}/u.test(entry.text),
      false,
      entry.file + ": " + entry.text,
    );
});
