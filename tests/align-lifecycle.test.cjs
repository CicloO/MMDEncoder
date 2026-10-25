const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const {
  createAlignService,
  CANCELLED,
} = require("../backend/align-service.cjs");
const { decode } = require("../backend/align.cjs");
const { ff } = require("./engines.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-align-life-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
// Noise bursts, so alignment has real work; `minutes` long.
function track(name, minutes) {
  const file = path.join(dir, name);
  execFileSync(ff, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=${minutes * 60}:a=0.3:seed=7,volume='if(lt(mod(t,1.3),0.4),1,0.1)':eval=frame`,
    "-ac",
    "1",
    "-ar",
    "24000",
    "-c:a",
    "flac",
    file,
  ]);
  return file;
}
const service = () =>
  createAlignService({
    engineInfo: () => ({ ffmpeg: ff }),
    locate: async () => {},
  });
// FFmpeg and worker processes whose command line mentions `text`.
function processesWith(text) {
  const out = execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${text}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`,
  ])
    .toString()
    .trim();
  return out ? out.split(/\s+/) : [];
}
const until = async (f, ms = 10000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("the preview is the worker's 16-bit samples, as the old float conversion gave", async () => {
  const file = track("short.flac", 0.2);
  const svc = service();
  const p = await svc.queries.alignPreview({ path: file });
  assert.ok(p.pcm instanceof Int16Array);
  assert.equal(p.rate, 24000);
  const f = await decode(ff, file, 24000);
  assert.equal(p.pcm.length, f.length);
  let worst = 0;
  for (let i = 0; i < f.length; i++)
    worst = Math.max(
      worst,
      Math.abs(p.pcm[i] - Math.max(-1, Math.min(1, f[i])) * 32767),
    );
  assert.ok(worst <= 1.5, `largest difference ${worst}`);
  assert.equal(svc.runningCount(), 0);
});

test("a newer request in the same slot, alignCancel and stopAll end the work and its FFmpeg", async () => {
  const a = track("long-a.flac", 15);
  const b = track("long-b.flac", 15);
  const svc = service();
  // Replaced: the first run of the slot is cancelled, the second completes.
  const first = svc.queries.alignRun({ reference: a, target: b, slot: "run" });
  await until(() => svc.runningCount() === 1);
  const second = svc.queries.alignRun({ reference: a, target: a, slot: "run" });
  await assert.rejects(first, new RegExp(CANCELLED));
  assert.ok(Math.abs((await second).offset) < 0.001);
  // Closed: alignCancel stops the slot's task.
  const third = svc.queries.alignRun({ reference: b, target: a, slot: "run" });
  await until(
    () => processesWith("long-b.flac").length > 0 || svc.runningCount() === 1,
  );
  svc.queries.alignCancel({ slots: ["run"] });
  await assert.rejects(third, new RegExp(CANCELLED));
  // Quit: stopAll ends everything.
  const fourth = svc.queries.alignRun({ reference: b, target: a });
  await until(() => svc.runningCount() === 1);
  svc.stopAll();
  await assert.rejects(fourth, new RegExp(CANCELLED));
  assert.equal(svc.runningCount(), 0);
  await until(() => processesWith("long-").length === 0);
});

test("the worker stops itself and its FFmpeg when the app goes away (stdin closes)", async () => {
  const a = track("orphan.flac", 15);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "backend", "align-worker.cjs")],
    {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MMD_ALIGN_JOB: JSON.stringify({
          mode: "align",
          ffmpeg: ff,
          reference: a,
          target: a,
        }),
      },
    },
  );
  const closed = new Promise((r) => child.on("close", r));
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.end(); // as when the app's process ends
  assert.equal(await closed, 1);
  await until(() => processesWith("orphan.flac").length === 0);
});
