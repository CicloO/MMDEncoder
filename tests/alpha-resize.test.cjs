const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { execFileSync } = require("node:child_process");
const c = require("../backend/core.cjs");
const { ff, fp } = require("./engines.cjs");
test("resolution aspect, unlock, limits and alpha compatibility", () => {
  const s = { ...c.DEFAULTS, resizeMode: "custom", width: 320, height: 200 };
  assert.deepEqual(c.dimensions(s, { width: 1920, height: 1080 }), {
    width: 320,
    height: 180,
  });
  assert.deepEqual(c.dimensions(s, { width: 1080, height: 1920 }), {
    width: 320,
    height: 568,
  });
  assert.deepEqual(
    c.dimensions({ ...s, resizeAxis: "height" }, { width: 1920, height: 1080 }),
    { width: 356, height: 200 },
  );
  assert.deepEqual(
    c.dimensions({ ...s, keepAspect: false }, { width: 1920, height: 1080 }),
    { width: 320, height: 200 },
  );
  assert.ok(c.validate({ ...s, width: 0 }).length);
  assert.ok(
    c
      .validate({ ...c.DEFAULTS, alphaMode: "preserve" })
      .some((x) => x.includes("Alpha")),
  );
});
test("real alpha retention and matching resized mask for ProRes and VP9", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-alpha-resize-"));
  const input = path.join(dir, "input.mkv");
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=128x72:r=30:d=0.3,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a=128",
    "-c:v",
    "ffv1",
    input,
  ]);
  for (const [encoder, container, bitDepth, chroma] of [
    ["prores_ks", "mov", 10, "444"],
    ["libvpx-vp9", "webm", 8, "420"],
  ]) {
    const s = {
      ...c.DEFAULTS,
      encoder,
      container,
      bitDepth,
      chroma,
      audio: "none",
      alphaMode: "preserve",
      alphaMask: true,
      resizeMode: "custom",
      width: 64,
      height: 64,
    };
    const output = path.join(dir, encoder + "." + container),
      maskOutput = path.join(dir, encoder + "-mask." + container);
    for (const cmd of c.buildCommands(
      { path: input, meta: { width: 128, height: 72, hasAlpha: true } },
      s,
      { ffmpeg: ff },
      { output, maskOutput },
    ))
      execFileSync(cmd.exe, cmd.args, { stdio: "pipe" });
    for (const out of [output, maskOutput]) {
      const stream = JSON.parse(
        execFileSync(fp, ["-v", "error", "-show_streams", "-of", "json", out], {
          encoding: "utf8",
        }),
      ).streams[0];
      assert.equal(stream.width, 64);
      assert.equal(stream.height, 36);
    }
    const decode = encoder === "libvpx-vp9" ? ["-c:v", "libvpx-vp9"] : [];
    const alpha = execFileSync(ff, [
      "-v",
      "error",
      ...decode,
      "-i",
      output,
      "-vf",
      "alphaextract,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    const mean = [...alpha].reduce((a, b) => a + b, 0) / alpha.length;
    assert.ok(mean > 120 && mean < 136, `${encoder} alpha ${mean}`);
  }
});
test("mask only: one lossless _alpha file, no colour video or audio, any encoder setting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-mask-only-"));
  const input = path.join(dir, "input.mkv");
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=128x72:r=30:d=0.3,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a=128",
    "-f",
    "lavfi",
    "-i",
    "sine=d=0.3",
    "-c:v",
    "ffv1",
    "-shortest",
    input,
  ]);
  const meta = { width: 128, height: 72, hasAlpha: true, audio: true };
  // The colour encoder (NVEncC here) is not used for the mask.
  const s = {
    ...c.DEFAULTS,
    encoder: "nvencc:hevc",
    preset: "p4",
    outputMode: "source",
    alphaMode: "mask",
    alphaMask: false,
  };
  assert.deepEqual(c.validate(s, meta), []);
  assert.match(
    c.validate(s, { ...meta, hasAlpha: false }).join(),
    /不能生成遮罩/,
  );
  assert.ok(c.validate({ ...s, encoder: "nvencc:h264", vsr: true }).length);
  for (const container of ["mp4", "webm"]) {
    const paths = c.outputPaths(input, { ...s, container });
    assert.equal(paths.output, path.join(dir, "input_alpha." + container));
    assert.equal(paths.maskOutput, undefined);
    const cmds = c.buildCommands({ path: input, meta }, { ...s, container }, { ffmpeg: ff }, paths);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].output, paths.output);
    assert.equal(cmds[0].mask, false, "the mask is the main output");
    execFileSync(cmds[0].exe, cmds[0].args, { stdio: "pipe" });
    const streams = JSON.parse(
      execFileSync(fp, ["-v", "error", "-show_streams", "-of", "json", paths.output], {
        encoding: "utf8",
      }),
    ).streams;
    assert.deepEqual(streams.map((x) => x.codec_type), ["video"]);
    assert.equal(streams[0].codec_name, container === "webm" ? "vp9" : "h264");
    const gray = execFileSync(ff, [
      "-v",
      "error",
      "-i",
      paths.output,
      "-vf",
      "format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    const mean = [...gray].reduce((a, b) => a + b, 0) / gray.length;
    assert.ok(mean > 120 && mean < 136, `${container} mask ${mean}`);
  }
});
