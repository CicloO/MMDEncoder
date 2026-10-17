const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../backend/core.cjs");
const engines = c.ENGINES.map((e) => ({ ...e, alpha: e.id === "nvencc:hevc" }));
test("Alpha repairs prefer verified HEVC hardware and preserve unrelated settings", () => {
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
  assert.equal(result.suggestions[0].id, "nvencc:hevc");
  for (const suggestion of result.suggestions) {
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
