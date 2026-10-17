const test = require("node:test");
const assert = require("node:assert/strict");
test("media display preserves 59.94, unknown metadata and long durations", async () => {
  const { formatFPS, formatDuration, formatSize } =
    await import("../src/presentation.ts");
  assert.equal(formatFPS("60000/1001"), "59.94");
  assert.equal(formatFPS(undefined), "未知");
  assert.equal(formatDuration(3661), "01:01:01");
  assert.equal(formatSize(0), "0 B");
});
test("container compatibility keeps incompatible presets visible as errors rather than silently coercing", async () => {
  const { compatibilityErrors } = await import("../src/presentation.ts");
  assert.ok(
    compatibilityErrors({
      container: "webm",
      encoder: "libx264",
      audio: "flac",
      bitDepth: 8,
    }).length >= 2,
  );
  assert.equal(
    compatibilityErrors({
      container: "mp4",
      encoder: "libx264",
      audio: "aac",
      bitDepth: 8,
    }).length,
    0,
  );
});
