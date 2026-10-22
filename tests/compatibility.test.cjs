const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../backend/core.cjs");
const engines = c.ENGINES.map((e) => ({ ...e, alpha: e.id === "nvencc:hevc" }));
test("Alpha repairs offer ProRes first, never HEVC alpha, and preserve unrelated settings", () => {
  const original = {
    ...c.DEFAULTS,
    alphaMode: "preserve",
    encoder: "libx264",
    bitDepth: 10,
    chroma: "444",
    fps: "30000/1001",
    resizeMode: "custom",
    width: 1280,
    outputMode: "custom",
    outputDir: "D:/out",
  };
  const result = c.compatibility(original, engines);
  assert.ok(result.errors.length);
  assert.equal(result.suggestions[0].id, "prores_ks");
  assert.ok(!result.suggestions.some((s) => s.id === "nvencc:hevc"));
  // Split alpha changes the alpha mode by design; the format fixes keep it.
  for (const suggestion of result.suggestions.filter(
    (x) => x.id !== "split-alpha",
  )) {
    const fixed = { ...original, ...suggestion.patch };
    assert.deepEqual(c.validate(fixed), []);
    for (const field of [
      "alphaMode",
      "fps",
      "resizeMode",
      "width",
      "outputMode",
      "outputDir",
    ])
      assert.equal(fixed[field], original[field]);
  }
  const unavailable = c.compatibility(
    original,
    engines.map((e) => ({ ...e, alpha: false })),
  );
  assert.ok(!unavailable.suggestions.some((s) => s.id === "nvencc:hevc"));
  assert.ok(unavailable.suggestions.some((s) => s.id === "prores_ks"));
});
test("format depth chroma and audio repair yields a compatible atomic patch", () => {
  for (const patch of [
    { encoder: "libx264", container: "webm" },
    { encoder: "prores_ks", container: "mp4", bitDepth: 8, chroma: "420" },
    { encoder: "h264_qsv", chroma: "444" },
    { encoder: "libsvtav1", rateControl: "qp", preset: "6", chroma: "444" },
    { encoder: "libx264", container: "mp4", audio: "flac" },
  ]) {
    const original = { ...c.DEFAULTS, preset: "medium", ...patch };
    const result = c.compatibility(original, engines);
    assert.ok(result.errors.length);
    assert.ok(result.suggestions.length, JSON.stringify(patch));
    assert.deepEqual(
      c.validate({ ...original, ...result.suggestions[0].patch }),
      [],
    );
  }
});

test("preserve alpha in an unsupported format offers split alpha keeping the format", () => {
  const engines = c.ENGINES.map((e) => ({ ...e, alpha: true }));
  const s = {
    ...c.DEFAULTS,
    encoder: "h264_nvenc",
    preset: "p4",
    container: "mp4",
    alphaMode: "preserve",
  };
  const split = c
    .compatibility(s, engines)
    .suggestions.find((x) => x.id === "split-alpha");
  assert.deepEqual(split.patch, { alphaMode: "discard", alphaMask: true });
  assert.deepEqual(c.validate({ ...s, ...split.patch }), []);
  const prores = c
    .compatibility(s, engines)
    .suggestions.find((x) => x.id === "prores_ks");
  assert.equal(prores.patch.quality, 12);
});
