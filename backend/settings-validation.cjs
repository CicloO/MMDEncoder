"use strict";
const { appError, validationIssue, serializeError } = require("./errors.cjs");
const path = require("node:path");
const { FADES } = require("./media.cjs");
const { ENGINES } = require("./definitions.cjs");
const { parseFps, dimensions } = require("./filter.cjs");
const { maskSettings, MASK_FORMATS } = require("./mask-settings.cjs");
function filename(name) {
  if (
    !name ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  )
    throw appError("OUTPUT_NAME_INVALID");
  return name;
}
function validateIssues(s, meta) {
  // Mask only: the colour encoder and audio settings are not used, so check
  // the mask's own encoding; RTX stays refused and the source needs alpha.
  if (s.alphaMode === "mask") {
    const e = validateIssues(
      { ...maskSettings(s), vsr: false, vfg: false },
      meta,
    );
    if (s.vsr || s.vfg) e.push(validationIssue("RTX_ALPHA_UNSUPPORTED"));
    if (meta && !meta.hasAlpha)
      e.push(validationIssue("SOURCE_ALPHA_MASK_REQUIRED"));
    return uniqueIssues(e);
  }
  const e = [];
  const check = (ok, code, params = {}) => {
    if (!ok) e.push(validationIssue(code, params));
  };
  const eng = ENGINES.find((x) => x.id === s.encoder);
  check(
    MASK_FORMATS.includes(s.maskFormat ?? "lossless"),
    "MASK_FORMAT_INVALID",
  );
  if (s.vsr || s.vfg) {
    check(eng?.backend === "nvencc", "RTX_NVENCC_REQUIRED");
    check(s.alphaMode !== "preserve" && !s.alphaMask, "RTX_ALPHA_UNSUPPORTED");
    check(s.bitDepth === 8 && s.chroma === "420", "RTX_FORMAT_REQUIRED");
  }
  check(
    ["lanczos", "artcnn"].includes(s.upscaler ?? "lanczos"),
    "UPSCALER_INVALID",
  );
  check(
    ["C4F16", "C4F32"].includes(s.artcnnModel ?? "C4F16"),
    "ARTCNN_MODEL_INVALID",
  );
  if (s.vsr) {
    check(
      Number.isFinite(s.vsrScale) && s.vsrScale >= 1 && s.vsrScale <= 4,
      "VSR_SCALE_INVALID",
    );
    check(
      [
        0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23,
      ].includes(s.vsrQuality),
      "VSR_QUALITY_INVALID",
    );
    check(
      Number.isFinite(s.vsrStrength) &&
        s.vsrStrength >= 0 &&
        s.vsrStrength <= 1,
      "VSR_STRENGTH_INVALID",
    );
    check(s.resizeMode === "source", "VSR_SOURCE_SIZE_REQUIRED");
    if (s.vsrQuality >= 8 && s.vsrQuality <= 19)
      check(s.vsrScale === 1, "VSR_NATIVE_SCALE_REQUIRED");
  }
  if (s.vfg) {
    check(
      !s.vfgModelDir || path.isAbsolute(s.vfgModelDir),
      "VFG_MODEL_PATH_INVALID",
    );
    check(
      Number.isInteger(s.vfgMultiplier) &&
        s.vfgMultiplier >= 2 &&
        s.vfgMultiplier <= 8,
      "VFG_MULTIPLIER_INVALID",
    );
    check(["low", "medium", "high"].includes(s.vfgMode), "VFG_MODEL_INVALID");
    check(s.fps === "source", "VFG_SOURCE_FPS_REQUIRED");
    if (meta)
      check(meta.fps * s.vfgMultiplier <= 960, "VFG_OUTPUT_FPS_INVALID");
  }
  check(!!eng, "ENCODER_INVALID");
  for (const [k, values] of Object.entries({
    container: ["mp4", "mkv", "mov", "webm"],
    bitDepth: [8, 10],
    chroma: ["420", "422", "444"],
    rateControl: ["quality", "qp", "bitrate"],
    audio: ["aac", "flac", "pcm_s16le", "libopus", "copy", "none"],
    // color = composited over alphaBackground; mask = only the
    // black-and-white alpha mask, no colour video.
    alphaMode: ["discard", "color", "preserve", "mask"],
    resizeMode: ["source", "custom", "long"],
    resizeAxis: ["width", "height"],
    outputMode: ["source", "encoded", "custom"],
    colorSpace: ["bt709", "bt601", "bt2020"],
    colorRange: ["tv", "pc"],
  }))
    check(values.includes(s[k]), "SETTING_VALUE_INVALID", { field: k });
  try {
    parseFps(s.fps);
  } catch (x) {
    e.push(serializeError(x));
  }
  try {
    filename(
      String(s.nameTemplate).replace(/\{(?:name|preset|date|index)\}/g, "name"),
    );
    check(
      !/[{}]/.test(
        String(s.nameTemplate).replace(/\{(?:name|preset|date|index)\}/g, ""),
      ),
      "NAME_TEMPLATE_TOKEN_INVALID",
    );
  } catch (x) {
    e.push(serializeError(x));
  }
  for (const [k, min, max] of [
    ["quality", 0, s.encoder === "prores_ks" ? 64 : 63],
    ["bitrate", 0, 1000000],
    ["gop", -1, 10000],
    ["bframes", -1, 16],
    ["lookahead", 0, 32],
    ["lookaheadLevel", 0, 3],
  ])
    check(
      Number.isFinite(s[k]) && s[k] >= min && s[k] <= max,
      "SETTING_NUMBER_INVALID",
      { field: k },
    );
  check(
    [64, 96, 128, 160, 192, 256, 320, 384, 512].includes(s.audioBitrate),
    "AUDIO_BITRATE_INVALID",
  );
  check(FADES.includes(s.audioFade ?? 0), "AUDIO_FADE_INVALID");
  check(typeof s.alphaMask === "boolean", "ALPHA_MASK_SWITCH_INVALID");
  check(/^#[0-9a-f]{6}$/i.test(s.alphaBackground), "ALPHA_BACKGROUND_INVALID");
  check(typeof s.hiRes === "boolean", "HIRES_SWITCH_INVALID");
  check(typeof s.editFriendly === "boolean", "EDIT_FRIENDLY_SWITCH_INVALID");
  if (s.hiRes)
    check(
      ["flac", "pcm_s16le"].includes(s.audio),
      "HIRES_AUDIO_FORMAT_INVALID",
    );
  // Copied audio keeps its packets, so it cannot be faded.
  if (s.audio === "copy") check(!s.audioFade, "AUDIO_COPY_FADE");
  check(
    typeof s.preset === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(s.preset),
    "SPEED_PRESET_INVALID",
  );
  if (s.rateControl === "bitrate") check(s.bitrate > 0, "BITRATE_REQUIRED");
  if (s.outputMode === "custom")
    check(
      typeof s.outputDir === "string" && path.isAbsolute(s.outputDir),
      "OUTPUT_DIRECTORY_INVALID",
    );
  if (eng) {
    const speedValid =
      eng.backend === "nvenc" || eng.backend === "nvencc"
        ? /^p[1-7]$/i.test(s.preset)
        : eng.backend === "qsv"
          ? /^(veryfast|faster|fast|medium|slow|slower|veryslow)$/.test(
              s.preset,
            )
          : eng.backend === "amf"
            ? ["speed", "balanced", "quality"].includes(s.preset)
            : s.encoder === "libsvtav1"
              ? /^(?:[0-9]|1[0-3])$/.test(s.preset)
              : s.encoder === "libvpx-vp9"
                ? ["ultrafast", "fast", "medium", "slow", "veryslow"].includes(
                    s.preset,
                  )
                : eng.codec === "prores" ||
                  /^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|placebo)$/.test(
                    s.preset,
                  );
    check(speedValid, "ENCODER_SPEED_INVALID");
    if (["h264", "hevc"].includes(eng.codec))
      check(s.quality <= 51, "H26X_QUALITY_INVALID");
    if (eng.codec === "prores")
      check(
        Number.isInteger(s.quality) && s.quality >= 0 && s.quality <= 64,
        "PRORES_QUALITY_INVALID",
      );
    if (["libsvtav1", "libvpx-vp9", "prores_ks"].includes(s.encoder))
      check(s.rateControl !== "qp", "ENCODER_QP_UNSUPPORTED");
    check(eng.depths.includes(s.bitDepth), "ENCODER_DEPTH_UNSUPPORTED");
    if (s.container === "webm") {
      check(["av1", "vp9"].includes(eng.codec), "WEBM_VIDEO_UNSUPPORTED");
      check(["libopus", "none"].includes(s.audio), "WEBM_AUDIO_UNSUPPORTED");
    }
    if (["mp4", "mov"].includes(s.container))
      check(
        [
          "aac",
          "copy", // whether the source's codec fits is checked per video
          "none",
          ...(s.container === "mov" ? ["pcm_s16le"] : []),
        ].includes(s.audio),
        "CONTAINER_AUDIO_UNSUPPORTED",
      );
    if (eng.codec === "prores") {
      check(
        ["mov", "mkv"].includes(s.container),
        "PRORES_CONTAINER_UNSUPPORTED",
      );
      check(
        s.bitDepth === 10 && ["422", "444"].includes(s.chroma),
        "PRORES_FORMAT_REQUIRED",
      );
    }
    if (["qsv", "amf"].includes(eng.backend) || eng.codec === "av1")
      check(s.chroma === "420", "ENCODER_CHROMA_420_REQUIRED");
    if (eng.codec === "h264" && eng.backend === "nvenc")
      check(s.chroma !== "422", "H264_NVENC_422_UNSUPPORTED");
  }
  if (s.resizeMode === "long")
    check(
      Number.isInteger(s.width) && s.width >= 2 && s.width <= 16384,
      "LONG_EDGE_INVALID",
    );
  if (s.resizeMode === "custom") {
    check(typeof s.keepAspect === "boolean", "KEEP_ASPECT_SWITCH_INVALID");
    for (const key of ["width", "height"])
      check(
        Number.isInteger(s[key]) && s[key] >= 2 && s[key] <= 16384,
        "RESOLUTION_INTEGER_INVALID",
      );
  }
  if (s.alphaMode === "preserve") {
    check(
      (s.encoder === "prores_ks" &&
        ["mov", "mkv"].includes(s.container) &&
        s.bitDepth === 10 &&
        s.chroma === "444") ||
        (s.encoder === "libvpx-vp9" &&
          ["webm", "mkv"].includes(s.container) &&
          s.bitDepth === 8 &&
          s.chroma === "420") ||
        (s.encoder === "nvencc:hevc" &&
          ["mp4", "mov", "mkv"].includes(s.container) &&
          s.bitDepth === 8 &&
          s.chroma === "420"),
      "ALPHA_FORMAT_UNSUPPORTED",
    );
  }
  if (meta) {
    if (s.vsr) {
      const size = dimensions(s, meta);
      check(
        size.width <= 16384 && size.height <= 16384,
        "VSR_OUTPUT_SIZE_INVALID",
      );
    }
    if (s.alphaMode === "preserve")
      check(meta.hasAlpha, "SOURCE_ALPHA_REQUIRED");
    const size = dimensions(s, meta);
    if (s.resizeMode !== "source")
      check(
        size.width >= 2 &&
          size.height >= 2 &&
          size.width <= 16384 &&
          size.height <= 16384,
        "OUTPUT_SIZE_INVALID",
      );
    if (s.alphaMask) check(meta.hasAlpha, "SOURCE_ALPHA_MASK_REQUIRED");
    if (s.chroma === "420" || s.alphaMask)
      check(!(size.width % 2 || size.height % 2), "CHROMA_420_EVEN_REQUIRED");
    if (s.chroma === "422")
      check(!(size.width % 2), "CHROMA_422_EVEN_REQUIRED");
  }
  return uniqueIssues(e);
}
function uniqueIssues(issues) {
  return [
    ...new Map(
      issues.map((issue) => [
        JSON.stringify([issue.code, issue.params, issue.message]),
        issue,
      ]),
    ).values(),
  ];
}
function validate(s, meta) {
  return [...new Set(validateIssues(s, meta).map((issue) => issue.message))];
}
module.exports = { filename, validate, validateIssues };
