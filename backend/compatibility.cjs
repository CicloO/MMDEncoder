"use strict";
const { validationIssue, summary } = require("./errors.cjs");
const { ENGINES, PRORES_QUALITY } = require("./definitions.cjs");
const { validateIssues } = require("./settings-validation.cjs");
function compatibility(s, engines = ENGINES) {
  const issues = validateIssues({ ...s, outputMode: "encoded", outputDir: "" });
  const suggestions = [];
  const add = (id, code, patch) => {
    const fixed = { ...s, ...patch, outputMode: "encoded", outputDir: "" };
    if (
      !validateIssues(fixed).length &&
      Object.entries(patch).some(([key, value]) => s[key] !== value)
    ) {
      const description = summary(code);
      suggestions.push({
        id,
        ...description,
        label: description.message,
        patch,
      });
    }
  };
  const current = engines.find((e) => e.id === s.encoder);
  const alphaSupported =
    s.alphaMode !== "preserve" || s.encoder !== "nvencc:hevc" || current?.alpha;
  if (!alphaSupported)
    issues.push(validationIssue("DEVICE_HEVC_ALPHA_UNVERIFIED"));
  if (
    (s.vsr || s.vfg) &&
    issues.length &&
    s.alphaMode !== "preserve" &&
    !s.alphaMask
  ) {
    const engine = engines.find((e) => e.backend === "nvencc");
    if (engine)
      add("rtx-compatible", "COMPAT_RTX_FIX", {
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
  if (s.alphaMode === "preserve" && issues.length) {
    // No NVEncC HEVC Alpha fix: Windows editors (After Effects, Premiere)
    // cannot read HEVC alpha, so it is only offered by choosing it manually.
    for (const [id, code, patch] of [
      [
        "prores_ks",
        "COMPAT_PRORES_ALPHA",
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
        "COMPAT_VP9_ALPHA",
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
        add(id, code, patch);
    }
    // Split alpha keeps the chosen encoder and container: the colour video
    // drops alpha and a separate mask carries it, so any format works.
    add("split-alpha", "COMPAT_SPLIT_ALPHA", {
      alphaMode: "discard",
      alphaMask: true,
    });
  } else if (issues.length && current) {
    const patch = {};
    if (
      issues.some(
        (e) =>
          e.code === "SPEED_PRESET_INVALID" ||
          e.code === "ENCODER_SPEED_INVALID",
      )
    )
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
    add("compatible", "COMPAT_ENCODER_FIX", patch);
  }
  return { errors: issues.map((issue) => issue.message), issues, suggestions };
}

module.exports = { compatibility };
