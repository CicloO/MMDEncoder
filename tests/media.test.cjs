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
          output: path.join(root, "x.avi"),
        },
        {},
        "temp",
      ),
    /\.mp4 或 \.mkv/,
  );
});
test("media audio bitrate follows the source and MP4 falls back to MKV", () => {
  const { audioBitrate, mergeContainer } = require("../backend/media.cjs");
  // Follow source: lossy keeps its rate, lossless and unknown use 320k.
  assert.equal(
    audioBitrate(0, "aac", { codec: "aac", bitRate: "256000" }),
    256,
  );
  assert.equal(
    audioBitrate(0, "aac", { codec: "pcm_s16le", bitRate: "1536000" }),
    320,
  );
  assert.equal(audioBitrate(0, "libopus", { codec: "flac" }), 320);
  assert.equal(audioBitrate(0, "aac", {}), 320);
  // MP3 is capped at 320k; an explicit choice wins over the source.
  assert.equal(
    audioBitrate(0, "libmp3lame", { codec: "aac", bitRate: "448000" }),
    320,
  );
  assert.equal(audioBitrate(512, "libmp3lame"), 320);
  assert.equal(audioBitrate(128, "aac", { codec: "flac" }), 128);
  const merge = { operation: "merge", container: "mp4", audioFormat: "aac" };
  assert.equal(mergeContainer(merge, { videoCodec: "h264" }), "mp4");
  assert.equal(mergeContainer(merge, { videoCodec: "rawvideo" }), "mkv");
  assert.equal(
    mergeContainer({ ...merge, audioFormat: "wav" }, { videoCodec: "h264" }),
    "mkv",
  );
  assert.equal(
    mergeContainer(
      { ...merge, audioFormat: "copy" },
      { videoCodec: "h264", audioCodec: "pcm_s16le" },
    ),
    "mkv",
  );
  assert.equal(
    mergeContainer({ ...merge, container: "mkv" }, { videoCodec: "h264" }),
    "mkv",
  );
  const root = path.resolve(os.tmpdir());
  const mp3 = command(
    {
      operation: "audio",
      input: path.join(root, "a.mkv"),
      output: path.join(root, "a.mp3"),
      audioFormat: "mp3",
      sourceAudio: { codec: "aac", bitRate: "192000" },
    },
    {},
    "temp",
  );
  assert.ok(mp3.args.join(" ").includes("-c:a libmp3lame -b:a 192k"));
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
      // Added files are probed like the video queue (audio files get a summary).
      assert.equal(byPath(input).meta.width, 640);
      assert.equal(byPath(input).meta.audio.codec, "flac");
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
      // MP4 is the default container for copied H.264 video.
      assert.equal(video, path.join(root, "Encoded", "source_no_audio.mp4"));
      assert.equal(probe(video).streams.length, 1);

      // Merge needs a paired audio; a missing pair fails only that file.
      await service.invoke("mediaAdd", { paths: [video, second] });
      await service.invoke("mediaSetAudio", {
        id: byPath(video).id,
        path: voice,
      });
      const custom = path.join(root, "out");
      // Drag-sort: the second file now runs first.
      const first = (f) => [
        byPath(f).id,
        ...jobs()
          .filter((j) => j.path !== f)
          .map((j) => j.id),
      ];
      await service.invoke("mediaReorder", { ids: first(second) });
      assert.equal(jobs()[0].path, second);
      await assert.rejects(
        service.invoke("mediaReorder", { ids: [byPath(second).id] }),
        /排序/,
      );
      await runQueue({
        operation: "merge",
        audioFormat: "aac",
        location: "custom",
        outputDir: custom,
      });
      assert.equal(byPath(video).status, "done", byPath(video).error);
      assert.equal(
        byPath(video).output,
        path.join(custom, "source_no_audio_merged.mp4"),
      );
      // Lossless WAV source: "follow source" bitrate becomes 320k.
      assert.ok(byPath(video).log.includes("'-b:a' '320k'"));
      assert.deepEqual(
        probe(byPath(video).output).streams.map((s) => s.codec_type),
        ["video", "audio"],
      );
      const mediaDetails = await service.invoke("details", {
        id: byPath(video).id,
        media: true,
      });
      assert.equal(mediaDetails.audio.streams[0].codec_name, "pcm_s16le");
      assert.equal(mediaDetails.after.streams[1].codec_name, "aac");
      assert.equal(mediaDetails.mask, undefined);
      // WAV cannot go into MP4: the merge falls back to MKV and says so.
      await service.invoke("mediaRequeue", { id: byPath(video).id });
      await service.invoke("mediaReorder", { ids: first(video) });
      await runQueue({
        operation: "merge",
        audioFormat: "wav",
        location: "custom",
        outputDir: custom,
      });
      assert.equal(
        byPath(video).output,
        path.join(custom, "source_no_audio_merged.mkv"),
      );
      assert.match(byPath(video).log, /已改用 MKV/);
      assert.equal(byPath(second).status, "failed");
      assert.match(byPath(second).error, /缺少/);
      assert.equal(byPath(second).errorData.code, "MEDIA_MERGE_AUDIO_MISSING");
      assert.deepEqual(byPath(second).errorData.params, {});
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
      assert.equal(byPath(video).errorData.message, byPath(video).error);
      assert.equal(fs.existsSync(video.replace(/.mp4$/, ".wav")), false);

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
      path.join(dir, "舞台_no_audio.mkv"),
    );
    assert.equal(
      suggestOutput(
        { operation: "merge", input, audioInput: path.join(dir, "a.wav") },
        { outputMode: "custom", outputDir: path.join(dir, "out") },
        exists,
      ),
      path.join(dir, "out", "舞台_merged.mkv"),
    );
    for (const [operation, suffix] of [
      ["video", "_no_audio"],
      ["merge", "_merged"],
    ]) {
      const target = path.join(dir, "舞台" + suffix + ".mkv");
      fs.writeFileSync(target, "existing");
      assert.equal(
        suggestOutput({ operation, input }, { outputMode: "source" }, exists),
        path.join(dir, "舞台" + suffix + " (2).mkv"),
      );
      assert.equal(fs.readFileSync(target, "utf8"), "existing");
    }
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
test("audio info reads codec, profile and bitrate, falling back to the MKV BPS tag", () => {
  const { audioInfo } = require("../backend/core.cjs");
  const aac = audioInfo({
    codec_name: "aac",
    profile: "LC",
    bit_rate: "317375",
    sample_rate: "48000",
    channels: 2,
  });
  assert.equal(aac.profile, "LC");
  assert.equal(aac.bitRate, 317375);
  assert.equal(
    audioInfo({ codec_name: "opus", tags: { BPS: "192000" } }).bitRate,
    192000,
  );
  assert.equal(
    audioInfo({ codec_name: "flac", profile: "unknown" }).bitRate,
    0,
  );
  assert.equal(
    audioInfo({ codec_name: "flac", profile: "unknown" }).profile,
    undefined,
  );
});

test(
  "a waiting file removed from the media queue during a run is not processed",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-remove-"));
    const until = async (f) => {
      for (let i = 0; i < 600 && !f(); i++)
        await new Promise((r) => setTimeout(r, 50));
    };
    const service = createService({
      engineDir,
      dataDir: path.join(root, "data"),
    });
    try {
      // A long first file keeps the run busy while the second is removed.
      const [a, b] = ["a.wav", "b.wav"].map((n) => path.join(root, n));
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=600",
        a,
      ]);
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1",
        b,
      ]);
      await until(
        () => service.getState().located && !service.getState().detecting,
      );
      await service.invoke("mediaAdd", { paths: [a, b] });
      await service.invoke("mediaStart", {
        operation: "audio",
        audioFormat: "flac",
      });
      await until(() => service.getState().mediaJobs[0].status === "running");
      const second = service.getState().mediaJobs[1];
      await service.invoke("mediaRemove", { id: second.id });
      await until(() => !service.getState().running);
      assert.deepEqual(
        service.getState().mediaJobs.map((j) => path.basename(j.path)),
        ["a.wav"],
      );
      assert.ok(fs.existsSync(path.join(root, "a.flac")));
      assert.equal(fs.existsSync(path.join(root, "b.flac")), false);
    } finally {
      service.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Hi-Res plan: copy, lossless re-encode or resample, with reasons", () => {
  const { hiResPlan } = require("../backend/media.cjs");
  const plan = (f, s) => {
    const p = hiResPlan(f, s);
    return [p.action, p.codec, p.rate, !!p.dither];
  };
  assert.deepEqual(
    plan("flac", { codec: "pcm_s16le", sampleRate: 44100, bits: 16 }),
    ["resample", "flac", 88200, false],
  );
  assert.deepEqual(
    plan("wav", { codec: "pcm_s16le", sampleRate: 32000, bits: 16 }),
    ["resample", "pcm_s24le", 64000, false],
  );
  // 48 kHz / 24-bit: same codec copies, another lossless codec re-encodes.
  assert.deepEqual(
    plan("wav", { codec: "pcm_s24le", sampleRate: 48000, bits: 24 }),
    ["copy", "pcm_s24le", 48000, false],
  );
  assert.deepEqual(
    plan("flac", { codec: "pcm_s24le", sampleRate: 48000, bits: 24 }),
    ["encode", "flac", 48000, false],
  );
  assert.deepEqual(
    plan("flac", { codec: "flac", sampleRate: 96000, bits: 24 }),
    ["copy", "flac", 96000, false],
  );
  // 32-bit integer and float are reduced to 24-bit with dither.
  assert.deepEqual(
    plan("wav", { codec: "pcm_s32le", sampleRate: 96000, bits: 32 }),
    ["encode", "pcm_s24le", 96000, true],
  );
  assert.deepEqual(
    plan("flac", {
      codec: "pcm_f32le",
      sampleRate: 48000,
      bits: 32,
      float: true,
    }),
    ["encode", "flac", 48000, true],
  );
  assert.throws(() => hiResPlan("aac", { sampleRate: 48000 }), /WAV \/ FLAC/);
  assert.throws(() => hiResPlan("wav", {}), /采样率/);
  // Lossy output with Hi-Res is refused by the command too.
  const dir = os.tmpdir();
  assert.throws(
    () =>
      command(
        {
          operation: "audio",
          input: path.join(dir, "a.wav"),
          output: path.join(dir, "a.m4a"),
          audioFormat: "aac",
          hiRes: true,
          sourceAudio: { sampleRate: 44100 },
        },
        { ffmpeg: "ffmpeg" },
        path.join(dir, "a.m4a"),
      ),
    /WAV \/ FLAC/,
  );
  // Without soxr in the installed FFmpeg: its own resampler at high quality.
  const args = (soxr) =>
    command(
      {
        operation: "audio",
        input: path.join(dir, "a.wav"),
        output: path.join(dir, "a.flac"),
        audioFormat: "flac",
        hiRes: true,
        soxr,
        sourceAudio: { codec: "pcm_s16le", sampleRate: 44100, bits: 16 },
      },
      { ffmpeg: "ffmpeg" },
      path.join(dir, "a.flac"),
    ).args.join(" ");
  assert.match(args(true), /aresample=88200:resampler=soxr/);
  assert.match(args(false), /aresample=88200:filter_size=128/);
  assert.match(args(false), /-bits_per_raw_sample 24 -ar 88200/);
});

test(
  "Hi-Res output: 44.1 kHz doubles, 48 kHz stays, float becomes 24-bit, merges go to MKV",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-hires-"));
    const until = async (f) => {
      for (let i = 0; i < 600 && !f(); i++)
        await new Promise((r) => setTimeout(r, 50));
    };
    const service = createService({
      engineDir,
      dataDir: path.join(root, "data"),
    });
    const audioOf = (file) =>
      JSON.parse(
        execFileSync(
          fp,
          [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            file,
          ],
          { encoding: "utf8" },
        ),
      );
    try {
      const make = (name, rate, codec) => {
        const file = path.join(root, name);
        execFileSync(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=1000:sample_rate=${rate}:duration=2`,
          "-c:a",
          codec,
          file,
        ]);
        return file;
      };
      const cd = make("cd.wav", 44100, "pcm_s16le");
      const dvd = make("dvd.wav", 48000, "pcm_s16le");
      const float = make("float.wav", 48000, "pcm_f32le");
      await until(
        () => service.getState().located && !service.getState().detecting,
      );
      await service.invoke("mediaAdd", { paths: [cd, dvd, float] });
      await until(() => service.getState().mediaJobs.every((j) => j.meta));
      assert.equal(service.getState().mediaJobs[0].meta.audio.bits, 16);
      await service.invoke("mediaStart", {
        operation: "audio",
        audioFormat: "flac",
        hiRes: true,
      });
      await until(() => !service.getState().running);
      const jobs = service.getState().mediaJobs;
      assert.ok(
        jobs.every((j) => j.status === "done"),
        jobs.map((j) => j.error).join(" | "),
      );
      const result = (job) => {
        const s = audioOf(job.output).streams[0];
        return [
          Number(s.sample_rate),
          Number(s.bits_per_raw_sample),
          s.codec_name,
        ];
      };
      assert.deepEqual(result(jobs[0]), [88200, 24, "flac"]);
      assert.deepEqual(result(jobs[1]), [48000, 24, "flac"]);
      assert.deepEqual(result(jobs[2]), [48000, 24, "flac"]);
      assert.match(jobs[0].log, /44\.1 kHz \/ 16-bit → 88\.2 kHz \/ 24-bit/);
      // Length is unchanged by resampling.
      assert.ok(
        Math.abs(Number(audioOf(jobs[0].output).format.duration) - 2) < 0.01,
      );

      // Merge: the replacement audio's own parameters decide; output is MKV.
      const video = path.join(root, "clip.mp4");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=2",
        "-c:v",
        "libx264",
        video,
      ]);
      await service.invoke("mediaClearCompleted");
      await service.invoke("mediaAdd", { paths: [video] });
      await until(() => service.getState().mediaJobs[0]?.meta);
      const id = service.getState().mediaJobs[0].id;
      await service.invoke("mediaSetAudio", { id, path: cd });
      assert.equal(service.getState().mediaJobs[0].audioMeta.sampleRate, 44100);
      await service.invoke("mediaStart", {
        operation: "merge",
        audioFormat: "wav",
        hiRes: true,
        container: "mp4",
      });
      await until(() => !service.getState().running);
      const merged = service.getState().mediaJobs[0];
      assert.equal(merged.status, "done", merged.error);
      assert.equal(path.extname(merged.output), ".mkv");
      const a = audioOf(merged.output).streams[0];
      assert.deepEqual(
        [a.codec_name, Number(a.sample_rate)],
        ["pcm_s24le", 88200],
      );
    } finally {
      service.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
