require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { ff, fp } = require("./engines.cjs");

test("unchanged waveform previews reuse PCM, changed files and LRU eviction decode again, cancellation and errors never become cache entries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-preview-cache-"));
  const files = ["a.wav", "b.wav", "c.wav"].map((name) => path.join(dir, name));
  const write = (file, duration) =>
    childProcess.execFileSync(ff, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=d=${duration}:r=24000`,
      file,
    ]);
  for (const file of files) write(file, 0.3);
  const realSpawn = childProcess.spawn;
  let launches = 0;
  // Observe actual worker launches without adding a production testing API.
  t.mock.method(childProcess, "spawn", (...args) => {
    launches++;
    return realSpawn(...args);
  });
  delete require.cache[require.resolve("../backend/align-service.cjs")];
  const { createAlignService } = require("../backend/align-service.cjs");
  const service = createAlignService({
    engineInfo: () => ({ ffmpeg: ff, ffprobe: fp }),
    locate: async () => {},
  });
  const preview = (file, slot = "cache-test") =>
    service.queries.alignPreview({ path: file, slot });
  try {
    const start = performance.now();
    const first = await preview(files[0]);
    const decodedMs = performance.now() - start;
    assert.equal(launches, 1);
    const cachedStart = performance.now();
    const second = await preview(files[0]);
    const cachedMs = performance.now() - cachedStart;
    assert.equal(launches, 1);
    assert.deepEqual(first, second);
    first.pcm.fill(0);
    assert.ok(
      (await preview(files[0])).pcm.some((value) => value !== 0),
      "caller cannot change cached PCM",
    );
    write(files[0], 0.6);
    assert.ok((await preview(files[0])).duration > 0.59);
    assert.equal(launches, 2);
    await preview(files[1]);
    await preview(files[2]);
    const afterThree = launches;
    await preview(files[0]);
    assert.equal(launches, afterThree + 1, "only two previews remain cached");
    const invalid = path.join(dir, "invalid.wav");
    fs.writeFileSync(invalid, "not audio");
    await assert.rejects(preview(invalid));
    const failed = launches;
    await assert.rejects(preview(invalid));
    assert.equal(launches, failed + 1);
    service.stopAll();
    const cleared = launches;
    await preview(files[0]);
    assert.equal(launches, cleared + 1, "stopAll releases cached audio");
    const pending = preview(files[1], "replace-slot");
    await new Promise((resolve) => setImmediate(resolve));
    await preview(files[0], "replace-slot");
    await assert.rejects(pending, (error) => error.code === "ALIGN_CANCELLED");
    const cancelled = launches;
    await preview(files[1]);
    assert.equal(launches, cancelled + 1);
    console.log(JSON.stringify({ decodedMs, cachedMs, launches }));
  } finally {
    service.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
