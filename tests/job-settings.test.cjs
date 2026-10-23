const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ff, fp } = require("./engines.cjs");

async function until(f) {
  for (let i = 0; i < 600 && !f(); i++)
    await new Promise((r) => setTimeout(r, 100));
}
const codecOf = (file) =>
  execFileSync(fp, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "csv=p=0",
    file,
  ])
    .toString()
    .trim();

test(
  "单独设置: a video's own settings encode it, the page keeps its own, and switching it off drops them",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-preset-"));
    const inputs = ["a.mp4", "b.mp4"].map((n) => path.join(dir, n));
    for (const input of inputs)
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=1",
        "-c:v",
        "libx264",
        input,
      ]);
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const state = () => svc.getState();
    try {
      await until(() => state().located && !state().detecting);
      await svc.invoke("add", { paths: inputs });
      await until(() => state().jobs.every((j) => j.status !== "probing"));
      await svc.invoke("settings", {
        patch: {
          encoder: "libx264",
          preset: "ultrafast",
          container: "mp4",
          audio: "none",
          outputMode: "source",
          resizeMode: "source",
          fps: "source",
          alphaMode: "discard",
          alphaMask: false,
        },
      });
      const [a, b] = state().jobs;
      await assert.rejects(
        svc.invoke("setJobSettings", { id: b.id, patch: { quality: 20 } }),
        /没有开启单独设置/,
      );
      // 单独设置 on: b starts from the page's settings, then is changed on its own.
      await svc.invoke("setJobSettings", { id: b.id, own: true });
      assert.equal(state().jobs[1].ownSettings.encoder, "libx264");
      await svc.invoke("setJobSettings", {
        id: b.id,
        patch: {
          encoder: "prores_ks",
          container: "mov",
          bitDepth: 10,
          chroma: "422",
          quality: 12,
        },
      });
      await assert.rejects(
        svc.invoke("setJobSettings", { id: b.id, patch: { bogus: 1 } }),
        /无效设置字段/,
      );
      // The page's settings are untouched.
      assert.equal(state().settings.encoder, "libx264");
      assert.match(
        (await svc.invoke("preview", { id: b.id })).summary,
        /ProRes/,
      );
      assert.match(
        (await svc.invoke("preview", { id: a.id })).summary,
        /H.264/,
      );
      // Off drops b's own settings: they are not kept for next time.
      await svc.invoke("setJobSettings", { id: b.id, own: false });
      assert.equal(state().jobs[1].ownSettings, undefined);
      assert.match(
        (await svc.invoke("preview", { id: b.id })).summary,
        /H.264/,
      );
      // On again starts from the page, not from the dropped edits.
      await svc.invoke("setJobSettings", { id: b.id, own: true });
      assert.equal(state().jobs[1].ownSettings.encoder, "libx264");
      await svc.invoke("setJobSettings", {
        id: b.id,
        patch: {
          encoder: "prores_ks",
          container: "mov",
          bitDepth: 10,
          chroma: "422",
          quality: 12,
        },
      });
      // A preset saved from b's own settings leaves the page's alone.
      await svc.invoke("savePreset", {
        name: "单独 ProRes",
        settings: state().jobs[1].ownSettings,
      });
      assert.equal(
        state().presets.find((p) => p.name === "单独 ProRes").settings.encoder,
        "prores_ks",
      );
      assert.equal(state().settings.encoder, "libx264");
      await svc.invoke("start");
      await until(() => !state().running);
      const [doneA, doneB] = state().jobs;
      assert.equal(doneA.status, "done", doneA.error);
      assert.equal(doneB.status, "done", doneB.error);
      assert.equal(codecOf(doneA.output), "h264");
      assert.equal(codecOf(doneB.output), "prores");
      assert.equal(path.extname(doneB.output), ".mov");
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
