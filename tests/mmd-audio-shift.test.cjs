const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ff, fp } = require("./engines.cjs");
const mx = require("../backend/mmd-export.cjs");
const { createService } = require("../backend/service.cjs");
const core = require("../backend/core.cjs");
const evidence = path.resolve(__dirname, "../verification/i18n");
fs.mkdirSync(evidence, { recursive: true });
const dir = fs.mkdtempSync(path.join(evidence, "mmd-audio-shift-"));
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, {
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 16 << 20,
    ...options,
  });
function wav(file, sampleRate, samples) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(((i * 127) % 30000) + 1, i * 2);
  run(
    ff,
    [
      "-v",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "pcm_s16le",
      file,
    ],
    { input: pcm },
  );
  return pcm;
}
function expectedPcm(
  pcm,
  sampleRate,
  frames,
  startFrame,
  isWav,
  manual,
  automatic,
  count,
) {
  const shiftedFrames = manual + (automatic && startFrame === 1 ? 1 : 0);
  const shift = Math.round((shiftedFrames * sampleRate) / 30);
  const origin = isWav ? Math.round((startFrame * sampleRate) / 30) : 0;
  const result = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const source = origin + i - shift;
    if (i >= Math.max(0, shift) && source >= origin && source < pcm.length / 2)
      result.writeInt16LE(pcm.readInt16LE(source * 2), i * 2);
  }
  return result;
}
function assertPcm(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + " sample count");
  if (!actual.equals(expected)) {
    let i = 0;
    while (actual.readInt16LE(i * 2) === expected.readInt16LE(i * 2)) i++;
    assert.fail(
      `${label} sample ${i}: ${actual.readInt16LE(i * 2)} != ${expected.readInt16LE(i * 2)}`,
    );
  }
}

test("MMD audio choices persist independently, reject fractional frames and follow native selection updates", async () => {
  const dataDir = path.join(dir, "data");
  let svc = createService({ dataDir });
  try {
    const presets = svc.getState().presets;
    assert.equal(svc.getState().mmd.audioShiftFrames, 0);
    assert.equal(svc.getState().mmd.audioAutoShift, true);
    await svc.invoke("mmdExportSet", { audioShiftFrames: 1 });
    assert.equal(mx.readSelection().audioShiftFrames, 1);
    assert.equal(mx.readSelection().audioAutoShift, true);
    await svc.invoke("mmdExportSet", { audioAutoShift: false });
    assert.equal(mx.readSelection().audioShiftFrames, 1);
    await assert.rejects(
      svc.invoke("mmdExportSet", { audioShiftFrames: 1.5 }),
      { code: "MMD_AUDIO_SHIFT_INVALID" },
    );
    await assert.rejects(
      svc.invoke("mmdExportSet", { audioAutoShift: "false" }),
      { code: "MMD_AUDIO_AUTO_SHIFT_INVALID" },
    );
    assert.equal(mx.readSelection().audioShiftFrames, 1);
    assert.equal(mx.readSelection().audioAutoShift, false);
    svc.dispose();
    svc = createService({ dataDir });
    assert.equal(svc.getState().mmd.audioShiftFrames, 1);
    assert.equal(svc.getState().mmd.audioAutoShift, false);
    mx.writeSelection({
      ...mx.readSelection(),
      audioShiftFrames: -2,
      audioAutoShift: true,
      savedAt: "2099-01-01T00:00:00Z",
    });
    await svc.invoke("mmdStatus");
    assert.equal(svc.getState().mmd.audioShiftFrames, -2);
    assert.equal(svc.getState().mmd.audioAutoShift, true);
    const stored = JSON.parse(
      fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
    );
    assert.equal(stored.mmdExport.audioShiftFrames, -2);
    assert.equal(stored.mmdExport.audioAutoShift, true);
    assert.equal(stored.settings.audioShiftFrames, undefined);
    assert.equal(stored.settings.audioAutoShift, undefined);
    assert.deepEqual(svc.getState().presets, presets);
  } finally {
    svc.dispose();
  }
});

test(
  "MMD audio shift matches exact PCM for both sources, saved choices, frame rates and source boundaries",
  { timeout: 300000 },
  async () => {
    const results = [];
    const settings = {
      ...core.BUILTINS.find((p) => p.id === "builtin-1080-sw").settings,
      container: "mkv",
      audio: "pcm_s16le",
      hiRes: false,
      audioFade: 0,
    };
    const engines = { ffmpeg: ff, ffprobe: fp };
    let number = 0;
    async function check({
      video,
      avi,
      pmm,
      pcm,
      sampleRate,
      avgTimePerFrame,
      startFrame,
      source,
      manual,
      automatic,
      label,
    }) {
      const caseDir = path.join(dir, String(++number).padStart(3, "0"));
      fs.mkdirSync(caseDir);
      const temp = path.join(caseDir, "video.mkv"),
        output = path.join(caseDir, "output.mkv");
      fs.copyFileSync(video, temp);
      const notes = [];
      const job = {
        avi,
        pmm,
        temp,
        output,
        frames: 30,
        avgTimePerFrame,
        startFrame,
      };
      const config = {
        settings,
        engines,
        audioShiftFrames: manual,
        audioAutoShift: automatic,
        rangeSuffix: false,
      };
      const result = await mx.finish(job, config, (_line, data) => {
        if (data) notes.push(data);
      });
      assert.equal(result.audio, source, label);
      const count = Math.round(
        ((30 * mx.frameRate(avgTimePerFrame).den) /
          mx.frameRate(avgTimePerFrame).num) *
          sampleRate,
      );
      const decoded = run(ff, [
        "-v",
        "error",
        "-i",
        result.output,
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-c:a",
        "pcm_s16le",
        "pipe:1",
      ]);
      assertPcm(
        decoded,
        expectedPcm(
          pcm,
          sampleRate,
          30,
          startFrame,
          source === "wav",
          manual,
          automatic,
          count,
        ),
        label,
      );
      const videoFrames = Number(
        run(
          fp,
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
            result.output,
          ],
          { encoding: "utf8" },
        ).trim(),
      );
      assert.equal(videoFrames, 30, label + " video frames");
      const shift = notes.find((n) => n.code === "MMD_AUDIO_SHIFT");
      const actual = manual + (automatic && startFrame === 1 ? 1 : 0);
      assert.equal(
        shift.params.frames,
        (actual >= 0 ? "+" : "") + actual,
        label + " log",
      );
      assert.equal(shift.params.manual, (manual >= 0 ? "+" : "") + manual);
      assert.ok(!fs.existsSync(temp));
      results.push({
        label,
        source,
        manual,
        automatic,
        startFrame,
        sampleRate,
        avgTimePerFrame,
        samples: decoded.length / 2,
        videoFrames,
        shift,
      });
      return result;
    }
    for (const [rate, avgTimePerFrame] of [
      ["30", 333333],
      ["30000/1001", 333667],
    ]) {
      const video = path.join(dir, `video-${avgTimePerFrame}.mkv`),
        silentAvi = path.join(dir, `video-${avgTimePerFrame}.avi`);
      run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=black:s=16x16:r=${rate}`,
        "-frames:v",
        "30",
        "-c:v",
        "ffv1",
        video,
      ]);
      run(ff, ["-v", "error", "-i", video, "-c:v", "copy", silentAvi]);
      for (const sampleRate of [44100, 48000]) {
        const music = path.join(
            dir,
            `music-${sampleRate}-${avgTimePerFrame}.wav`,
          ),
          pmm = path.join(dir, `project-${sampleRate}-${avgTimePerFrame}.pmm`);
        const pcm = wav(music, sampleRate, sampleRate * 2);
        fs.writeFileSync(
          pmm,
          Buffer.concat([
            Buffer.from("Polygon Movie maker 0002\0"),
            Buffer.from(music),
            Buffer.from([0]),
          ]),
        );
        const withAudio = path.join(
          dir,
          `audio-${sampleRate}-${avgTimePerFrame}.avi`,
        );
        run(ff, [
          "-v",
          "error",
          "-i",
          video,
          "-i",
          music,
          "-c:v",
          "copy",
          "-c:a",
          "pcm_s16le",
          withAudio,
        ]);
        for (const source of ["avi", "wav"])
          for (const manual of [0, 1, -2])
            for (const automatic of [false, true])
              for (const startFrame of [0, 1]) {
                await check({
                  video,
                  avi: source === "avi" ? withAudio : silentAvi,
                  pmm,
                  pcm,
                  sampleRate,
                  avgTimePerFrame,
                  source,
                  manual,
                  automatic,
                  startFrame,
                  label: `${source}/${sampleRate}/${rate}/${manual}/${automatic}/${startFrame}`,
                });
              }
        if (rate === "30" && sampleRate === 48000) {
          for (const [manual, startFrame] of [
            [45, 0],
            [-90, 0],
            [0, 90],
          ])
            await check({
              video,
              avi: silentAvi,
              pmm,
              pcm,
              sampleRate,
              avgTimePerFrame,
              source: "wav",
              manual,
              automatic: false,
              startFrame,
              label: `boundary/${manual}/${startFrame}`,
            });
          const plan = mx.plan(
            {
              avi: silentAvi,
              width: 16,
              height: 16,
              bits: 32,
              avgTimePerFrame,
              pmm,
              startFrame: 1,
            },
            {
              settings,
              engines,
              maskMode: "off",
              followMmd: true,
              audioShiftFrames: 1,
              audioAutoShift: true,
              presetName: "User 预设",
            },
          );
          const snapshotFile = mx.snapshotPath(plan.temp);
          const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
          assert.equal(snapshot.audioShiftFrames, 1);
          assert.equal(snapshot.audioAutoShift, true);
          fs.copyFileSync(video, plan.temp);
          fs.writeFileSync(
            snapshotFile,
            JSON.stringify({ ...snapshot, mmdPid: 0 }),
          );
          mx.writeSelection({
            presetId: "later",
            audioShiftFrames: -2,
            audioAutoShift: false,
          });
          const notes = [];
          const recovered = await mx.recover(
            path.basename(snapshotFile, ".json"),
            (_line, data) => {
              if (data) notes.push(data);
            },
          );
          const decoded = run(ff, [
            "-v",
            "error",
            "-i",
            recovered.output,
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "pipe:1",
          ]);
          assertPcm(
            decoded,
            expectedPcm(pcm, sampleRate, 30, 1, true, 1, true, sampleRate),
            "recovery frozen +2",
          );
          assert.equal(
            notes.find((n) => n.code === "MMD_AUDIO_SHIFT").params.frames,
            "+2",
          );
          results.push({
            label: "recovery frozen +2",
            samples: decoded.length / 2,
          });
        }
      }
    }
    fs.writeFileSync(
      path.join(dir, "results.json"),
      JSON.stringify({ passed: true, cases: results.length, results }, null, 2),
    );
    console.log("MMD audio exact PCM PASS", dir);
  },
);
