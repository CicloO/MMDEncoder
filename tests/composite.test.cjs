const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const { filter } = require("../backend/filter.cjs");
const { ff } = require("./engines.cjs");

// The per-pixel geq that compositing used up to 1.6.0, as the reference.
const BG = { green: [0, 255, 0], black: [0, 0, 0], white: [255, 255, 255] };
function geq(mode) {
  const [r, g, b] = BG[mode];
  const mix = (c, bg) => `${c}(X,Y)*alpha(X,Y)/255+${bg}*(1-alpha(X,Y)/255)`;
  return `format=rgba,geq=r='${mix("r", r)}':g='${mix("g", g)}':b='${mix("b", b)}'`;
}
// Every frame of `vf` on `src` as RGB bytes.
function rgb(src, vf) {
  const r = spawnSync(
    ff,
    [
      "-v",
      "error",
      "-i",
      src,
      "-vf",
      vf + ",format=rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1 << 28 },
  );
  assert.equal(r.status, 0, r.stderr?.toString());
  return r.stdout;
}
function maxDiff(a, b) {
  assert.equal(a.length, b.length, "same frames and size");
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}
const settings = (s) => ({
  ...core.DEFAULTS,
  encoder: "libx264",
  preset: "ultrafast",
  audio: "none",
  ...s,
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-composite-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
// Alpha ramps across the frame, so every blend weight 0–255 is checked.
function source(name, pixFmt) {
  const file = path.join(dir, name);
  execFileSync(ff, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=256x64:r=30:d=0.2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='X'",
    "-pix_fmt",
    pixFmt,
    "-c:v",
    pixFmt === "rgba" ? "png" : "ffv1",
    file,
  ]);
  return file;
}

test("compositing over a colour uses overlay, not a per-pixel geq", () => {
  const meta = { width: 256, height: 64, pixFmt: "rgba", hasAlpha: true };
  for (const mode of ["green", "black", "white"]) {
    const vf = filter(settings({ alphaMode: mode }), meta);
    assert.doesNotMatch(vf, /geq/);
    const [r, g, b] = BG[mode];
    assert.match(vf, new RegExp(`lutrgb=r=${r}:g=${g}:b=${b}:a=255`));
    assert.match(vf, /overlay=format=rgb/);
  }
  // Kept, discarded and mask-only alpha are not composited.
  for (const mode of ["preserve", "discard", "mask"])
    assert.doesNotMatch(filter(settings({ alphaMode: mode }), meta), /overlay/);
});

test("overlay compositing gives the same pixels as the old geq (RGBA and YUVA sources)", () => {
  for (const [name, pixFmt] of [
    ["rgba.mkv", "rgba"],
    ["yuva.mkv", "yuva420p"],
  ]) {
    const src = source(name, pixFmt);
    for (const mode of ["green", "black", "white"]) {
      const meta = { width: 256, height: 64, pixFmt, hasAlpha: true };
      // Only the composite step: the rest of the chain (scale to YUV) is the
      // same on both sides.
      const vf = filter(settings({ alphaMode: mode }), meta)
        .split(",scale=")[0]
        .replace(/^setparams=colorspace=bt709,/, "");
      assert.ok(
        maxDiff(rgb(src, geq(mode)), rgb(src, vf)) <= 1,
        `${name} ${mode}`,
      );
    }
  }
});

test("a composited encode keeps every frame, with resizing and with the mask in one pass", () => {
  const src = source("enc.mkv", "rgba");
  const meta = {
    width: 256,
    height: 64,
    fps: 30,
    fpsText: "30",
    duration: 0.2,
    codec: "png",
    pixFmt: "rgba",
    hasAlpha: true,
  };
  for (const [name, s] of [
    ["plain", { alphaMode: "green" }],
    [
      "resized",
      { alphaMode: "white", resizeMode: "custom", width: 128, height: 32 },
    ],
    ["mask", { alphaMode: "black", alphaMask: true }],
  ]) {
    const output = path.join(dir, name + ".mp4");
    const maskOutput = path.join(dir, name + "_alpha.mp4");
    const commands = core.singlePass(
      core.buildCommands(
        { path: src, meta },
        settings(s),
        { ffmpeg: ff },
        {
          output,
          maskOutput,
        },
      ),
    );
    for (const c of commands) execFileSync(c.exe, c.args);
    const frames = (file) =>
      execFileSync(ff.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        file,
      ])
        .toString()
        .trim();
    assert.equal(frames(output), "6", name);
    if (s.alphaMask) assert.equal(frames(maskOutput), "6", name + " mask");
  }
});
