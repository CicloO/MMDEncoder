require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const media = require("../backend/media.cjs");
const {
  parseFrameRate,
  effectiveAudioOffset,
  referenceTiming,
} = require("../backend/audio-timing.mjs");
const { frameOffset } = require("../backend/audio-alignment.cjs");
const {
  createVideoAudioActions,
} = require("../backend/video-audio-actions.cjs");
const { ff, fp, nv, runCommand } = require("./engines.cjs");
const { createMediaQueue } = require("../backend/media-queue.cjs");

test("frame timing retains the reference fraction and marks audio-only fallback", () => {
  assert.deepEqual(parseFrameRate("30000/1001"), {
    numerator: 30000,
    denominator: 1001,
    fps: 30000 / 1001,
  });
  for (const invalid of ["0/0", "1/0", "bad", "", null, Infinity])
    assert.equal(parseFrameRate(invalid), null);
  assert.equal(
    effectiveAudioOffset(0.125, 2, "30000/1001"),
    0.125 - (2 * 1001) / 30000,
  );
  assert.equal(effectiveAudioOffset(0, -3, "24000/1001"), (3 * 1001) / 24000);
  assert.throws(() => frameOffset(0, 1.5, "30/1"), {
    code: "ALIGN_SHIFT_FRAMES_INVALID",
  });
  assert.throws(() => frameOffset(0, 1, "0/0"), {
    code: "ALIGN_FRAME_RATE_INVALID",
  });
  assert.throws(() => frameOffset(0, 1e10, "30/1"), {
    code: "ALIGN_SHIFT_RANGE_INVALID",
  });
  assert.deepEqual(
    referenceTiming({
      streams: [
        { codec_type: "audio", duration: "3" },
        {
          codec_type: "video",
          disposition: { attached_pic: 1 },
          avg_frame_rate: "25/1",
        },
      ],
    }),
    {
      fpsText: "30/1",
      fallback: true,
      hasVideo: false,
      hasAudio: true,
      duration: 3,
    },
  );
  const sequenceCommand = core.buildCommands(
    {
      path: "frame_0001.png",
      sequence: {
        pattern: "frame_%04d.png",
        start: 1,
        fps: 29.97,
        fpsText: "30000/1001",
      },
      meta: {
        width: 160,
        height: 96,
        fps: 29.97,
        fpsText: "30000/1001",
        duration: 2,
      },
      audioPath: "song.wav",
      audioMeta: { codec: "pcm_s16le", sampleRate: 48000 },
      audioShiftFrames: 30000,
    },
    {
      ...core.DEFAULTS,
      encoder: "libx264",
      container: "mkv",
      alphaMode: "discard",
      audio: "pcm_s16le",
    },
    { ffmpeg: ff },
    { output: "result.mkv" },
  )[0];
  assert.match(sequenceCommand.args.join(" "), /adelay=delays=48048000S:all=1/);
});

test("replacement actions keep frame shift across auto-align, clear it on new audio and reject stale results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-frame-actions-"));
  try {
    const first = path.join(dir, "first.wav"),
      second = path.join(dir, "second.wav");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    const job = {
      id: "v",
      status: "ready",
      meta: { fpsText: "30000/1001" },
      audioPath: first,
    };
    const pending = new Map();
    const actions = createVideoAudioActions({
      requireJob: () => job,
      isRunning: () => false,
      locate: async () => {},
      probeMedia: (file) =>
        new Promise((resolve) => pending.set(file, resolve)),
    });
    actions.setAudioOffset({ offset: 0.125, shiftFrames: 2 });
    actions.setAudioOffset({ offset: 0.25 });
    assert.equal(job.audioOffset, 0.25);
    assert.equal(job.audioShiftFrames, 2);
    assert.throws(
      () => actions.setAudioOffset({ offset: 0, expectedAudioPath: second }),
      { code: "ALIGN_CANCELLED" },
    );
    const old = actions.setAudio({ path: first });
    await Promise.resolve();
    const latest = actions.setAudio({ path: second });
    await Promise.resolve();
    pending.get(second)({ audio: { codec: "pcm_s16le" }, audioDuration: 3 });
    await latest;
    pending.get(first)({ audio: { codec: "flac" }, audioDuration: 4 });
    await old;
    assert.equal(job.audioPath, second);
    assert.equal(job.audioMeta.codec, "pcm_s16le");
    assert.equal(job.audioOffset, undefined);
    assert.equal(job.audioShiftFrames, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const run = (args) =>
  execFileSync(ff, ["-v", "error", ...args], { maxBuffer: 32 << 20 });
const probe = (file) =>
  JSON.parse(
    execFileSync(fp, [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
const decode = (file) =>
  run(["-i", file, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "-"]);
function samples(count) {
  const out = Buffer.alloc(count * 2);
  let random = 731;
  for (let i = 0; i < count; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) | 0;
    out.writeInt16LE((random >>> 17) - 16384, i * 2);
  }
  return out;
}
function expectedPcm(source, wave, shift, fps, count) {
  const offset = Math.round((wave - shift / fps) * 48000);
  const out = Buffer.alloc(count * 2);
  const sourceStart = Math.max(0, offset),
    destinationStart = Math.max(0, -offset);
  const copied = Math.max(
    0,
    Math.min(source.length / 2 - sourceStart, count - destinationStart),
  );
  if (copied)
    source.copy(
      out,
      destinationStart * 2,
      sourceStart * 2,
      (sourceStart + copied) * 2,
    );
  return out;
}
function checkSamples(actual, expected, label) {
  assert.ok(
    Math.abs(actual.length - expected.length) <= 2,
    `${label}: length ${actual.length / 2} vs ${expected.length / 2}`,
  );
  assert.deepEqual(
    actual.subarray(0, Math.min(actual.length, expected.length)),
    expected.subarray(0, Math.min(actual.length, expected.length)),
    `${label}: sample content`,
  );
}

test(
  "real PCM: fractional-FPS ±frame shifts and long/short merge or replacement audio match within one sample",
  { timeout: 180000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-frame-pcm-"));
    try {
      const long = samples(4 * 48000),
        short = long.subarray(0, 19200 * 2);
      const sources = { long, short };
      const audio = {};
      for (const [name, pcm] of Object.entries(sources)) {
        const raw = path.join(dir, name + ".s16");
        fs.writeFileSync(raw, pcm);
        audio[name] = path.join(dir, name + ".wav");
        run([
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-i",
          raw,
          "-c:a",
          "pcm_s16le",
          audio[name],
        ]);
      }
      const hiresFile = path.join(dir, "short24.wav");
      run(["-i", audio.short, "-c:a", "pcm_s24le", hiresFile]);
      const hiresAudio = core.audioInfo(probe(hiresFile).streams[0]);
      assert.equal(media.hiResPlan("wav", hiresAudio).action, "copy");
      let cases = 0;
      for (const [num, den, frames] of [
        [30000, 1001, 60],
        [24000, 1001, 48],
      ]) {
        const fpsText = `${num}/${den}`,
          duration = (frames * den) / num;
        const video = path.join(dir, num + ".mkv");
        run([
          "-f",
          "lavfi",
          "-i",
          `testsrc2=s=160x96:r=${fpsText}`,
          "-frames:v",
          String(frames),
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          video,
        ]);
        const meta = core.metadata(probe(video));
        const count = Math.round(duration * 48000);
        for (const [kind, shift] of [
          ["long", 2],
          ["long", -2],
          ["short", 1],
          ["short", -1],
          ["short", 0],
        ]) {
          const wave = kind === "long" ? 0.125 : 0;
          const expected = expectedPcm(
            sources[kind],
            wave,
            shift,
            num / den,
            count,
          );
          for (const mode of ["merge", "video"]) {
            const output = path.join(
              dir,
              `${num}-${kind}-${shift}-${mode}.mkv`,
            );
            const sourceAudio = core.audioInfo(probe(audio[kind]).streams[0]);
            const command =
              mode === "merge"
                ? media.command(
                    {
                      operation: "merge",
                      input: video,
                      audioInput: audio[kind],
                      output,
                      container: "mkv",
                      audioFormat: "wav",
                      sourceAudio,
                      videoDuration: duration,
                      audioOffset: wave - (shift * den) / num,
                    },
                    { ffmpeg: ff },
                    output,
                  )
                : core.buildCommands(
                    {
                      path: video,
                      meta,
                      audioPath: audio[kind],
                      audioMeta: sourceAudio,
                      audioDuration: sources[kind].length / 2 / 48000,
                      audioOffset: wave,
                      audioShiftFrames: shift,
                    },
                    {
                      ...core.DEFAULTS,
                      encoder: "libx264",
                      preset: "ultrafast",
                      container: "mkv",
                      alphaMode: "discard",
                      audio: "pcm_s16le",
                      audioFade: 0,
                    },
                    { ffmpeg: ff },
                    { output },
                  )[0];
            runCommand(command);
            checkSamples(
              decode(output),
              expected,
              `${fpsText} ${kind} ${shift} ${mode}`,
            );
            assert.equal(
              Number(
                probe(output).streams.find((s) => s.codec_type === "video")
                  .nb_read_frames,
              ),
              frames,
            );
            cases++;
          }
        }
        for (const mode of ["merge", "video"]) {
          const output = path.join(dir, `${num}-hires-${mode}.mkv`);
          const command =
            mode === "merge"
              ? media.command(
                  {
                    operation: "merge",
                    input: video,
                    audioInput: hiresFile,
                    output,
                    container: "mkv",
                    audioFormat: "wav",
                    hiRes: true,
                    sourceAudio: hiresAudio,
                    videoDuration: duration,
                  },
                  { ffmpeg: ff },
                  output,
                )
              : core.buildCommands(
                  {
                    path: video,
                    meta,
                    audioPath: hiresFile,
                    audioMeta: hiresAudio,
                    audioDuration: 0.4,
                  },
                  {
                    ...core.DEFAULTS,
                    encoder: "libx264",
                    preset: "ultrafast",
                    container: "mkv",
                    alphaMode: "discard",
                    audio: "pcm_s16le",
                    hiRes: true,
                    audioFade: 0,
                  },
                  { ffmpeg: ff },
                  { output },
                )[0];
          runCommand(command);
          checkSamples(
            decode(output),
            expectedPcm(short, 0, 0, num / den, count),
            `${fpsText} Hi-Res ${mode}`,
          );
          cases++;
        }
        const copied = path.join(dir, num + "-copy.mkv");
        runCommand(
          media.command(
            {
              operation: "merge",
              input: video,
              audioInput: audio.short,
              output: copied,
              container: "mkv",
              audioFormat: "copy",
              videoDuration: duration,
            },
            { ffmpeg: ff },
            copied,
          ),
        );
        assert.deepEqual(decode(copied), short);
        assert.equal(
          Number(
            probe(copied).streams.find((s) => s.codec_type === "video")
              .nb_read_frames,
          ),
          frames,
        );
        cases++;
      }
      console.log(`Actual PCM frame-shift/duration cases: ${cases}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "media queue persists independent frame shifts and converts merge/extraction using the probed reference FPS",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-frame-queue-"));
    try {
      const video = path.join(dir, "video.mkv"),
        audio = path.join(dir, "audio.wav"),
        other = path.join(dir, "other.wav");
      const pcm = samples(4 * 48000),
        raw = path.join(dir, "audio.s16");
      fs.writeFileSync(raw, pcm);
      run([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x96:r=30000/1001",
        "-frames:v",
        "60",
        "-c:v",
        "libx264",
        video,
      ]);
      run([
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        raw,
        "-c:a",
        "pcm_s16le",
        audio,
      ]);
      fs.copyFileSync(audio, other);
      let jobs = [],
        running = false;
      const getInfo = async (file) => {
        const data = probe(file),
          timing = referenceTiming(data),
          a = data.streams.find((s) => s.codec_type === "audio"),
          v = data.streams.find((s) => s.codec_type === "video");
        return {
          hasVideo: timing.hasVideo,
          fpsText: timing.fpsText,
          videoDuration: v ? timing.duration : 0,
          audioDuration: a
            ? Number(a.duration) || Number(data.format.duration)
            : 0,
          audio: a ? core.audioInfo(a) : undefined,
          videoCodec: v?.codec_name,
          audioCodec: a?.codec_name,
        };
      };
      const queue = createMediaQueue({
        getJobs: () => jobs,
        setJobs: (value) => (jobs = value),
        engineInfo: () => ({ ffmpeg: ff, ffprobe: fp }),
        isRunning: () => running,
        setRunning: (value) => (running = value),
        isStopped: () => false,
        setStopped: () => {},
        onNotice: () => {},
        emit: () => {},
        emitProgress: () => {},
        run: async (exe, args) => ({
          stdout: execFileSync(exe, args, { encoding: "utf8", stdio: "pipe" }),
        }),
        locate: async () => {},
        probeMedia: getInfo,
        hasSoxr: async () => false,
        commit: async (from, to) => fs.renameSync(from, to),
        dataDir: dir,
        isBusy: () => false,
        probeLimit: (fn) => Promise.resolve().then(fn),
        reorder: (list) => list,
      });
      const until = async (fn) => {
        const end = Date.now() + 15000;
        while (!fn()) {
          if (Date.now() > end) throw Error("media frame task timed out");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      };
      queue.actions.mediaAdd({ paths: [video] });
      await until(() => jobs[0]?.meta);
      const job = jobs[0];
      await queue.actions.mediaSetAudio({ id: job.id, path: audio });
      queue.actions.mediaSetAudioOffset({
        id: job.id,
        offset: 0.125,
        shiftFrames: 2,
      });
      queue.actions.mediaSetAudioOffset({ id: job.id, offset: 0.25 });
      assert.equal(job.audioShiftFrames, 2);
      assert.throws(
        () =>
          queue.actions.mediaSetAudioOffset({
            id: job.id,
            offset: 0,
            shiftFrames: 1.5,
          }),
        { code: "ALIGN_SHIFT_FRAMES_INVALID" },
      );
      assert.throws(
        () =>
          queue.actions.mediaSetAudioOffset({
            id: job.id,
            offset: 0,
            expectedAudioPath: other,
          }),
        { code: "ALIGN_CANCELLED" },
      );
      await queue.actions.mediaStart({
        operation: "merge",
        audioFormat: "wav",
        container: "mkv",
        location: "source",
      });
      await until(() => !running);
      assert.equal(job.status, "done", job.error);
      checkSamples(
        decode(job.output),
        expectedPcm(pcm, 0.25, 2, 30000 / 1001, 96096),
        "queued merge",
      );
      queue.actions.mediaRequeue({ id: job.id });
      await queue.actions.mediaSetAudio({ id: job.id, path: other });
      assert.equal(job.audioOffset, undefined);
      assert.equal(job.audioShiftFrames, undefined);
      queue.actions.mediaRemove({ id: job.id });
      queue.actions.mediaAdd({ paths: [audio] });
      await until(() => jobs[0]?.meta);
      const extraction = jobs[0];
      await queue.actions.mediaSetAlign({
        id: extraction.id,
        align: { reference: video, offset: 0.125, shiftFrames: -1, trim: true },
      });
      await queue.actions.mediaSetAlign({
        id: extraction.id,
        align: { reference: video, offset: 0.25, trim: true },
      });
      assert.equal(extraction.align.shiftFrames, -1);
      assert.equal(extraction.align.fpsText, "30000/1001");
      await queue.actions.mediaStart({
        operation: "audio",
        audioFormat: "wav",
        container: "mkv",
        location: "source",
      });
      await until(() => !running);
      assert.equal(extraction.status, "done", extraction.error);
      checkSamples(
        decode(extraction.output),
        expectedPcm(pcm, 0.25, -1, 30000 / 1001, 96096),
        "queued extraction",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "actual NVEncC replacement retains ±fractional-frame PCM alignment and video length",
  { timeout: 120000 },
  () => {
    assert.ok(
      fs.existsSync(nv),
      "native NVEncC is required for this changed route",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-frame-nvencc-"));
    try {
      const video = path.join(dir, "video.mkv"),
        raw = path.join(dir, "song.s16"),
        song = path.join(dir, "song.wav");
      const pcm = samples(4 * 48000);
      fs.writeFileSync(raw, pcm);
      run([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x96:r=30000/1001",
        "-frames:v",
        "60",
        "-c:v",
        "libx264",
        video,
      ]);
      run([
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        raw,
        "-c:a",
        "pcm_s16le",
        song,
      ]);
      const meta = core.metadata(probe(video)),
        sourceAudio = core.audioInfo(probe(song).streams[0]);
      for (const shift of [-2, 2]) {
        const output = path.join(dir, `nv-${shift}.mkv`);
        const command = core.buildCommands(
          {
            path: video,
            meta,
            audioPath: song,
            audioMeta: sourceAudio,
            audioDuration: 4,
            audioOffset: 0,
            audioShiftFrames: shift,
          },
          {
            ...core.DEFAULTS,
            encoder: "nvencc:h264",
            preset: "p4",
            container: "mkv",
            alphaMode: "discard",
            audio: "pcm_s16le",
            audioFade: 0,
          },
          { ffmpeg: ff, nvencc: nv },
          { output },
        )[0];
        runCommand(command);
        checkSamples(
          decode(output),
          expectedPcm(pcm, 0, shift, 30000 / 1001, 96096),
          `NVEncC ${shift}`,
        );
        assert.equal(
          Number(
            probe(output).streams.find((s) => s.codec_type === "video")
              .nb_read_frames,
          ),
          60,
        );
      }
      console.log("Actual NVEncC fractional-frame cases: 2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
