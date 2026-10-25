"use strict";
const { ENGINES, PRORES_QUALITY } = require("./definitions.cjs");
const { validate } = require("./settings-validation.cjs");
function compatibility(s, engines = ENGINES) {
  const errors = validate({ ...s, outputMode: "encoded", outputDir: "" });
  const suggestions = [];
  const add = (id, label, patch) => {
    const fixed = { ...s, ...patch, outputMode: "encoded", outputDir: "" };
    if (
      !validate(fixed).length &&
      Object.entries(patch).some(([key, value]) => s[key] !== value)
    )
      suggestions.push({ id, label, patch });
  };
  const current = engines.find((e) => e.id === s.encoder);
  const alphaSupported =
    s.alphaMode !== "preserve" || s.encoder !== "nvencc:hevc" || current?.alpha;
  if (!alphaSupported) errors.push("本机未通过 NVEncC HEVC Alpha 试编码");
  if (
    (s.vsr || s.vfg) &&
    errors.length &&
    s.alphaMode !== "preserve" &&
    !s.alphaMask
  ) {
    const engine = engines.find((e) => e.backend === "nvencc");
    if (engine)
      add("rtx-compatible", "保留 RTX VSR / VFG 并修正关联设置", {
        encoder: engine.id,
        preset: "p4",
        bitDepth: 8,
        chroma: "420",
        lookahead: 0,
        lookaheadLevel: 0,
        quality: Math.min(s.quality, 51),
        ...(s.vsr
          ? {
              resizeMode: "source",
              ...(s.vsrQuality >= 8 && s.vsrQuality <= 19
                ? { vsrScale: 1 }
                : {}),
            }
          : {}),
        ...(s.vfg ? { fps: "source" } : {}),
      });
  }
  if (s.alphaMode === "preserve" && errors.length) {
    // No NVEncC HEVC Alpha fix: Windows editors (After Effects, Premiere)
    // cannot read HEVC alpha, so it is only offered by choosing it manually.
    for (const [id, label, patch] of [
      [
        "prores_ks",
        "切换至 ProRes 4444 Alpha",
        {
          encoder: "prores_ks",
          bitDepth: 10,
          chroma: "444",
          container: ["mov", "mkv"].includes(s.container) ? s.container : "mov",
          audio: s.audio === "none" ? "none" : "pcm_s16le",
          preset: "medium",
          rateControl: "quality",
          quality: PRORES_QUALITY,
          lookahead: 0,
          lookaheadLevel: 0,
        },
      ],
      [
        "libvpx-vp9",
        "切换至 VP9 Alpha",
        {
          encoder: "libvpx-vp9",
          bitDepth: 8,
          chroma: "420",
          container: ["webm", "mkv"].includes(s.container)
            ? s.container
            : "webm",
          audio: s.audio === "none" ? "none" : "libopus",
          preset: "medium",
          rateControl: "quality",
          lookahead: 0,
          lookaheadLevel: 0,
        },
      ],
    ]) {
      const engine = engines.find((e) => e.id === id);
      if (engine && (id !== "nvencc:hevc" || engine.alpha))
        add(id, label, patch);
    }
    // Split alpha keeps the chosen encoder and container: the colour video
    // drops alpha and a separate mask carries it, so any format works.
    add("split-alpha", "改为分离 Alpha（保持当前格式）", {
      alphaMode: "discard",
      alphaMask: true,
    });
  } else if (errors.length && current) {
    const patch = {};
    if (errors.some((e) => e.includes("速度预设")))
      patch.preset = ["nvenc", "nvencc"].includes(current.backend)
        ? "p4"
        : current.backend === "amf"
          ? "balanced"
          : s.encoder === "libsvtav1"
            ? "6"
            : "medium";
    if (!current.depths.includes(s.bitDepth))
      patch.bitDepth = current.depths[0];
    if (current.codec === "prores")
      Object.assign(patch, {
        bitDepth: 10,
        chroma: ["422", "444"].includes(s.chroma) ? s.chroma : "422",
        container: ["mov", "mkv"].includes(s.container) ? s.container : "mov",
        rateControl: "quality",
        preset: "medium",
      });
    if (["qsv", "amf"].includes(current.backend) || current.codec === "av1")
      patch.chroma = "420";
    if (
      current.codec === "h264" &&
      current.backend === "nvenc" &&
      s.chroma === "422"
    )
      patch.chroma = "420";
    if (s.container === "webm" && !["vp9", "av1"].includes(current.codec))
      patch.container = "mkv";
    else if (s.container === "webm" && !["libopus", "none"].includes(s.audio))
      patch.audio = "libopus";
    const container = patch.container || s.container;
    if (
      ["mp4", "mov"].includes(container) &&
      !["aac", "none", ...(container === "mov" ? ["pcm_s16le"] : [])].includes(
        s.audio,
      )
    )
      patch.container = "mkv";
    if (
      ["libsvtav1", "libvpx-vp9", "prores_ks"].includes(s.encoder) &&
      s.rateControl === "qp"
    )
      patch.rateControl = "quality";
    if (["h264", "hevc"].includes(current.codec) && s.quality > 51)
      patch.quality = 51;
    add("compatible", "修正为当前编码器的兼容设置", patch);
  }
  return { errors, suggestions };
}

module.exports = { compatibility };
