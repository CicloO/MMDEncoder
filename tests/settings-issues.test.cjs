const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../backend/core.cjs");
const { schema } = require("../backend/settings-schema.cjs");
const { serializeError, validationError } = require("../backend/errors.cjs");
const { createTranslator } = require("../locales/runtime.mjs");
const { formatDescriptor } = require("../locales/messages.mjs");
const zh = require("../locales/zh-CN.json");

test("settings retain separate issue codes and parameters across serialization and locale changes", () => {
  const settings = {
    ...core.DEFAULTS,
    width: 1,
    height: 1,
    resizeMode: "custom",
    quality: -1,
    fps: "1/0",
  };
  const issues = core.validateIssues(settings, { width: 1920, height: 1080 });
  assert.deepEqual(
    issues
      .filter((i) => i.code === "SETTING_NUMBER_INVALID")
      .map((i) => i.params),
    [{ field: "quality" }],
  );
  assert.equal(
    issues.filter((i) => i.code === "RESOLUTION_INTEGER_INVALID").length,
    1,
  );
  assert.ok(issues.some((i) => i.code === "FPS_RANGE_INVALID"));
  const wire = JSON.parse(
    JSON.stringify(serializeError(validationError(issues))),
  );
  assert.deepEqual(wire.issues, issues);
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: {
      "zh-CN": zh,
      "en-XA": { "error.SETTING_NUMBER_INVALID": "Invalid number: {field}" },
    },
  });
  runtime.setLocale("en-XA");
  assert.equal(
    formatDescriptor(
      runtime,
      "error",
      wire.issues.find((i) => i.code === "SETTING_NUMBER_INVALID"),
    ),
    "Invalid number: quality",
  );
  assert.equal(
    formatDescriptor(
      runtime,
      "error",
      wire.issues.find((i) => i.code === "FPS_RANGE_INVALID"),
    ),
    zh["error.FPS_RANGE_INVALID"],
  );
  assert.deepEqual(core.validate(settings, { width: 1920, height: 1080 }), [
    ...new Set(issues.map((i) => i.message)),
  ]);
});

test("FPS and schema failures expose stable codes rather than incidental JavaScript errors", () => {
  for (const [fps, code] of [
    ["fast", "FPS_SYNTAX_INVALID"],
    ["1/0", "FPS_RANGE_INVALID"],
    ["241", "FPS_RANGE_INVALID"],
  ])
    assert.throws(
      () => core.parseFps(fps),
      (e) => e.code === code && e.message === zh[`error.${code}`],
    );
  assert.throws(
    () => schema({ width: "1920" }),
    (e) => e.code === "SETTINGS_FIELD_INVALID" && e.params.field === "width",
  );
  assert.throws(
    () => schema({ nameTemplate: "a".repeat(4097) }),
    (e) =>
      e.code === "SETTINGS_TEXT_TOO_LONG" && e.params.field === "nameTemplate",
  );
});

test("compatibility uses issue identity and preserves the actionable patch", () => {
  const settings = {
    ...core.DEFAULTS,
    encoder: "h264_nvenc",
    preset: "invalid-speed",
  };
  const before = structuredClone(settings);
  const result = core.compatibility(settings);
  assert.deepEqual(settings, before);
  assert.ok(result.issues.some((i) => i.code === "ENCODER_SPEED_INVALID"));
  assert.deepEqual(
    result.errors,
    result.issues.map((i) => i.message),
  );
  assert.equal(result.suggestions[0].code, "COMPAT_ENCODER_FIX");
  assert.deepEqual(result.suggestions[0].patch, { preset: "p4" });
  assert.deepEqual(
    core.validateIssues({ ...settings, ...result.suggestions[0].patch }),
    [],
  );
});
