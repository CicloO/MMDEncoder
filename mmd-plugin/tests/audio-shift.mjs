// Real native controls and real DMO -> helper -> sample-exact audio output.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pseudoCatalog } from "../../tests/fixtures/i18n/pseudo.mjs";
const require = createRequire(import.meta.url);
const actualLocal = process.env.LOCALAPPDATA;
const { ff, fp } = require("../../tests/engines.cjs");
process.env.LOCALAPPDATA = actualLocal;
const root = path.resolve(import.meta.dirname, "../..");
const mx = require("../../backend/mmd-export.cjs"),
  core = require("../../backend/core.cjs");
const source = require("../../locales/zh-CN.json"),
  pseudo = pseudoCatalog(source);
for (const name of ["MMDEncoder.exe", "MikuMikuDance.exe"])
  assert.ok(
    !execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    }).includes(name),
    `Close ${name} first`,
  );
const dir = fs.mkdtempSync(
  path.join(root, "verification/i18n/native-audio-shift-"),
);
const build = path.join(root, "mmd-plugin/build"),
  dll = path.join(build, "MMDEncoderPlugin.dll");
const files = [mx.configPath(), mx.selectionPath(), mx.historyPath()];
fs.mkdirSync(path.join(dir, "shared-before"));
const originals = files.map((file) => {
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (bytes !== null)
    fs.writeFileSync(
      path.join(dir, "shared-before", path.basename(file)),
      bytes,
    );
  return bytes;
});
const pending = path.join(path.dirname(mx.configPath()), "pending");
const previousPending = new Set(
  fs.existsSync(pending) ? fs.readdirSync(pending) : [],
);
const logsDir = path.join(path.dirname(mx.configPath()), "logs");
const capture = path.join(dir, "test-choices.jsonl"),
  helper = path.join(dir, "helper.cjs");
fs.writeFileSync(
  helper,
  `const fs=require('node:fs'),mx=require(${JSON.stringify(path.join(root, "backend/mmd-export.cjs"))});if(process.env.MMD_EXPORT_MODE==='test')fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({selection:JSON.parse(process.env.MMD_EXPORT_JOB).selection,stored:mx.readSelection()})+String.fromCharCode(10));require(${JSON.stringify(path.join(root, "backend/mmd-cli.cjs"))}).main(mx);`,
);
const settings = {
  ...core.BUILTINS.find((p) => p.id === "builtin-1080-sw").settings,
  container: "mkv",
  preset: "ultrafast",
  audio: "pcm_s16le",
  audioFade: 0,
  hiRes: false,
};
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, {
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 16 << 20,
    ...options,
  });
const checks = [],
  results = [];
function configure(locale = "zh-CN") {
  mx.writeConfig({
    settings,
    presetId: "audio-shift",
    presetName: "User 音频预设",
    engines: { ffmpeg: ff, ffprobe: fp },
    appExe: process.execPath,
    helper,
    locale,
    catalogs: { "zh-CN": source, "en-XA": pseudo },
  });
}
function dialog(
  name,
  { shift, automatic, save = false, invalid, catalog = source } = {},
) {
  const before = fs.readFileSync(mx.selectionPath());
  const out = run(
    path.join(build, "mmd-sim.exe"),
    ["--dialog-test", dll, "0", save ? "save" : "cancel"],
    {
      encoding: "utf8",
      timeout: 100000,
      env: {
        ...process.env,
        MMD_SIM_SCREENSHOT: path.join(dir, name + ".bmp"),
        ...(shift !== undefined
          ? {
              MMD_SIM_AUDIO_SHIFT: String(shift),
              MMD_SIM_AUDIO_AUTO: automatic ? "1" : "0",
            }
          : {}),
        ...(invalid !== undefined
          ? {
              MMD_SIM_AUDIO_INVALID: invalid,
              MMD_SIM_VALIDATION_TEXT: catalog["error.MMD_AUDIO_SHIFT_INVALID"],
            }
          : {}),
      },
    },
  );
  fs.writeFileSync(path.join(dir, name + ".log"), out);
  assert.match(out, /layoutFits=1/);
  assert.doesNotMatch(out, /unexpected/);
  if (invalid !== undefined) assert.match(out, /validationRejected=1/);
  else {
    assert.match(out, /testResult=.*✓/);
    if (shift !== undefined) {
      assert.match(out, /manualRewrite=0/);
      assert.ok(
        out.includes(
          `chosenShift=${shift} chosenAutoShift=${automatic ? 1 : 0}`,
        ),
        out,
      );
      const tested = fs
        .readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .at(-1);
      assert.equal(tested.selection.audioShiftFrames, shift);
      assert.equal(tested.selection.audioAutoShift, automatic);
      assert.deepEqual(tested.stored, JSON.parse(before));
    }
  }
  if (!save) assert.deepEqual(fs.readFileSync(mx.selectionPath()), before);
  checks.push(name);
  return out;
}
try {
  configure();
  assert.match(dialog("source-defaults"), /initialShift=0 initialAutoShift=1/);
  dialog("source-cancel", { shift: 1, automatic: false });
  dialog("source-save", { shift: -2, automatic: false, save: true });
  assert.equal(mx.readSelection().audioShiftFrames, -2);
  assert.equal(mx.readSelection().audioAutoShift, false);
  assert.match(dialog("source-reopen"), /initialShift=-2 initialAutoShift=0/);
  dialog("fraction-rejected", { invalid: "1.5" });
  dialog("whitespace-rejected", { invalid: " " });
  configure("en-XA");
  dialog("pseudo-cancel", { shift: 1, automatic: true, catalog: pseudo });
  dialog("pseudo-save", {
    shift: 1,
    automatic: true,
    save: true,
    catalog: pseudo,
  });
  assert.equal(mx.readSelection().audioShiftFrames, 1);
  assert.equal(mx.readSelection().audioAutoShift, true);
  configure();
  const sampleRate = 48000,
    pcm = Buffer.alloc(sampleRate * 2 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(((i * 127) % 30000) + 1, i * 2);
  const music = path.join(dir, "music.wav"),
    pmm = path.join(dir, "project.pmm");
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
      music,
    ],
    { input: pcm },
  );
  fs.writeFileSync(
    pmm,
    Buffer.concat([
      Buffer.from("Polygon Movie maker 0002\0"),
      Buffer.from(music),
      Buffer.from([0]),
    ]),
  );
  const template = path.join(dir, "template.avi"),
    withAudio = path.join(dir, "template-audio.avi");
  run(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=16x16:r=30:d=1",
    "-c:v",
    "ffv1",
    template,
  ]);
  run(ff, [
    "-v",
    "error",
    "-i",
    template,
    "-i",
    music,
    "-c:v",
    "copy",
    "-c:a",
    "pcm_s16le",
    withAudio,
  ]);
  for (const file of [template, withAudio]) {
    const bytes = fs.readFileSync(file);
    for (
      let at = bytes.indexOf("FFV1");
      at >= 0 && at < 4096;
      at = bytes.indexOf("FFV1", at + 4)
    )
      bytes.write("MMDE", at, "latin1");
    fs.writeFileSync(file, bytes);
  }
  for (const kind of ["avi", "wav"])
    for (const shift of [0, 1, -2])
      for (const automatic of [false, true])
        for (const startFrame of [0, 1]) {
          const label = `${kind}-${shift}-${automatic}-${startFrame}`,
            avi = path.join(dir, label + ".avi");
          const selected = mx.writeSelection({
            presetId: "audio-shift",
            followMmd: true,
            rangeSuffix: false,
            maskMode: "off",
            audioShiftFrames: shift,
            audioAutoShift: automatic,
          });
          const beforeLogs = new Set(
            fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [],
          );
          const native = run(
            path.join(build, "mmd-sim.exe"),
            [
              dll,
              kind === "avi" ? withAudio : template,
              avi,
              pmm,
              "64",
              "48",
              "30",
              String(startFrame),
              String(startFrame + 29),
            ],
            { encoding: "utf8", timeout: 30000 },
          );
          assert.match(native, /frames=30 placeholders=30/);
          let entry;
          const end = Date.now() + 60000;
          while (!entry && Date.now() < end) {
            const records = fs.existsSync(mx.historyPath())
              ? fs
                  .readFileSync(mx.historyPath(), "utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map(JSON.parse)
              : [];
            entry = records.find(
              (record) =>
                record.avi === avi ||
                record.output === path.join(dir, label + ".mkv"),
            );
            if (!entry) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(entry, label + " finish history");
          assert.equal(entry.ok, true, JSON.stringify(entry));
          assert.equal(entry.audio, kind);
          assert.equal(entry.frames, 30);
          assert.equal(
            fs.existsSync(avi),
            false,
            label + " placeholder cleanup",
          );
          const decoded = run(ff, [
            "-v",
            "error",
            "-i",
            entry.output,
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "pipe:1",
          ]);
          const effective = shift + (automatic && startFrame === 1 ? 1 : 0),
            samples = (effective * sampleRate) / 30;
          const origin = kind === "wav" ? (startFrame * sampleRate) / 30 : 0;
          const expected = Buffer.alloc(sampleRate * 2);
          for (let i = 0; i < sampleRate; i++) {
            const sourceSample = origin + i - samples;
            if (
              i >= Math.max(0, samples) &&
              sourceSample >= origin &&
              sourceSample < pcm.length / 2
            )
              expected.writeInt16LE(pcm.readInt16LE(sourceSample * 2), i * 2);
          }
          assert.equal(decoded.length, expected.length, label + " samples");
          if (!decoded.equals(expected)) {
            let at = 0;
            while (decoded.readInt16LE(at * 2) === expected.readInt16LE(at * 2))
              at++;
            assert.fail(
              `${label} sample ${at}: ${decoded.readInt16LE(at * 2)} != ${expected.readInt16LE(at * 2)}`,
            );
          }
          assert.deepEqual(mx.readSelection(), selected);
          const data = entry.notesData.find(
            (note) => note.code === "MMD_AUDIO_SHIFT",
          );
          assert.equal(
            data.params.frames,
            (effective >= 0 ? "+" : "") + effective,
          );
          const nativeLog = fs
            .readdirSync(logsDir)
            .filter(
              (name) => !beforeLogs.has(name) && !name.endsWith("-ffmpeg.log"),
            )
            .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
            .join("\n");
          assert.ok(
            nativeLog.includes(data.message),
            label + " actual plugin log",
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
                entry.output,
              ],
              { encoding: "utf8" },
            ).trim(),
          );
          assert.equal(videoFrames, 30);
          results.push({
            label,
            effective,
            samples: decoded.length / 2,
            videoFrames,
            note: data,
          });
        }
} finally {
  files.forEach((file, i) =>
    originals[i] === null
      ? fs.rmSync(file, { force: true })
      : fs.writeFileSync(file, originals[i]),
  );
  files.forEach((file, i) =>
    assert.deepEqual(
      fs.existsSync(file) ? fs.readFileSync(file) : null,
      originals[i],
    ),
  );
  if (fs.existsSync(pending))
    for (const name of fs.readdirSync(pending)) {
      if (previousPending.has(name)) continue;
      const file = path.join(pending, name),
        value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        value.avi &&
        path.dirname(path.resolve(value.avi)).toLowerCase() ===
          dir.toLowerCase()
      )
        fs.rmSync(file);
    }
}
fs.writeFileSync(
  path.join(dir, "results.json"),
  JSON.stringify(
    {
      passed: true,
      sharedRestored: true,
      controls: checks,
      cases: results.length,
      results,
    },
    null,
    2,
  ),
);
console.log("Native audio shift PASS", dir);
