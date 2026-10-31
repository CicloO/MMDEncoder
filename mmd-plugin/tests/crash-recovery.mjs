import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const actualLocal = process.env.LOCALAPPDATA;
const { ff, fp, nv } = require("../../tests/engines.cjs");
process.env.LOCALAPPDATA = actualLocal;
// This DLL uses the Windows Known Folder; guard, back up and restore it.
for (const image of ["MMDEncoder.exe", "MikuMikuDance.exe", "mmd-sim.exe"]) {
  const list = execFileSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${image}`, "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.ok(
    !list.includes(image),
    `Close ${image} before crash-recovery acceptance`,
  );
}
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/plugin-crash-"));
const pluginDir = path.join(actualLocal, "MMDEncoder/mmd-plugin");
const pending = path.join(pluginDir, "pending");
const originals = new Map();
for (const name of ["mmd-export.json", "mmd-selection.json", "exports.jsonl"]) {
  const file = path.join(pluginDir, name);
  originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
}
if (fs.existsSync(pending))
  for (const name of fs.readdirSync(pending)) {
    if (name.endsWith(".json")) {
      const file = path.join(pending, name);
      originals.set(file, fs.readFileSync(file));
    }
  }
fs.mkdirSync(path.join(dir, "backup"));
for (const [file, bytes] of originals)
  if (bytes)
    fs.writeFileSync(path.join(dir, "backup", path.basename(file)), bytes);
const core = require("../../backend/core.cjs");
const mxPath = require.resolve("../../backend/mmd-export.cjs");
let mx = require(mxPath),
  sim;
const run = (exe, args) =>
  execFileSync(exe, args, {
    windowsHide: true,
    maxBuffer: 64 << 20,
    stdio: "pipe",
  });
const probe = (file) =>
  JSON.parse(
    run(fp, [
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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, message, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error(message);
    await new Promise((r) => setTimeout(r, 20));
  }
}
function descendants(parent) {
  const rows = JSON.parse(
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ]).toString(),
  );
  const found = new Set([parent]);
  for (let more = true; more;) {
    more = false;
    for (const row of rows)
      if (found.has(row.ParentProcessId) && !found.has(row.ProcessId)) {
        found.add(row.ProcessId);
        more = true;
      }
  }
  return rows.filter(
    (row) => found.has(row.ProcessId) && row.ProcessId !== parent,
  );
}
const records = [];
try {
  const wav = path.join(dir, "music.wav"),
    pmm = path.join(dir, "scene.pmm"),
    template = path.join(dir, "template.avi");
  run(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.4*sin(2*PI*(220*t+17*t*t)):s=48000:d=12",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  fs.writeFileSync(
    pmm,
    Buffer.concat([
      Buffer.from("Polygon Movie maker 0002\0\0\0\0", "latin1"),
      Buffer.from(wav + "\0\0\0\0", "latin1"),
    ]),
  );
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
  const bytes = fs.readFileSync(template);
  for (
    let i = bytes.indexOf("FFV1");
    i >= 0 && i < 4096;
    i = bytes.indexOf("FFV1", i + 4)
  )
    bytes.write("MMDE", i, "latin1");
  fs.writeFileSync(template, bytes);
  for (const [name, encoder, container, audio] of [
    ["cpu-mp4", "libx264", "mp4", "aac"],
    ["nvenc-mov", "nvencc:h264", "mov", "pcm_s16le"],
  ]) {
    const avi = path.join(dir, name + ".avi");
    mx.writeConfig({
      settings: {
        ...core.DEFAULTS,
        encoder,
        preset: encoder.startsWith("nvencc:") ? "p4" : "medium",
        container,
        audio,
        audioBitrate: 320,
      },
      presetId: "crash-test",
      presetName: name,
      maskMode: "off",
      rangeSuffix: false,
      engines: { ffmpeg: ff, ffprobe: fp, nvencc: nv },
      appExe: process.execPath,
      helper: path.join(root, "backend/mmd-export.cjs"),
    });
    sim = spawn(
      path.join(root, "mmd-plugin/build/mmd-sim.exe"),
      [
        path.join(root, "mmd-plugin/build/MMDEncoderPlugin.dll"),
        template,
        avi,
        pmm,
        "640",
        "360",
        "30",
        "60",
        "119",
        "--pause-after",
        "30",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let log = "";
    sim.stdout.on("data", (b) => (log += b));
    sim.stderr.on("data", (b) => (log += b));
    const ended = new Promise((resolve, reject) => {
      sim.on("error", reject);
      sim.on("exit", resolve);
    });
    await until(
      () => log.includes("paused frames=30"),
      "Simulator did not reach pause: " + log,
      30000,
    );
    const processRows = descendants(sim.pid);
    const pids = processRows.map((row) => row.ProcessId);
    assert.equal(
      processRows.filter(
        (row) => !["conhost.exe", "OpenConsole.exe"].includes(row.Name),
      ).length,
      encoder.startsWith("nvencc:") ? 4 : 1,
      JSON.stringify(processRows),
    );
    const simPid = sim.pid;
    sim.kill();
    await ended;
    sim = null;
    await until(
      () => pids.every((pid) => !alive(pid)),
      "Encoder chain did not drain EOF: " + pids,
    );
    // Reload the backend as on application restart, not a fabricated file.
    delete require.cache[mxPath];
    mx = require(mxPath);
    const item = mx
      .interrupted()
      .find((item) => item.output.startsWith(path.join(dir, name)));
    assert.ok(item, "Interrupted export missing: " + name);
    const snap = JSON.parse(
      fs.readFileSync(path.join(pending, item.id + ".json"), "utf8"),
    );
    assert.equal(snap.mmdPid, simPid);
    const hidden = probe(item.temp);
    assert.equal(hidden.streams[0].nb_read_frames, "30");
    const videoHash = run(ff, [
      "-v",
      "error",
      "-i",
      item.temp,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-f",
      "hash",
      "-",
    ]).toString();
    const result = await mx.recover(item.id);
    const final = probe(result.output);
    assert.equal(final.streams[0].nb_read_frames, "30");
    assert.equal(
      run(ff, [
        "-v",
        "error",
        "-i",
        result.output,
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-f",
        "hash",
        "-",
      ]).toString(),
      videoHash,
    );
    const sound = run(ff, [
      "-v",
      "error",
      "-i",
      result.output,
      "-map",
      "0:a:0",
      "-f",
      "s16le",
      "-",
    ]);
    const expected = run(ff, [
      "-v",
      "error",
      "-i",
      wav,
      "-af",
      "atrim=start_sample=96000:end_sample=144000,asetpts=PTS-STARTPTS",
      "-f",
      "s16le",
      "-",
    ]);
    assert.ok(sound.length >= expected.length);
    let mse = 0;
    for (let i = 0; i < expected.length; i += 2) {
      const d = sound.readInt16LE(i) - expected.readInt16LE(i);
      mse += d * d;
    }
    const rmse = Math.sqrt(mse / (expected.length / 2));
    if (audio === "pcm_s16le") assert.deepEqual(sound, expected);
    else assert.ok(rmse < 100, "AAC start/sample mismatch RMSE " + rmse);
    assert.ok(!fs.existsSync(item.temp));
    records.push({
      name,
      simPid,
      pids,
      sentFrames: 30,
      hiddenFrames: 30,
      recoveredFrames: 30,
      startSample: 96000,
      audioSamples: expected.length / 2,
      audioRmse: rmse,
      output: result.output,
    });
    fs.writeFileSync(path.join(dir, name + "-sim.log"), log);
    fs.writeFileSync(
      path.join(dir, "results.json"),
      JSON.stringify(records, null, 2),
    );
    console.log(
      "Crash -> EOF -> restart -> recovery PASS",
      name,
      JSON.stringify(records.at(-1)),
    );
  }
} finally {
  sim?.kill();
  // Only test-owned new snapshots are removed. Restore every original byte.
  if (fs.existsSync(pending))
    for (const name of fs.readdirSync(pending)) {
      const file = path.join(pending, name);
      if (!originals.has(file) && name.endsWith(".json")) {
        try {
          const value = JSON.parse(fs.readFileSync(file, "utf8"));
          if (value.avi?.startsWith(dir + path.sep))
            fs.rmSync(file, { force: true });
        } catch {}
      }
    }
  for (const [file, bytes] of originals) {
    if (bytes) fs.writeFileSync(file, bytes);
    else fs.rmSync(file, { force: true });
    if (bytes)
      assert.deepEqual(
        fs.readFileSync(file),
        bytes,
        "Restore mismatch: " + file,
      );
    else
      assert.equal(
        fs.existsSync(file),
        false,
        "Unexpected restored file: " + file,
      );
  }
  console.log(
    "Shared config, selection, history and preexisting snapshots restored; evidence",
    dir,
  );
}
