const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createService } = require("../backend/service.cjs"),
  { ff, fp, engineDir } = require("./engines.cjs"),
  { command } = require("../backend/media.cjs");
test("media tool validation rejects overwrite and mismatched containers", () => {
  const root = path.resolve(os.tmpdir()),
    input = path.join(root, "input.mkv");
  assert.throws(
    () =>
      command(
        { operation: "audio", input, output: input, audioFormat: "wav" },
        {},
        "temp",
      ),
    /覆盖/,
  );
  assert.throws(
    () =>
      command(
        {
          operation: "audio",
          input,
          output: path.join(root, "x.mp4"),
          audioFormat: "wav",
        },
        {},
        "temp",
      ),
    /\.wav/,
  );
  assert.throws(
    () =>
      command(
        {
          operation: "merge",
          input,
          audioInput: input,
          output: path.join(root, "x.mp4"),
        },
        {},
        "temp",
      ),
    /mkv/,
  );
});
async function wait(fn) {
  for (let i = 0; i < 1200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("timeout");
}
test(
  "media queue: batch extraction, merge pairing, locations, re-export, failures and cancellation",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-media-"));
    const input = path.join(root, "source.mkv"),
      second = path.join(root, "second.mkv"),
      voice = path.join(root, "voice.wav");
    let service;
    try {
      for (const [file, freq] of [
        [input, 440],
        [second, 660],
      ])
        execFileSync(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=640x360:r=30:d=2",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${freq}:duration=2`,
          "-c:v",
          "libx264",
          "-c:a",
          "flac",
          "-shortest",
          file,
        ]);
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=2",
        voice,
      ]);
      service = createService({ engineDir, dataDir: path.join(root, "data") });
      await wait(
        () => service.getState().located && !service.getState().detecting,
      );
      const jobs = () => service.getState().mediaJobs;
      const byPath = (f) => jobs().find((j) => j.path === f);
      const runQueue = async (options) => {
        await service.invoke("mediaStart", options);
        await wait(() => !service.getState().running);
      };
      const probe = (f) =>
        JSON.parse(
          execFileSync(
            fp,
            ["-v", "error", "-show_streams", "-show_format", "-of", "json", f],
            { encoding: "utf8" },
          ),
        );

      // Batch: two files, default location = same folder as the source.
      await service.invoke("mediaAdd", { paths: [input, second, input] });
      assert.equal(jobs().length, 2);
      await runQueue({
        operation: "audio",
        audioFormat: "wav",
        location: "source",
      });
      for (const f of [input, second]) {
        const j = byPath(f);
        assert.equal(j.status, "done", j.error);
        assert.equal(j.output, f.replace(/.mkv$/, ".wav"));
        assert.equal(probe(j.output).streams[0].codec_name, "pcm_s16le");
      }
      // Re-export keeps the first output and numbers the new one.
      await service.invoke("mediaRequeue", { id: byPath(input).id });
      assert.equal(byPath(input).status, "ready");
      await runQueue({
        operation: "audio",
        audioFormat: "wav",
        location: "source",
      });
      assert.equal(byPath(input).output, path.join(root, "source (2).wav"));
      assert.ok(fs.existsSync(path.join(root, "source.wav")));
      await service.invoke("mediaClearCompleted");
      assert.equal(jobs().length, 0);

      // Encoded subfolder location and video-only extraction.
      await service.invoke("mediaAdd", { paths: [input] });
      await runQueue({ operation: "video", location: "encoded" });
      const video = byPath(input).output;
      assert.equal(video, path.join(root, "Encoded", "source_无音频.mkv"));
      assert.equal(probe(video).streams.length, 1);

      // Merge needs a paired audio; a missing pair fails only that file.
      await service.invoke("mediaAdd", { paths: [video, second] });
      await service.invoke("mediaSetAudio", {
        id: byPath(video).id,
        path: voice,
      });
      const custom = path.join(root, "out");
      await runQueue({
        operation: "merge",
        audioFormat: "flac",
        shortest: true,
        location: "custom",
        outputDir: custom,
      });
      assert.equal(byPath(video).status, "done", byPath(video).error);
      assert.equal(
        byPath(video).output,
        path.join(custom, "source_无音频_合并.mkv"),
      );
      assert.deepEqual(
        probe(byPath(video).output).streams.map((s) => s.codec_type),
        ["video", "audio"],
      );
      assert.equal(byPath(second).status, "failed");
      assert.match(byPath(second).error, /缺少/);
      await assert.rejects(
        service.invoke("mediaStart", {
          operation: "merge",
          location: "custom",
        }),
        /自定义输出目录/,
      );

      // A file without audio fails with the tool output; nothing is written.
      await service.invoke("mediaRequeue", { id: byPath(video).id });
      await runQueue({
        operation: "audio",
        audioFormat: "wav",
        location: "source",
      });
      assert.equal(byPath(video).status, "failed");
      assert.ok(byPath(video).log.includes("matches no streams"));
      assert.equal(fs.existsSync(video.replace(/.mkv$/, ".wav")), false);

      // Cancellation leaves no output or temporary folder behind.
      await service.invoke("mediaRemove", { id: byPath(video).id });
      await service.invoke("mediaRequeue", { id: byPath(second).id });
      await service.invoke("mediaStart", {
        operation: "audio",
        audioFormat: "flac",
        location: "source",
      });
      await service.invoke("cancel");
      await wait(() => !service.getState().running);
      assert.equal(byPath(second).status, "cancelled");
      assert.equal(fs.existsSync(path.join(root, "second.flac")), false);
      assert.ok(!fs.readdirSync(root).some((n) => n.startsWith(".mmd-media-")));

      await service.invoke("add", { paths: [input] });
      const job = service.getState().jobs[0];
      const details = await service.invoke("details", { id: job.id });
      assert.equal(details.before.streams.length, 2);
      assert.match(details.after.message, /尚未生成/);
    } finally {
      service?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
test("media output name is automatic, follows output location and never overwrites", () => {
  const { suggestOutput } = require("../backend/media.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-media-name-"));
  try {
    const input = path.join(dir, "舞台.mp4");
    const exists = (f) => fs.existsSync(f);
    const encoded = { outputMode: "encoded" };
    const first = suggestOutput(
      { operation: "audio", input, audioFormat: "wav" },
      encoded,
      exists,
    );
    assert.equal(first, path.join(dir, "Encoded", "舞台.wav"));
    fs.mkdirSync(path.dirname(first));
    fs.writeFileSync(first, "");
    assert.equal(
      suggestOutput(
        { operation: "audio", input, audioFormat: "wav" },
        encoded,
        exists,
      ),
      path.join(dir, "Encoded", "舞台 (2).wav"),
    );
    assert.equal(
      suggestOutput(
        { operation: "video", input },
        { outputMode: "source" },
        exists,
      ),
      path.join(dir, "舞台_无音频.mkv"),
    );
    assert.equal(
      suggestOutput(
        { operation: "merge", input, audioInput: path.join(dir, "a.wav") },
        { outputMode: "custom", outputDir: path.join(dir, "out") },
        exists,
      ),
      path.join(dir, "out", "舞台_合并.mkv"),
    );
    const wav = path.join(dir, "原声.wav");
    assert.equal(
      suggestOutput(
        { operation: "audio", input: wav, audioFormat: "wav" },
        { outputMode: "source" },
        exists,
      ),
      path.join(dir, "原声 (2).wav"),
    );
    assert.equal(
      suggestOutput({ operation: "audio", input: "" }, encoded, exists),
      "",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
