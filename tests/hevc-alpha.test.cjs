const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { execFileSync } = require("node:child_process");
const c = require("../backend/core.cjs");
const settings = {
  ...c.DEFAULTS,
  encoder: "nvencc:hevc",
  alphaMode: "preserve",
  bitDepth: 8,
  chroma: "420",
  container: "mov",
  audio: "none",
  preset: "p4",
  lookahead: 0,
};
test("HEVC Alpha validates explicit constraints and preserves alpha during preparation", () => {
  const meta = {
    width: 640,
    height: 360,
    hasAlpha: true,
    fps: 30,
    codec: "ffv1",
  };
  assert.deepEqual(c.validate(settings, meta), []);
  for (const patch of [
    { bitDepth: 10 },
    { chroma: "444" },
    { encoder: "hevc_nvenc" },
    { encoder: "libx265" },
    { container: "webm" },
  ])
    assert.ok(c.validate({ ...settings, ...patch }, meta).length);
  assert.ok(c.validate(settings, { ...meta, hasAlpha: false }).length);
  const commands = c.buildCommands(
    { path: "input.mkv", meta },
    settings,
    { ffmpeg: "ffmpeg", nvencc: "NVEncC" },
    { output: "output.mov" },
  );
  assert.ok(commands[0].pipeFrom.args.includes("yuva444p"));
  assert.ok(commands[0].args.includes("yuva420"));
  assert.ok(commands[0].args.includes("--alpha-channel-mode"));
  assert.ok(commands[1].args.includes("copy"));
});
const { ff, nv, runCommand } = require("./engines.cjs");
const dir = fs.existsSync(ff) && fs.existsSync(nv);
test(
  "real NVEncC HEVC contains an eight-bit alpha auxiliary layer",
  { skip: !dir, timeout: 120000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-hevc-alpha-"));
    try {
      const input = path.join(tmp, "input.mkv"),
        output = path.join(tmp, "output.mov");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=640x360:r=30:d=0.2,format=yuva444p,geq=a=128:lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)'",
        "-c:v",
        "ffv1",
        input,
      ]);
      const commands = c.buildCommands(
        {
          path: input,
          meta: {
            width: 640,
            height: 360,
            hasAlpha: true,
            fps: 30,
            codec: "ffv1",
          },
        },
        settings,
        { ffmpeg: ff, nvencc: nv },
        { output },
      );
      for (const cmd of commands) runCommand(cmd);
      let trace = "";
      const { spawnSync } = require("node:child_process");
      trace = spawnSync(
        ff,
        [
          "-i",
          output,
          "-c",
          "copy",
          "-bsf:v",
          "trace_headers",
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      ).stderr;
      assert.match(trace, /Alpha Channel Information/);
      assert.match(trace, /alpha_channel_cancel_flag[^\n]*= 0/);
      assert.match(trace, /alpha_channel_bit_depth_minus8[^\n]*= 0/);
      assert.match(trace, /nuh_layer_id[^\n]*= 1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);
