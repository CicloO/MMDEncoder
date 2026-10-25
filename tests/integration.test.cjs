const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createService } = require("../backend/service.cjs");
const { engineDir, ff } = require("./engines.cjs");
const probe = (f) =>
  JSON.parse(
    execFileSync(
      path.join(engineDir, "ffprobe.exe"),
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        f,
      ],
      { encoding: "utf8" },
    ),
  );
async function until(f) {
  for (let i = 0; i < 600; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("等待状态超时");
}
test(
  "real service: fps, audio, paired alpha, collision, presets persistence and validation",
  { timeout: 120000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-test-"));
    let svc;
    try {
      const input = path.join(dir, "透明 Bob's 片段.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=60:d=1,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a=128",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=400:duration=1",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        input,
      ]);
      svc = createService({ engineDir, dataDir: path.join(dir, "data") });
      // A video can be queued twice; the second copy is removed again here.
      await svc.invoke("add", { paths: [input, input] });
      assert.equal(svc.getState().jobs.length, 2);
      await svc.invoke("remove", { id: svc.getState().jobs[1].id });
      assert.equal(svc.getState().jobs.length, 1);
      assert.equal(svc.getState().jobs[0].meta.hasAlpha, true);
      await svc.invoke("settings", {
        patch: { fps: "30", alphaMask: true, alphaMode: "color" },
      });
      const pre = await svc.invoke("preview", {
        id: svc.getState().jobs[0].id,
      });
      assert.equal(pre.errors.length, 0);
      assert.ok(pre.command.includes("Bob''s"));
      assert.equal(fs.existsSync(path.dirname(pre.output)), false);
      // exFAT removable drives cannot create hard links. Exercise the exclusive
      // copy fallback using the real output files while simulating that FS limit.
      const originalLink = fs.promises.link;
      fs.promises.link = async () => {
        throw Object.assign(new Error("hard links unsupported"), {
          code: "ENOTSUP",
        });
      };
      try {
        await svc.invoke("start");
        await until(() => !svc.getState().running);
      } finally {
        fs.promises.link = originalLink;
      }
      const job = svc.getState().jobs[0];
      assert.equal(job.status, "done", job.log);
      assert.ok(
        fs
          .readFileSync(path.join(dir, "data", "logs", job.id + ".log"), "utf8")
          .includes("ffmpeg"),
      );
      assert.ok(
        fs
          .readFileSync(
            path.join(dir, "data", "logs", "hardware-detection.log"),
            "utf8",
          )
          .includes("ffmpeg"),
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(dir, "data", "queue-checkpoint.json"),
            "utf8",
          ),
        ).jobs[0].status,
        "done",
      );
      const video = probe(job.output).streams.find(
        (x) => x.codec_type === "video",
      );
      const mask = probe(job.maskOutput).streams[0];
      assert.equal(video.avg_frame_rate, "30/1");
      assert.equal(video.nb_read_frames, "30");
      assert.equal(mask.nb_read_frames, "30");
      assert.ok(
        probe(job.output).streams.some((x) => x.codec_type === "audio"),
      );
      await svc.invoke("settings", {
        patch: { outputMode: "custom", outputDir: dir, fps: "60000/1001" },
      });
      await svc.invoke("savePreset", { name: "我的预设" });
      const presets = svc.getState().presets.length;
      await assert.rejects(() =>
        svc.invoke("importPresets", {
          presets: [{ name: "坏", settings: { fps: "0" } }],
        }),
      );
      assert.equal(svc.getState().presets.length, presets);
      svc.dispose();
      svc = createService({ engineDir, dataDir: path.join(dir, "data") });
      assert.equal(svc.getState().settings.outputMode, "custom");
      await svc.invoke("applyPreset", { id: "builtin-4k" });
      assert.equal(svc.getState().settings.outputDir, dir);
      assert.equal(svc.getState().settings.outputMode, "custom");
    } finally {
      svc?.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "detection uses usable hardware frame dimensions",
  { timeout: 120000, skip: !fs.existsSync(ff) },
  async () => {
    let reference = false;
    try {
      execFileSync(
        ff,
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=black:s=640x360:r=30:d=0.1",
          "-c:v",
          "h264_nvenc",
          "-f",
          "null",
          "-",
        ],
        { stdio: "pipe" },
      );
      reference = true;
    } catch {}
    const svc = createService({
      engineDir,
      dataDir: path.join(os.tmpdir(), "mmd-detection-regression"),
    });
    try {
      await svc.invoke("detect");
      if (reference)
        assert.ok(
          svc.getState().engines.some((e) => e.id === "h264_nvenc"),
          "hardware trial must not reject a supported GPU due to tiny frames",
        );
    } finally {
      svc.dispose();
    }
  },
);
test(
  "real NVEncC pipeline, fractional conversion, audio, source retention and non-overwrite",
  { timeout: 180000, skip: !fs.existsSync(ff) },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-nv-"));
    const svc = createService({ engineDir, dataDir: path.join(dir, "data") });
    try {
      await svc.invoke("detect");
      const engine = svc.getState().engines.find((e) => e.id === "nvencc:hevc");
      if (!engine) {
        t.skip("NVEncC HEVC unavailable after real trial");
        return;
      }
      const input = path.join(dir, "source.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=640x360:r=60000/1001:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        input,
      ]);
      await svc.invoke("add", { paths: [input] });
      await svc.invoke("settings", {
        patch: {
          encoder: engine.id,
          container: "mkv",
          audio: "flac",
          fps: "29.97",
          bitDepth: 10,
          quality: 18,
          preset: "p7",
          lookahead: 16,
          lookaheadLevel: 2,
        },
      });
      await svc.invoke("start");
      await until(() => !svc.getState().running);
      const j = svc.getState().jobs[0];
      assert.equal(j.status, "done", j.log);
      const p = probe(j.output);
      assert.equal(p.streams[0].codec_name, "hevc");
      assert.equal(p.streams[0].pix_fmt, "yuv420p10le");
      assert.ok(Math.abs(Number(p.format.duration) - 1) < 0.08);
      assert.equal(p.streams[0].nb_read_frames, "30");
      assert.equal(
        p.streams.find((x) => x.codec_type === "audio").codec_name,
        "flac",
      );
      assert.ok(fs.existsSync(input));
      assert.ok(
        !fs
          .readdirSync(path.dirname(j.output))
          .some((n) => n.startsWith(".mmd-")),
      );
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "30→60, VFR preservation, output collision, invalid tasks and cancellation",
  { timeout: 180000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-flow-"));
    const svc = createService({ engineDir, dataDir: path.join(dir, "data") });
    try {
      await svc.invoke("detect");
      const input = path.join(dir, "clip.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=1",
        "-c:v",
        "ffv1",
        input,
      ]);
      await svc.invoke("add", { paths: [input] });
      await svc.invoke("settings", { patch: { fps: "60" } });
      const prev = await svc.invoke("preview", {
        id: svc.getState().jobs[0].id,
      });
      fs.mkdirSync(path.dirname(prev.output), { recursive: true });
      fs.writeFileSync(prev.output, "DO NOT OVERWRITE");
      await svc.invoke("start");
      await until(() => !svc.getState().running);
      let j = svc.getState().jobs[0];
      assert.equal(j.status, "done", j.log);
      assert.equal(fs.readFileSync(prev.output, "utf8"), "DO NOT OVERWRITE");
      assert.match(j.output, /\(2\)/);
      assert.equal(probe(j.output).streams[0].nb_read_frames, "60");
      assert.equal(probe(j.output).streams.length, 1);
      const vfr = path.join(dir, "vfr.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=1",
        "-vf",
        "select='if(lt(n,15),1,not(mod(n,2)))'",
        "-fps_mode",
        "vfr",
        "-c:v",
        "ffv1",
        vfr,
      ]);
      await svc.invoke("add", { paths: [vfr] });
      assert.equal(
        svc.getState().jobs.at(-1).meta.vfr,
        true,
        "timestamp gaps must identify VFR",
      );
      await svc.invoke("settings", { patch: { fps: "source" } });
      await svc.invoke("start");
      await until(() => !svc.getState().running);
      j = svc.getState().jobs.at(-1);
      assert.equal(j.status, "done", j.log);
      assert.equal(
        probe(j.output).streams[0].nb_read_frames,
        probe(vfr).streams[0].nb_read_frames,
      );
      const large = path.join(dir, "cancel.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=640x360:r=60:d=10",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        large,
      ]);
      await svc.invoke("add", { paths: [large] });
      await svc.invoke("settings", { patch: { preset: "veryslow" } });
      await svc.invoke("start");
      await until(() => svc.getState().jobs.at(-1).status === "encoding");
      await new Promise((r) => setTimeout(r, 100));
      await svc.invoke("cancel");
      await until(() => !svc.getState().running);
      j = svc.getState().jobs.at(-1);
      assert.equal(j.status, "cancelled", j.log);
      assert.equal(j.output, undefined);
      assert.ok(fs.existsSync(large));
      assert.ok(
        !fs
          .readdirSync(path.join(dir, "Encoded"))
          .some((n) => n.startsWith(".mmd-")),
      );
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "mixed alpha batch, partial mask-only retry and software format variants",
  { timeout: 180000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-batch-"));
    let blockMask = true,
      blockedPath;
    const svc = createService({
      engineDir,
      dataDir: path.join(dir, "data"),
      onUpdate: (st) => {
        const j = st.jobs.find(
          // Colour and mask run in one pass ("… + Alpha 遮罩").
          (j) =>
            j.status === "encoding" &&
            [
              "alpha_mask",
              "nvencc_encoding_with_mask",
              "video_encoding_with_mask",
            ].includes(j.stage?.stage),
        );
        if (j && blockMask) {
          blockMask = false;
          // The window receives only committed outputs. The full service
          // keeps this planned path to support a mask-only retry.
          blockedPath = svc
            .getState()
            .jobs.find((full) => full.id === j.id).maskOutput;
          fs.writeFileSync(blockedPath, "KEEP EXTERNAL FILE");
        }
      },
    });
    try {
      await svc.invoke("detect");
      const alpha = path.join(dir, "alpha.mkv"),
        plain = path.join(dir, "plain.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red@0.5:s=160x90:r=30:d=0.5,format=yuva444p",
        "-c:v",
        "ffv1",
        alpha,
      ]);
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=160x90:r=30:d=0.5",
        "-c:v",
        "ffv1",
        plain,
      ]);
      await svc.invoke("add", { paths: [alpha, plain] });
      await svc.invoke("settings", { patch: { alphaMask: true } });
      await svc.invoke("start");
      await until(() => !svc.getState().running);
      let [a, p] = svc.getState().jobs;
      assert.equal(a.status, "partial", a.log);
      assert.ok(fs.existsSync(a.output));
      assert.equal(svc.uiState().jobs[0].output, a.output);
      assert.equal(svc.uiState().jobs[0].maskOutput, undefined);
      assert.equal(fs.readFileSync(blockedPath, "utf8"), "KEEP EXTERNAL FILE");
      assert.equal(p.status, "invalid", p.error);
      const stat = fs.statSync(a.output);
      fs.unlinkSync(blockedPath);
      await svc.invoke("retry", { id: a.id });
      await until(() => !svc.getState().running);
      a = svc.getState().jobs[0];
      assert.equal(a.status, "done", a.log);
      assert.equal(
        fs.statSync(a.output).mtimeMs,
        stat.mtimeMs,
        "mask-only retry must not re-encode main",
      );
      const raw = execFileSync(ff, [
        "-v",
        "error",
        "-i",
        a.maskOutput,
        "-frames:v",
        "1",
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "-",
      ]);
      assert.ok(
        raw.every((v) => v >= 123 && v <= 132),
        "mask keeps middle alpha gray",
      );
      for (const patch of [
        {
          encoder: "libx265",
          bitDepth: 10,
          chroma: "420",
          container: "mkv",
          audio: "flac",
          preset: "ultrafast",
        },
        {
          encoder: "prores_ks",
          bitDepth: 10,
          chroma: "422",
          container: "mov",
          audio: "pcm_s16le",
          preset: "medium",
        },
        {
          encoder: "libvpx-vp9",
          bitDepth: 8,
          chroma: "420",
          container: "webm",
          audio: "libopus",
          preset: "ultrafast",
        },
        {
          encoder: "libsvtav1",
          bitDepth: 10,
          chroma: "420",
          container: "webm",
          audio: "libopus",
          preset: "12",
        },
      ]) {
        await svc.invoke("settings", { patch: { ...patch, alphaMask: false } });
        await svc.invoke("retry", { id: p.id });
        await until(() => !svc.getState().running);
        p = svc.getState().jobs.find((j) => j.id === p.id);
        assert.equal(p.status, "done", p.log);
        const info = probe(p.output).streams[0];
        assert.equal(
          info.codec_name,
          patch.encoder === "libx265"
            ? "hevc"
            : patch.encoder === "prores_ks"
              ? "prores"
              : patch.encoder === "libvpx-vp9"
                ? "vp9"
                : "av1",
        );
        await svc.invoke("remove", { id: p.id });
        await svc.invoke("add", { paths: [plain] });
        p = svc.getState().jobs.at(-1);
        await svc.invoke("settings", { patch: { fps: "0" } });
        await svc.invoke("start");
        await until(() => !svc.getState().running);
        await svc.invoke("settings", { patch: { fps: "source" } });
        p = svc.getState().jobs.at(-1);
      }
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("preset rename changes only preset, duplicate names reject atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-presets-"));
  const svc = createService({ engineDir, dataDir: dir });
  try {
    await svc.invoke("savePreset", { name: "个人 A" });
    const id = svc.getState().presets.at(-1).id;
    const before = svc.getState().settings;
    await svc.invoke("renamePreset", { id, name: "个人 B" });
    assert.deepEqual(svc.getState().settings, before);
    assert.equal(svc.getState().presets.at(-1).name, "个人 B");
    await assert.rejects(
      () => svc.invoke("savePreset", { name: "个人 B" }),
      /同名/,
    );
    await assert.rejects(
      () => svc.invoke("renamePreset", { id, name: "默认 4K · 硬件" }),
      /同名/,
    );
    const count = svc.getState().presets.length;
    await assert.rejects(
      () =>
        svc.invoke("importPresets", {
          presets: [{ name: "个人 B", settings: before }],
        }),
      /同名/,
    );
    assert.equal(svc.getState().presets.length, count);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("built-in presets can be edited, hidden, deleted, reordered and restored across restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-presets-"));
  let svc = createService({ engineDir, dataDir: dir });
  const ids = () => svc.getState().presets.map((p) => p.id);
  const find = (id) => svc.getState().presets.find((p) => p.id === id);
  try {
    // Recommended presets first, then Alpha (split before kept); software
    // variants have no explicit hidden flag.
    assert.deepEqual(ids(), [
      "builtin-4k",
      "builtin-4k-sw",
      "builtin-1080",
      "builtin-1080-sw",
      "builtin-alpha-mask",
      "builtin-alpha",
      "builtin-prores422",
    ]);
    assert.equal(find("builtin-4k-sw").hidden, undefined);
    await svc.invoke("renamePreset", { id: "builtin-4k", name: "油管" });
    await svc.invoke("applyPreset", { id: "builtin-1080" });
    await svc.invoke("settings", { patch: { quality: 31 } });
    await svc.invoke("savePreset", {
      id: "builtin-1080",
      name: "默认 1080p · 硬件",
    });
    await svc.invoke("hidePreset", { id: "builtin-alpha", hidden: true });
    await svc.invoke("hidePreset", { id: "builtin-1080-sw", hidden: false });
    await svc.invoke("deletePreset", { id: "builtin-4k-sw" });
    await svc.invoke("savePreset", { name: "个人" });
    const order = [ids().at(-1), ...ids().slice(0, -1)];
    await svc.invoke("reorderPresets", { ids: order });
    await assert.rejects(
      svc.invoke("reorderPresets", { ids: order.slice(1) }),
      /排序/,
    );
    svc.dispose();

    svc = createService({ engineDir, dataDir: dir });
    assert.deepEqual(ids(), order);
    assert.equal(find("builtin-4k").name, "油管");
    assert.equal(find("builtin-4k").settings.presetName, "油管");
    assert.equal(find("builtin-4k").builtin, true);
    assert.equal(find("builtin-1080").settings.quality, 31);
    assert.equal(find("builtin-1080").edited, true);
    assert.equal(find("builtin-alpha").hidden, true);
    assert.equal(find("builtin-1080-sw").hidden, false);
    assert.equal(find("builtin-4k-sw"), undefined);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.json"), "utf8"),
    );
    assert.ok(saved.presets.every((p) => !p.id.startsWith("builtin-")));

    await svc.invoke("restoreBuiltinPresets");
    assert.equal(find("builtin-4k").name, "默认 4K · 硬件");
    assert.equal(find("builtin-1080").settings.quality, 29);
    assert.equal(find("builtin-alpha").hidden, undefined);
    assert.ok(find("builtin-4k-sw"));
    assert.equal(ids()[0], order[0], "personal preset keeps its place");
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("an update overwrites changed built-ins but keeps every personal preset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-presets-"));
  const file = path.join(dir, "settings.json");
  let svc = createService({ engineDir, dataDir: dir });
  const find = (id) => svc.getState().presets.find((p) => p.id === id);
  try {
    await svc.invoke("renamePreset", { id: "builtin-4k", name: "油管" });
    await svc.invoke("renamePreset", { id: "builtin-alpha", name: "推特" });
    await svc.invoke("savePreset", { name: "我的 MMD" });
    svc.dispose();
    // Simulate a new version: 默认 4K's shipped definition changed, a built-in
    // was dropped, one now shares a personal name, and a personal preset is
    // unreadable under the new rules.
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.builtins["builtin-4k"].base = "older-definition";
    saved.builtins["builtin-gone"] = {
      name: "旧内置",
      settings: saved.presets[0].settings,
      base: "x",
    };
    saved.presets.push(
      { ...saved.presets[0], id: "p2", name: "默认 1080p · 硬件" },
      { id: "p3", name: "坏预设", settings: { encoder: 5 } },
    );
    fs.writeFileSync(file, JSON.stringify(saved));

    svc = createService({ engineDir, dataDir: dir });
    const names = svc.getState().presets.map((p) => p.name);
    assert.equal(find("builtin-4k").name, "默认 4K · 硬件");
    assert.equal(find("builtin-4k").edited, undefined);
    assert.equal(
      find("builtin-alpha").name,
      "推特",
      "unchanged built-in keeps edit",
    );
    assert.ok(!names.includes("旧内置"), "dropped built-in is not kept");
    assert.ok(names.includes("我的 MMD"));
    assert.equal(find("p2").name, "默认 1080p · 硬件");
    assert.equal(find("builtin-1080").name, "默认 1080p · 硬件（内置）");
    assert.match(svc.getState().notice, /坏预设/);
    await svc.invoke("hidePreset", { id: "p2", hidden: true });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(after.presets.some((p) => p.name === "坏预设"));
    assert.equal(after.builtins["builtin-4k"], undefined);
    assert.equal(after.builtins["builtin-gone"], undefined);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "detection result is cached until tools or adapters change, manual detect bypasses cache",
  { timeout: 180000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-detect-cache-"));
    const dataDir = path.join(dir, "data"),
      cacheFile = path.join(dataDir, "engine-cache.json");
    const ready = (svc) =>
      until(() => {
        const s = svc.getState();
        return s.located && !s.detecting && s.engines.length > 0;
      });
    let svc = createService({ engineDir, dataDir });
    try {
      await ready(svc);
      const engines = svc.getState().engines;
      const first = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      assert.deepEqual(first.engines, engines);
      assert.doesNotMatch(await svc.invoke("logs", {}), /的编码器检测结果/);
      svc.dispose();

      svc = createService({ engineDir, dataDir });
      const started = Date.now();
      await ready(svc);
      assert.deepEqual(svc.getState().engines, engines);
      assert.match(await svc.invoke("logs", {}), /的编码器检测结果/);
      assert.ok(Date.now() - started < 10000, "cached startup skips trials");

      await svc.invoke("detect");
      assert.ok(svc.getState().engines.length > 0);
      const forced = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      assert.notEqual(forced.detectedAt, first.detectedAt);
      svc.dispose();

      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ ...forced, key: "stale", detectedAt: "stale" }),
      );
      svc = createService({ engineDir, dataDir });
      await ready(svc);
      assert.doesNotMatch(await svc.invoke("logs", {}), /stale/);
      assert.equal(
        JSON.parse(fs.readFileSync(cacheFile, "utf8")).key,
        forced.key,
      );
    } finally {
      svc.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "finished or cancelled items can be re-exported with current settings without overwriting",
  { timeout: 120000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-requeue-"));
    const svc = createService({ engineDir, dataDir: path.join(dir, "data") });
    try {
      const input = path.join(dir, "片段.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=60:d=1",
        "-c:v",
        "ffv1",
        input,
      ]);
      await svc.invoke("add", { paths: [input] });
      const id = svc.getState().jobs[0].id;
      await assert.rejects(svc.invoke("requeue", { id }), /已完成或已取消/);
      await svc.invoke("start");
      await until(() => svc.getState().jobs[0].status === "done");
      await until(() => !svc.getState().running);
      const first = svc.getState().jobs[0].output;
      assert.ok(fs.existsSync(first));

      await svc.invoke("settings", { patch: { fps: "30" } });
      await svc.invoke("requeue", { id });
      const reset = svc.getState().jobs[0];
      assert.equal(reset.status, "ready");
      assert.equal(reset.output, undefined);
      assert.equal(reset.settings, undefined);

      await svc.invoke("start");
      await until(() => svc.getState().jobs[0].status === "done");
      await until(() => !svc.getState().running);
      const second = svc.getState().jobs[0];
      assert.notEqual(second.output, first);
      assert.ok(fs.existsSync(first) && fs.existsSync(second.output));
      assert.equal(second.settings.fps, "30");
      assert.ok(probe(second.output).streams[0].nb_read_frames <= 31);
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
