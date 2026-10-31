const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ff, fp, engineDir } = require("./engines.cjs");
const { createService } = require("../backend/service.cjs");
const registry = require("../locales/registry.json");
async function until(check) {
  const end = Date.now() + 60000;
  while (!check()) {
    if (Date.now() > end) throw Error("Timed out waiting for encoder state");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test(
  "switching locale during a real encode preserves the frozen settings, command and job, with one complete output",
  { timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-locale-encode-"));
    const input = path.join(dir, "source.mkv");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=60:d=4",
      "-c:v",
      "ffv1",
      input,
    ]);
    const svc = createService({
      dataDir: path.join(dir, "data"),
      engineDir,
      localeRegistry: {
        ...registry,
        locales: [...registry.locales, { id: "en-XA" }],
      },
    });
    try {
      await until(() => svc.getState().located && !svc.getState().detecting);
      await svc.invoke("add", { paths: [input] });
      await svc.invoke("settings", {
        patch: {
          encoder: "libx264",
          container: "mp4",
          preset: "slow",
          quality: 22,
          alphaMode: "discard",
          alphaMask: false,
          audio: "none",
          outputMode: "source",
          fps: "source",
          resizeMode: "source",
        },
      });
      await svc.invoke("start");
      await until(() => svc.getState().jobs[0].status === "encoding");
      const before = svc.getState();
      const command = await svc.invoke("preview", { id: before.jobs[0].id });
      const after = await svc.invoke("setLocale", { locale: "en-XA" });
      assert.equal(after.locale, "en-XA");
      assert.equal(after.running, true);
      assert.equal(after.jobs[0].id, before.jobs[0].id);
      assert.equal(after.jobs[0].status, "encoding");
      assert.deepEqual(after.jobs[0].settings, before.jobs[0].settings);
      for (const key of [
        "settings",
        "presets",
        "enhancements",
        "engineInfo",
        "detecting",
      ])
        assert.deepEqual(after[key], before[key], key);
      assert.equal(
        (await svc.invoke("preview", { id: before.jobs[0].id })).command,
        command.command,
      );
      await until(() => !svc.getState().running);
      const job = svc.getState().jobs[0];
      assert.equal(job.status, "done", job.error);
      const video = JSON.parse(
        execFileSync(
          fp,
          [
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames,width,height",
            "-of",
            "json",
            job.output,
          ],
          { encoding: "utf8" },
        ),
      ).streams[0];
      assert.equal(Number(video.nb_read_frames), 240);
      assert.equal(video.width, 640);
      assert.equal(video.height, 360);
      assert.equal(
        fs.readdirSync(dir).filter((name) => name.endsWith(".mp4")).length,
        1,
      );
    } finally {
      svc.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
