const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const { ff, fp } = require("./engines.cjs");

const meta = (width, height) => ({
  width,
  height,
  fps: 30,
  fpsText: "30",
  duration: 2,
  codec: "rawvideo",
  pixFmt: "rgba",
  hasAlpha: true,
});
const split = (s) => ({
  ...core.DEFAULTS,
  alphaMode: "discard",
  alphaMask: true,
  audio: "none",
  ...s,
});
const count = (args, x) => args.filter((a) => a === x).length;

test("the mask goes to NVENC lossless only where it can: NVENC found, ≤ 4096 a side, not WebM", () => {
  const codecOf = (s, m, engines) =>
    core
      .buildCommands({ path: "C:/a.avi", meta: m }, s, engines, {
        output: "C:/o." + s.container,
        maskOutput: "C:/o_alpha." + s.container,
      })
      .find((c) => c.mask)
      .args.join(" ");
  const s = split({ encoder: "libx264", preset: "ultrafast" });
  const gpu = { ffmpeg: "ff", nvencLossless: true };
  assert.match(
    codecOf(s, meta(2160, 3840), gpu),
    /h264_nvenc -preset p1 -tune lossless/,
  );
  assert.match(
    codecOf(s, meta(2160, 3840), { ffmpeg: "ff" }),
    /libx264 .*-crf 0/,
  );
  assert.match(codecOf(s, meta(5120, 2880), gpu), /libx264/);
  // Below NVENC's 145 × 49 too.
  assert.match(codecOf(s, meta(64, 64), gpu), /libx264/);
  assert.match(
    codecOf(
      { ...s, container: "webm", encoder: "libvpx-vp9" },
      meta(1920, 1080),
      gpu,
    ),
    /libvpx-vp9/,
  );
});

test("single pass: one FFmpeg writes both outputs; with NVEncC the frame feeder writes the mask", () => {
  const paths = { output: "C:/o.mp4", maskOutput: "C:/o_alpha.mp4" };
  const job = { path: "C:/a.avi", meta: meta(1920, 1080) };
  const engines = { ffmpeg: "ff", nvencc: "nv", nvencLossless: true };
  // FFmpeg encoder: two commands become one.
  const one = core.singlePass(
    core.buildCommands(
      job,
      split({ encoder: "h264_nvenc", preset: "p4" }),
      engines,
      paths,
    ),
  );
  assert.equal(one.length, 1);
  assert.ok(one[0].mask && one[0].output === paths.output);
  const a = one[0].args;
  assert.equal(count(a, "-i"), 1, "the source is read once");
  assert.equal(count(a, "-progress"), 1);
  assert.deepEqual(
    a.filter((x, i) => a[i - 1] === "-map"),
    ["[vout]", "[mout]"],
  );
  assert.equal(a.at(-1), paths.maskOutput);
  assert.ok(a.includes(paths.output));
  // NVEncC: the mask joins the FFmpeg run that pipes frames to NVEncC.
  const nv = core.singlePass(
    core.buildCommands(
      job,
      split({ encoder: "nvencc:h264", preset: "p4" }),
      engines,
      paths,
    ),
  );
  assert.equal(nv.length, 2, "NVEncC and packaging, no separate mask run");
  const feed = nv[0].pipeFrom.args;
  assert.ok(nv[0].mask);
  assert.equal(count(feed, "-progress"), 1);
  assert.equal(
    feed[feed.indexOf("-progress") + 1],
    "pipe:2",
    "stdout stays the frames",
  );
  assert.equal(feed.at(-1), paths.maskOutput);
  // Mask only and no mask: nothing to join.
  const maskOnly = core.buildCommands(
    job,
    split({ alphaMode: "mask", alphaMask: false }),
    engines,
    paths,
  );
  assert.deepEqual(core.singlePass(maskOnly), maskOnly);
});

test(
  "single pass makes the same colour video and mask as two passes",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-pass-"));
    try {
      // Left half transparent, right half opaque, a soft edge between.
      const src = path.join(dir, "alpha.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((X-140)*6,0,255)'",
        "-c:v",
        "ffv1",
        src,
      ]);
      const m = core.metadata(
        JSON.parse(
          execFileSync(fp, [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            src,
          ]),
        ),
      );
      assert.ok(m.hasAlpha);
      const s = split({
        encoder: "libx264",
        preset: "ultrafast",
        container: "mkv",
      });
      const md5 = (f) =>
        execFileSync(ff, [
          "-v",
          "error",
          "-i",
          f,
          "-map",
          "0:v",
          "-f",
          "md5",
          "-",
        ])
          .toString()
          .trim();
      const strip = (a) =>
        a.filter(
          (x, i, all) => x !== "-progress" && all[i - 1] !== "-progress",
        );
      const build = (name) =>
        core.buildCommands(
          { path: src, meta: m },
          s,
          { ffmpeg: ff },
          {
            output: path.join(dir, name + ".mkv"),
            maskOutput: path.join(dir, name + "_alpha.mkv"),
          },
        );
      for (const c of build("two"))
        execFileSync(ff, strip(c.args), { stdio: "pipe" });
      const [one] = core.singlePass(build("one"));
      execFileSync(ff, strip(one.args), { stdio: "pipe" });
      assert.equal(
        md5(path.join(dir, "one_alpha.mkv")),
        md5(path.join(dir, "two_alpha.mkv")),
      );
      assert.equal(
        md5(path.join(dir, "one.mkv")),
        md5(path.join(dir, "two.mkv")),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
