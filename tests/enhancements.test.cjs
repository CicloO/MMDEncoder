const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../backend/core.cjs");
const base = { ...c.DEFAULTS, encoder: "nvencc:hevc", preset: "p4", vsr: true };
const { probe } = require("../backend/enhancements.cjs");
test("VSR probe accepts selected integer and rational FPS and rejects incorrect output FPS", async () => {
  const engines = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", nvencc: "nvencc" };
  const run = (rate) => {
    const fn = async (exe) =>
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
    // NVEncC is fed by FFmpeg through a pipe.
    fn.piped = (c, o) => fn(c.exe, c.args, o);
    return fn;
  };
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
  assert.ok(cmds[0].args.includes("algo=ngx-vsr,vsr-quality=4,vsr-strength=1"));
  assert.ok(cmds[0].args.includes("1280x720"));
  assert.ok(cmds[0].args.includes("mode=high,multiplier=4"));
  assert.ok(
    !cmds[0].pipeFrom.args.some(
      (a) => typeof a === "string" && a.includes("w=1280"),
    ),
  );
});
test("recommended presets pair hardware and software variants and scale by the long edge", () => {
  assert.deepEqual(
    c.BUILTINS.map((p) => p.name),
    [
      "默认 4K · 硬件",
      "默认 4K · 软件",
      "默认 1080p · 硬件",
      "默认 1080p · 软件",
      "保留 Alpha · ProRes 4444",
      "分离 Alpha · H.264 MP4",
      "ProRes 422 HQ · 剪辑素材",
    ],
  );
  for (const p of c.BUILTINS) {
    assert.deepEqual(c.validate(p.settings), []);
    assert.equal(p.settings.fps, "source");
    assert.equal(p.settings.presetName, p.name);
    assert.equal(p.builtin, true);
  }
  const byId = Object.fromEntries(c.BUILTINS.map((p) => [p.id, p.settings]));
  for (const id of ["4k", "1080"]) {
    const hw = byId["builtin-" + id],
      sw = byId["builtin-" + id + "-sw"];
    assert.equal(hw.encoder, "h264_nvenc");
    assert.equal(hw.preset, "p4");
    assert.equal(hw.quality, 29);
    assert.equal(hw.lookahead, 32);
    assert.equal(sw.encoder, "libx264");
    assert.equal(sw.preset, "medium");
    assert.equal(sw.quality, 21);
    for (const s of [hw, sw]) {
      assert.equal(s.resizeMode, "long");
      assert.equal(s.audioBitrate, 320);
    }
  }
  // Long edge: landscape gets the width, portrait the height.
  const k4 = byId["builtin-4k"];
  assert.deepEqual(c.dimensions(k4, { width: 1920, height: 1080 }), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(c.dimensions(k4, { width: 1080, height: 1920 }), {
    width: 2160,
    height: 3840,
  });
  assert.deepEqual(c.dimensions(k4, { width: 2560, height: 1080 }), {
    width: 3840,
    height: 1620,
  });
  assert.deepEqual(
    c.dimensions(byId["builtin-1080"], { width: 1080, height: 1920 }),
    { width: 1080, height: 1920 },
  );
  const alpha = byId["builtin-alpha"];
  assert.equal(alpha.encoder, "prores_ks");
  assert.equal(alpha.container, "mov");
  assert.equal(alpha.quality, 12);
  assert.equal(c.PRORES_QUALITY, 12);
  // ProRes 422 HQ editing preset: no alpha, 10-bit 4:2:2, source size.
  const p422 = byId["builtin-prores422"];
  assert.equal(p422.encoder, "prores_ks");
  assert.equal(p422.chroma, "422");
  assert.equal(p422.bitDepth, 10);
  assert.equal(p422.alphaMode, "discard");
  assert.equal(p422.resizeMode, "source");
  assert.equal(p422.quality, 12);
  assert.deepEqual(c.validate(p422), []);
  const mask = byId["builtin-alpha-mask"];
  assert.equal(mask.resizeMode, "source");
  // Split uses the recommended hardware encoder settings at CQ 19.
  for (const k of ["encoder", "preset", "lookahead", "audioBitrate"])
    assert.equal(mask[k], byId["builtin-4k"][k]);
  assert.equal(mask.quality, 19);
  assert.equal(mask.container, "mp4");
  assert.equal(mask.alphaMode, "discard");
  assert.equal(mask.alphaMask, true);
  // ProRes: quantizer 1–64 reaches FFmpeg, 0 keeps the encoder default.
  const prores = { ...alpha, quality: 16 };
  assert.deepEqual(c.validate(prores), []);
  assert.ok(
    c
      .validate({ ...alpha, quality: 65 })
      .some((e) => e.includes("ProRes 量化")),
  );
  assert.equal(alpha.alphaMode, "preserve");
  assert.equal(alpha.resizeMode, "source");
  assert.equal(c.ENGINES.find((e) => e.id === "libx264").label, "H.264 · CPU");
});
