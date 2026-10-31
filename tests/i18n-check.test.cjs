const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
test("catalog validation rejects missing keys, renamed parameters and invalid plural messages", async () => {
  const { validateCatalog } = await import("../scripts/i18n-check.mjs");
  const source = {
    "video.label": "Open {name}",
    "queue.count": { one: "{count} item", other: "{count} items" },
  };
  const errors = validateCatalog(
    "broken",
    {
      "video.label": "Open {wrong}",
      "queue.count": { one: "" },
      extra: "extra",
    },
    source,
  );
  for (const rule of [
    "parameter-names",
    "plural-other",
    "plural-form",
    "unexpected-key",
  ])
    assert.ok(
      errors.some((e) => e.rule === rule),
      rule,
    );
  assert.ok(
    validateCatalog("missing", {}, source).every(
      (e) => e.rule === "missing-key",
    ),
  );
  assert.deepEqual(validateCatalog("valid", source, source), []);
});
test("duplicate JSON keys are reported before JSON.parse can silently overwrite them", async () => {
  const { readJson } = await import("../scripts/i18n-check.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-catalog-check-"));
  try {
    const file = path.join(dir, "duplicate.json");
    fs.writeFileSync(file, '{"video.label":"A","video.label":"B"}');
    assert.equal(readJson(file).errors[0].rule, "duplicate-key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("source references detect unknown keys and missing params while keeping dynamic paths explicit", async () => {
  const { checkSource } = await import("../scripts/i18n-check.mjs");
  const catalog = {
    "video.label": "Open {name}",
    "video.other": "Other",
    "error.FAIL": "Cause {detail}",
  };
  const source =
    't("video.missing"); t("video.label", {wrong: "x"}); t(flag ? "video.other" : "video.label", {name}); appError("FAIL", {error}); t(key, params); response.text();';
  const report = checkSource("src/Test.ts", source, catalog);
  assert.deepEqual(
    report.errors.map((e) => e.rule),
    ["missing-reference", "missing-parameter"],
  );
  assert.equal(report.dynamic.length, 1);
  assert.equal(report.dynamic[0].expression, "t(key, params)");
  assert.ok(
    report.references.some(
      (e) => e.kind === "descriptor" && e.key === "error.FAIL",
    ),
  );
});
test("spread and forwarded params are reviewed instead of being falsely proved complete", async () => {
  const { checkSource } = await import("../scripts/i18n-check.mjs");
  const report = checkSource(
    "src/Test.ts",
    't("video.label", {...params}); t("video.label", forwarded);',
    { "video.label": "{name}" },
  );
  assert.equal(report.errors.length, 0);
  assert.equal(report.deferredParameters.length, 2);
});
test("the shipped catalogs and complete pseudo catalog agree without shipping a test locale", async () => {
  const { checkProject } = await import("../scripts/i18n-check.mjs");
  const report = await checkProject(path.resolve(__dirname, ".."));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.registeredLocales, ["zh-CN", "ja", "en"]);
  assert.ok(report.references.length > 1000);
  assert.ok(
    report.reviewRequired > 0,
    "Dynamic paths still require source review",
  );
});

test("module-local adapters and notifications cannot hide missing source messages", async () => {
  const { checkSource } = await import("../scripts/i18n-check.mjs");
  const native = checkSource(
    "backend/mmd-export.cjs",
    'note(log, "MISSING_NOTE");',
    {},
  );
  assert.equal(native.errors[0].key, "message.MISSING_NOTE");
  const renderer = checkSource(
    "src/Test.ts",
    'notification("MISSING_NOTICE");',
    {},
  );
  assert.equal(renderer.errors[0].key, "message.MISSING_NOTICE");
  const unrelated = checkSource(
    "src/Test.ts",
    'note(log, "NOT_TRANSLATION");',
    {},
  );
  assert.deepEqual(unrelated.errors, []);
  assert.deepEqual(unrelated.references, []);
});

test("keys stored in finite tables are checked before a dynamic lookup can hide them", async () => {
  const { checkSource } = await import("../scripts/i18n-check.mjs");
  const report = checkSource(
    "src/Test.ts",
    'const busy = { loading: "video.missing" }; t(busy[state]);',
    { "video.label": "Label" },
  );
  assert.equal(report.errors[0].key, "video.missing");
  assert.equal(report.errors[0].kind, "key-value");
  assert.equal(report.dynamic.length, 1);
});

test("path-building filenames are distinguished from similarly named resource namespaces", async () => {
  const { checkSource } = await import("../scripts/i18n-check.mjs");
  const report = checkSource(
    "backend/Test.cjs",
    'path.join(root, "output.mkv"); t("output.missing");',
    { "output.label": "Output" },
  );
  assert.deepEqual(
    report.errors.map((e) => e.key),
    ["output.missing"],
  );
});
