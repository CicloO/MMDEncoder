const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../backend/core.cjs");
const base = { ...c.DEFAULTS, encoder: "nvencc:hevc", preset: "p4", vsr: true };
const { probe } = require("../backend/enhancements.cjs");
test("VSR probe accepts selected integer and rational FPS and rejects incorrect output FPS", async () => {
  const engines = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", nvencc: "nvencc" };
  const run = (rate) => async (exe) =>
    exe === "ffprobe"
      ? {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                width: 2560,
                height: 1440,
                avg_frame_rate: rate,
              },
            ],
          }),
          stderr: "",
        }
      : { stdout: "", stderr: "" };
  for (const fps of ["30", "30000/1001"]) {
    assert.match(
      await probe(
        { ...base, fps },
        engines,
        run(fps.includes("/") ? fps : fps + "/1"),
      ),
      /已验证输出/,
    );
    await assert.rejects(probe({ ...base, fps }, engines, run("24/1")), /帧率/);
  }
  assert.match(
    await probe({ ...base, fps: "source" }, engines, run("24/1")),
    /已验证输出/,
  );
});
test("RTX validation, exact NVIDIA modes, source scaling and frame multiplier", () => {
  const meta = { width: 640, height: 360, fps: 30, hasAlpha: false };
  for (const quality of [
    0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23,
  ])
    assert.deepEqual(
      c.validate(
        {
          ...base,
          vsrQuality: quality,
          vsrScale: quality >= 8 && quality <= 19 ? 1 : 2,
        },
        meta,
      ),
      [],
    );
  for (const p of [
    { vsrQuality: 5 },
    { vsrScale: 4.01 },
    { vsrStrength: 1.01 },
    { alphaMode: "preserve" },
    { alphaMask: true },
    { resizeMode: "custom" },
    { encoder: "libx264", preset: "medium" },
  ])
    assert.ok(c.validate({ ...base, ...p }, meta).length);
  assert.ok(c.validate({ ...base, vsrQuality: 16, vsrScale: 2 }, meta).length);
  assert.deepEqual(c.dimensions(base, meta), { width: 1280, height: 720 });
  const s = { ...base, vfg: true, vfgMultiplier: 4, vfgMode: "high" };
  assert.deepEqual(c.validate(s, meta), []);
  assert.ok(c.validate({ ...s, fps: "60" }, meta).length);
  assert.ok(c.validate({ ...s, vfgMultiplier: 9 }, meta).length);
  const cmds = c.buildCommands(
    { path: "input", meta },
    s,
    { ffmpeg: "ff", nvencc: "nv" },
    { output: "out.mkv" },
  );
  assert.ok(cmds[1].args.includes("algo=ngx-vsr,vsr-quality=4,vsr-strength=1"));
  assert.ok(cmds[1].args.includes("1280x720"));
  assert.ok(cmds[1].args.includes("mode=high,multiplier=4"));
  assert.ok(
    !cmds[0].args.some((a) => typeof a === "string" && a.includes("w=1280")),
  );
});
test("platform presets pair hardware and software variants and retain personal preset schema", () => {
  assert.equal(c.BUILTINS.length, 9);
  for (const p of c.BUILTINS) {
    assert.deepEqual(c.validate(p.settings), []);
    assert.equal(p.settings.fps, "source");
    assert.equal(p.settings.presetName, p.name);
    if (p.id.endsWith("-sw")) {
      assert.match(p.name, / · 软件$/);
      assert.equal(p.settings.encoder, "libx264");
      assert.equal(p.settings.preset, "medium");
      const hw = c.BUILTINS.find((h) => h.id === p.id.slice(0, -3));
      assert.equal(hw.name, p.name.replace("软件", "硬件"));
      for (const k of ["width", "height", "resizeAxis", "audioBitrate"])
        assert.equal(p.settings[k], hw.settings[k]);
    } else {
      assert.equal(p.settings.encoder, "h264_nvenc");
      assert.equal(p.settings.preset, p.id === "builtin-x" ? "p7" : "p4");
      assert.equal(p.settings.lookahead, 32);
      assert.equal(p.settings.lookaheadLevel, 0);
    }
  }
  const byId = Object.fromEntries(c.BUILTINS.map((p) => [p.id, p.settings]));
  assert.equal(byId["builtin-x"].bitrate, 20000);
  assert.equal(byId["builtin-x"].rateControl, "bitrate");
  assert.equal(byId["builtin-youtube"].quality, 27);
  assert.equal(byId["builtin-youtube-sw"].quality, 19);
  assert.equal(byId["builtin-bilibili4k-sw"].quality, 21);
  assert.equal(byId["builtin-youtube"].audioBitrate, 384);
  assert.equal(byId["builtin-tiktok"].resizeAxis, "height");
  assert.equal(byId["builtin-tiktok"].height, 3840);
});
