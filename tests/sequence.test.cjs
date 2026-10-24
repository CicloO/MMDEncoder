const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sequence = require("../backend/sequence.cjs");
const { ff, fp } = require("./engines.cjs");

const touch = (dir, names) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
};
const range = (a, b, f) =>
  Array.from({ length: b - a + 1 }, (_, i) => f(a + i));

test("PNG sequences: padded and plain numbering, folders, gaps, single images", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seq-"));
  try {
    // Zero-padded, starting at 1, with an unrelated file around.
    const a = path.join(root, "50% 透明");
    touch(a, [
      ...range(1, 12, (n) => `frame_${String(n).padStart(4, "0")}.png`),
      "cover.png",
    ]);
    const s = await sequence.find(path.join(a, "frame_0007.png"));
    assert.equal(s.first, path.join(a, "frame_0001.png"));
    assert.equal(s.pattern, path.join(a.replace("%", "%%"), "frame_%04d.png"));
    // Size comes afterwards: 12 frames of one byte (cover.png not counted).
    assert.equal(s.size, undefined);
    assert.equal(await sequence.size(s), 12);
    assert.equal(await sequence.size(s, () => false), undefined);
    assert.deepEqual(
      [s.start, s.count, s.missing, s.name],
      [1, 12, null, "frame"],
    );
    // The folder picks its largest sequence.
    assert.equal((await sequence.find(a)).pattern, s.pattern);

    // Plain numbers 0–10, no separator, so the folder names the output.
    const b = path.join(root, "镜头 B");
    touch(
      b,
      range(0, 10, (n) => `${n}.png`),
    );
    const p = await sequence.find(path.join(b, "3.png"));
    assert.deepEqual([p.start, p.count, p.name], [0, 11, "镜头 B"]);
    assert.ok(p.pattern.endsWith(path.sep + "%d.png"));

    // 0998 … 1002: padded names roll over into wider-looking ones.
    const c = path.join(root, "c");
    touch(
      c,
      range(998, 1002, (n) => `cut-${String(n).padStart(4, "0")}.png`),
    );
    assert.equal((await sequence.find(c)).count, 5);

    // A missing frame is reported, since FFmpeg would stop there.
    const d = path.join(root, "d");
    touch(d, ["x_001.png", "x_002.png", "x_004.png"]);
    const g = await sequence.find(d);
    assert.deepEqual([g.count, g.total, g.missing], [2, 3, 3]);
    assert.equal(await sequence.size(g), 2);

    // One numbered image, or none: not a sequence.
    const e = path.join(root, "e");
    touch(e, ["only_0001.png", "logo.png"]);
    assert.equal(await sequence.find(path.join(e, "only_0001.png")), null);
    assert.equal(await sequence.find(path.join(e, "logo.png")), null);
    assert.equal(await sequence.find(e), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function until(f) {
  for (let i = 0; i < 600; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("等待状态超时");
}

test(
  "PNG sequence import: frame rate is set by the user, alpha is kept, frames encode in order",
  { timeout: 120000, skip: !fs.existsSync(ff) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seq-svc-"));
    const frames = path.join(dir, "舞台 渲染");
    fs.mkdirSync(frames);
    // 24 RGBA frames, half transparent.
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=24:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),255,0)'",
      "-start_number",
      "1",
      path.join(frames, "shot_%04d.png"),
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
      // Several frames of one sequence picked at once: added once.
      await svc.invoke("add", {
        paths: [
          path.join(frames, "shot_0003.png"),
          path.join(frames, "shot_0010.png"),
        ],
      });
      await until(() => state().jobs.every((j) => j.status !== "probing"));
      assert.equal(state().jobs.length, 1);
      let [job] = state().jobs;
      assert.equal(job.status, "ready", job.error);
      assert.equal(job.name, "shot（PNG 序列）");
      assert.equal(job.meta.fps, 30, "default rate");
      assert.equal(job.meta.sequence.count, 24);
      assert.equal(job.meta.width, 160);
      assert.ok(job.meta.hasAlpha, "RGBA PNG keeps alpha");
      // The folder itself is the same sequence; adding it again queues it
      // again (a video can be queued twice), here removed again.
      await svc.invoke("add", { paths: [frames] });
      assert.equal(state().jobs.length, 2);
      assert.equal(state().jobs[1].sequence.pattern, job.sequence.pattern);
      await svc.invoke("remove", { id: state().jobs[1].id });
      assert.equal(state().jobs.length, 1);

      await svc.invoke("setSequenceFps", { id: job.id, fps: 24 });
      job = state().jobs[0];
      assert.equal(job.meta.duration, 1);
      await assert.rejects(
        svc.invoke("setSequenceFps", { id: job.id, fps: 7 }),
        /帧率无效/,
      );

      await svc.invoke("settings", {
        patch: {
          encoder: "libx264",
          container: "mp4",
          audio: "none",
          alphaMode: "discard",
          alphaMask: true,
          outputMode: "source",
          nameTemplate: "{name}",
          fps: "source",
          resizeMode: "source",
        },
      });
      await svc.invoke("start");
      await until(() => !state().running);
      job = state().jobs[0];
      assert.equal(job.status, "done", job.log || job.error);
      assert.equal(job.output, path.join(frames, "shot.mp4"));
      const info = JSON.parse(
        execFileSync(
          fp,
          [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-of",
            "json",
            job.output,
          ],
          { encoding: "utf8" },
        ),
      ).streams[0];
      assert.equal(Number(info.nb_read_frames), 24);
      assert.equal(info.r_frame_rate, "24/1");
      assert.ok(
        fs.existsSync(path.join(frames, "shot_alpha.mp4")),
        "mask from the PNG alpha",
      );

      // A gap makes the sequence invalid instead of silently cutting it short.
      fs.rmSync(path.join(frames, "shot_0012.png"));
      await svc.invoke("add", { paths: [path.join(frames, "shot_0001.png")] });
      // Same sequence (already queued): skipped, so use a copy elsewhere.
      const gap = path.join(dir, "gap");
      fs.cpSync(frames, gap, { recursive: true });
      await svc.invoke("add", { paths: [path.join(gap, "shot_0001.png")] });
      await until(() => state().jobs.every((j) => j.status !== "probing"));
      const bad = state().jobs.find((j) => j.path.startsWith(gap));
      assert.equal(bad.status, "invalid");
      assert.match(bad.error, /缺少第 12 帧/);
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a 10,000-frame folder is read without blocking the event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seq-big-"));
  try {
    touch(
      root,
      range(1, 10000, (n) => `big_${String(n).padStart(5, "0")}.png`),
    );
    let longest = 0,
      last = Date.now();
    const timer = setInterval(() => {
      longest = Math.max(longest, Date.now() - last);
      last = Date.now();
    }, 5);
    const s = await sequence.find(root);
    const total = await sequence.size(s);
    clearInterval(timer);
    assert.equal(s.count, 10000);
    assert.equal(total, 10000);
    // The old synchronous stat of every frame held the loop for the whole scan.
    assert.ok(longest < 200, `event loop held for ${longest} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
