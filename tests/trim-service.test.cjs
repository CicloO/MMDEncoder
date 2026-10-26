const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ff, fp } = require("./engines.cjs");
const trim = require("../backend/trim.cjs");

async function until(f, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("等待超时");
}
const frames = async (file) =>
  Number(
    (
      await trim.run(fp, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_packets",
        "-show_entries",
        "stream=nb_read_packets",
        "-of",
        "csv=p=0",
        file,
      ])
    ).stdout,
  );

test(
  "trim page: add, snap, preview, another range of the same file, export, refuse mismatched files, cancel",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-svc-"));
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const st = () => svc.getState().trim;
    try {
      const h264 = path.join(dir, "舞台 A.mp4"),
        prores = path.join(dir, "p.mov"),
        long = path.join(dir, "long.mov");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=4",
        "-c:v",
        "libx264",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        h264,
      ]);
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-c:v",
        "prores_ks",
        prores,
      ]);
      await until(() => svc.getState().located && !svc.getState().detecting);
      await svc.invoke("trimAdd", { paths: [h264] });
      let [clip] = st().clips;
      assert.equal(clip.status, "ready", clip.error);
      assert.deepEqual(clip.cuts, [0, 30, 60, 90]);
      assert.deepEqual([clip.from, clip.to, clip.frames], [0, 120, 120]);

      // Snapping: 44 → 30, 100 → 90.
      await svc.invoke("trimSet", { id: clip.id, from: 44, to: 100 });
      clip = st().clips[0];
      assert.deepEqual([clip.from, clip.to, clip.requested.from], [30, 90, 44]);
      const jpeg = await svc.invoke("trimFrame", { id: clip.id, frame: 45 });
      assert.match(jpeg, /^data:image\/jpeg;base64,\/9j\//);
      // Seen again: served from the preview cache, same picture.
      assert.equal(
        await svc.invoke("trimFrame", { id: clip.id, frame: 45 }),
        jpeg,
      );

      // Another range of the same file, then the end.
      await svc.invoke("trimDuplicate", { id: clip.id });
      const second = st().clips[1];
      await svc.invoke("trimSet", { id: second.id, from: 90, to: "end" });
      await svc.invoke("trimExport", {
        audio: { mode: "reencode", codec: "aac" },
        location: "encoded",
      });
      await until(() => !st().running);
      assert.equal(st().error, "");
      assert.equal(st().errorData, null);
      assert.equal(st().stage.stage, "trim_completed");
      const out = st().output;
      assert.equal(out, path.join(dir, "Encoded", "舞台 A_trimmed.mp4"));
      assert.equal(await frames(out), 60 + 30);

      // A second export never overwrites.
      await svc.invoke("trimExport", {
        audio: { mode: "none" },
        location: "encoded",
      });
      await until(() => !st().running);
      assert.equal(
        st().output,
        path.join(dir, "Encoded", "舞台 A_trimmed (2).mp4"),
      );

      // ProRes joined to H.264: refused with a reason, nothing written.
      await svc.invoke("trimAdd", { paths: [prores] });
      await assert.rejects(
        svc.invoke("trimExport", {
          audio: { mode: "none" },
          location: "source",
        }),
        (e) => {
          assert.equal(e.code, "TRIM_JOIN_MISMATCH");
          assert.match(e.message, /不能无损拼接：.*编码/);
          assert.equal(typeof e.params.differences[0].key, "string");
          return true;
        },
      );

      // Cancel a running export: no output is left behind.
      await svc.invoke("trimClear");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1920x1080:r=30:d=40",
        "-c:v",
        "prores_ks",
        "-profile:v",
        "4",
        long,
      ]);
      await svc.invoke("trimAdd", { paths: [long] });
      await svc.invoke("trimExport", {
        audio: { mode: "none" },
        location: "source",
      });
      await svc.invoke("trimCancel");
      await until(() => !st().running);
      assert.equal(st().stage.stage, "trim_cancelled");
      assert.equal(st().output, "");
      assert.equal(fs.existsSync(path.join(dir, "long_trimmed.mov")), false);
      assert.deepEqual(
        fs.readdirSync(dir).filter((n) => n.startsWith(".mmd-trim-")),
        [],
        "temporary folder removed",
      );
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "trim page smart cut: exact ranges while on, snapped again when off, exact frame count on export",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const core = require("../backend/core.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-smart-svc-"));
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const st = () => svc.getState().trim;
    try {
      const src = path.join(dir, "src.mkv"),
        file = path.join(dir, "片段_0400-0599f.mp4");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-c:v",
        "ffv1",
        src,
      ]);
      const meta = core.metadata(
        JSON.parse(
          (
            await trim.run(fp, [
              "-v",
              "error",
              "-show_streams",
              "-show_format",
              "-of",
              "json",
              src,
            ])
          ).stdout,
        ),
      );
      const [cmd] = core.buildCommands(
        { path: src, meta },
        {
          ...core.DEFAULTS,
          encoder: "libx264",
          preset: "medium",
          container: "mp4",
          audio: "none",
          editFriendly: true,
        },
        { ffmpeg: ff, ffprobe: fp },
        { output: file, tag: { mmd: { start: 400 } } },
      );
      await trim.run(
        cmd.exe,
        cmd.args.filter(
          (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
        ),
      );
      await until(() => svc.getState().located && !svc.getState().detecting);
      await svc.invoke("trimAdd", { paths: [file] });
      let [clip] = st().clips;
      assert.equal(clip.smartBlocker, null);
      assert.deepEqual([clip.mmdStart, clip.mmdStartFrom], [400, "tag"]);
      await svc.invoke("trimSmart", { smart: true });
      await svc.invoke("trimSet", { id: clip.id, from: 44, to: 101 });
      clip = st().clips[0];
      assert.deepEqual([clip.from, clip.to], [44, 101]);
      await svc.invoke("trimExport", {
        audio: { mode: "none" },
        location: "source",
      });
      await until(() => !st().running);
      assert.equal(st().error, "");
      assert.equal(await frames(st().output), 57);
      // Off again: the same request snaps to cut points.
      await svc.invoke("trimSmart", { smart: false });
      clip = st().clips[0];
      assert.deepEqual([clip.from, clip.to], [30, 90]);
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "trim export counts as busy, stops on dispose; removing clips stops indexing and drops cached copies",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-life-"));
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const st = () => svc.getState().trim;
    let disposed = false;
    try {
      const mkv = path.join(dir, "a.mkv"),
        long = path.join(dir, "long.mov");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-c:v",
        "libx264",
        "-g",
        "30",
        mkv,
      ]);
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1920x1080:r=30:d=40",
        "-c:v",
        "prores_ks",
        "-profile:v",
        "4",
        long,
      ]);
      await until(() => svc.getState().located && !svc.getState().detecting);

      // H.264 in MKV is indexed through a cached MP4 copy, removed with the
      // last clip that uses the file.
      const s = fs.statSync(mkv);
      const cached = path.join(
        os.tmpdir(),
        "mmdencoder-trim-cache",
        require("node:crypto")
          .createHash("sha1")
          .update(`${path.resolve(mkv).toLowerCase()}|${s.size}|${s.mtimeMs}`)
          .digest("hex")
          .slice(0, 16) + ".mp4",
      );
      await svc.invoke("trimAdd", { paths: [mkv] });
      assert.equal(st().clips[0].status, "ready", st().clips[0].error);
      assert.ok(fs.existsSync(cached));
      await svc.invoke("trimDuplicate", { id: st().clips[0].id });
      await svc.invoke("trimRemove", { id: st().clips[0].id });
      assert.ok(fs.existsSync(cached), "still used by the other clip");
      await svc.invoke("trimRemove", { id: st().clips[0].id });
      await until(() => !fs.existsSync(cached), 5000);

      // Removed while indexing: the clip does not come back.
      const adding = svc.invoke("trimAdd", { paths: [long] });
      await until(() => st().clips.length === 1);
      await svc.invoke("trimRemove", { id: st().clips[0].id });
      await adding;
      assert.deepEqual(st().clips, []);

      // A running export blocks detection, tool changes and other queues.
      await svc.invoke("trimAdd", { paths: [long] });
      await svc.invoke("trimExport", {
        audio: { mode: "none" },
        location: "source",
      });
      assert.equal(st().running, true);
      await assert.rejects(svc.invoke("detect"), /无损剪辑/);
      await assert.rejects(svc.invoke("checkTools"), /./);
      await assert.rejects(svc.invoke("mediaStart", {}), /./);
      // Closing the app stops it and leaves no output.
      svc.dispose();
      disposed = true;
      await until(() => !st().running);
      assert.equal(st().stage.stage, "trim_cancelled");
      assert.equal(fs.existsSync(path.join(dir, "long_trimmed.mov")), false);
    } finally {
      if (!disposed) svc.dispose();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
