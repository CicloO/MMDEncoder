const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { align } = require("../backend/align.cjs");
const { ff, fp } = require("./engines.cjs");

async function until(f) {
  for (let i = 0; i < 600 && !f(); i++)
    await new Promise((r) => setTimeout(r, 100));
}
const duration = (f) =>
  Number(
    execFileSync(fp, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      f,
    ]).toString(),
  );

test(
  "音频对齐 on the media page: auto-align in a helper process, then extract the audio cut or padded to match",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-service-"));
    const run = (args) => execFileSync(ff, ["-v", "error", ...args]);
    const song = path.join(dir, "原曲.flac");
    run([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=30:c=pink:r=44100:seed=5,tremolo=f=1.7:d=0.9",
      song,
    ]);
    // An MMD-like render whose sound starts 4.25 s into the song, 12 s long.
    const render = path.join(dir, "渲染.mp4");
    run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=12",
      "-ss",
      "4.25",
      "-t",
      "12",
      "-i",
      song,
      "-af",
      "volume=0.6,aresample=48000",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      render,
    ]);
    // A version of the song that starts 1.5 s late (padding needed).
    const late = path.join(dir, "晚开始.wav");
    run(["-ss", "1.5", "-i", song, late]);
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const jobs = () => svc.getState().mediaJobs;
    try {
      await until(() => svc.getState().located && !svc.getState().detecting);
      await svc.invoke("mediaAdd", { paths: [song, late] });
      await until(() => jobs().every((j) => j.meta || j.metaError));
      const [a, b] = jobs();
      // The dialog's preview: mono 16-bit at 24 kHz.
      const preview = await svc.invoke("alignPreview", { path: song });
      assert.equal(preview.rate, 24000);
      assert.ok(Math.abs(preview.duration - 30) < 0.05);
      assert.ok(preview.pcm instanceof Int16Array);
      const r1 = await svc.invoke("alignRun", {
        reference: render,
        target: song,
      });
      assert.ok(
        r1.reliable && Math.abs(r1.offset - 4.25) < 0.0005,
        JSON.stringify(r1),
      );
      const r2 = await svc.invoke("alignRun", {
        reference: song,
        target: late,
      });
      assert.ok(Math.abs(r2.offset + 1.5) < 0.0005, JSON.stringify(r2));
      await svc.invoke("mediaSetAlign", {
        id: a.id,
        align: { reference: render, offset: r1.offset, trim: true },
      });
      await svc.invoke("mediaSetAlign", {
        id: b.id,
        align: { reference: song, offset: r2.offset, trim: false },
      });
      assert.ok(Math.abs(jobs()[0].align.length - 12) < 0.05);
      assert.equal(jobs()[1].align.length, undefined);
      // A copied track cannot be cut to the sample.
      await svc.invoke("mediaStart", {
        operation: "audio",
        audioFormat: "copy",
        location: "source",
      });
      await until(() => !svc.getState().running);
      assert.equal(jobs()[0].status, "failed");
      assert.match(jobs()[0].error, /对齐需要重新编码/);
      for (const j of jobs()) await svc.invoke("mediaRequeue", { id: j.id });
      await svc.invoke("mediaStart", {
        operation: "audio",
        audioFormat: "flac",
        location: "source",
      });
      await until(() => !svc.getState().running);
      const [doneA, doneB] = jobs();
      assert.equal(doneA.status, "done", doneA.error);
      assert.equal(doneB.status, "done", doneB.error);
      // Cut and trimmed: starts with the render and is as long as it.
      assert.ok(Math.abs(duration(doneA.output) - 12) < 0.02);
      const check = await align({ ffmpeg: ff }, render, doneA.output);
      assert.ok(Math.abs(check.offset) < 0.0005, "cut: " + check.offset);
      // Padded: 1.5 s of silence in front, then the song as before.
      assert.ok(Math.abs(duration(doneB.output) - 30) < 0.02);
      const check2 = await align({ ffmpeg: ff }, song, doneB.output);
      assert.ok(Math.abs(check2.offset) < 0.0005, "padded: " + check2.offset);
      // Clearing it.
      await svc.invoke("mediaSetAlign", { id: doneA.id, align: null });
      assert.equal(jobs()[0].align, undefined);
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
