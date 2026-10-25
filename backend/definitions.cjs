"use strict";
const DEFAULTS = {
  container: "mp4",
  encoder: "libx264",
  quality: 18,
  preset: "medium",
  presetName: "通用 MP4",
  bitDepth: 8,
  chroma: "420",
  rateControl: "quality",
  bitrate: 8000,
  fps: "source",
  resizeMode: "source",
  width: 1920,
  height: 1080,
  keepAspect: true,
  resizeAxis: "width",
  audio: "aac",
  audioBitrate: 0,
  // Seconds of fade-in at the start and fade-out at the end (0 = off).
  audioFade: 0,
  // Hi-Res audio (FLAC / PCM): 24-bit, twice the rate below 48 kHz.
  hiRes: false,
  alphaMask: false,
  alphaMode: "discard",
  // alphaMode "color": the background composited under the picture.
  alphaBackground: "#00FF00",
  outputMode: "encoded",
  outputDir: "",
  nameTemplate: "{name}",
  colorSpace: "bt709",
  colorRange: "tv",
  gop: -1,
  // A keyframe every second of output (when gop is automatic), so the result
  // can be cut losslessly (backend/trim.cjs) at short intervals.
  editFriendly: false,
  bframes: -1,
  lookahead: 0,
  lookaheadLevel: 0,
  // Enlarging: "lanczos" (FFmpeg) or "artcnn" (ArtCNN shader on the GPU
  // through libplacebo / Vulkan). RTX VSR is the separate vsr switch.
  upscaler: "lanczos",
  artcnnModel: "C4F16",
  vsr: false,
  vsrScale: 2,
  vsrQuality: 4,
  vsrStrength: 1,
  vfg: false,
  vfgMultiplier: 2,
  vfgMode: "medium",
  vfgModelDir: "",
};
// ProRes quantizer for the built-in presets and when switching to ProRes:
// measured on a 4K MMD render at about 1/5 of the default size, colour SSIM
// 0.997 against the lossless source; alpha is unaffected by the quantizer.
const PRORES_QUALITY = 12;
const ENGINES = [
  ["libx264", "H.264 · CPU", "cpu", "h264", [8, 10]],
  ["libx265", "HEVC · CPU", "cpu", "hevc", [8, 10]],
  ["libsvtav1", "AV1 · CPU", "cpu", "av1", [8, 10]],
  ["libvpx-vp9", "VP9 · CPU", "cpu", "vp9", [8, 10]],
  ["prores_ks", "ProRes · CPU", "cpu", "prores", [10]],
  ...["nvenc", "qsv", "amf"].flatMap((b) =>
    ["h264", "hevc", ...(b === "nvenc" ? ["av1"] : [])].map((c) => [
      c + "_" + b,
      (c === "h264" ? "H.264" : c.toUpperCase()) + " · " + b.toUpperCase(),
      b,
      c,
      c === "h264" ? [8] : [8, 10],
    ]),
  ),
  ...["h264", "hevc", "av1"].map((c) => [
    "nvencc:" + c,
    (c === "h264" ? "H.264" : c.toUpperCase()) + " · NVEncC",
    "nvencc",
    c,
    c === "h264" ? [8] : [8, 10],
  ]),
].map(([id, label, backend, codec, depths]) => ({
  id,
  label,
  backend,
  codec,
  depths,
}));
const BUILTINS = [
  {
    id: "builtin-mp4",
    name: "通用 MP4",
    builtin: true,
    settings: { ...DEFAULTS },
  },
  {
    id: "builtin-original",
    name: "原插件配置",
    builtin: true,
    settings: {
      ...DEFAULTS,
      container: "mkv",
      encoder: "hevc_nvenc",
      quality: 1,
      preset: "p7",
      presetName: "原插件配置",
      audio: "flac",
      bitrate: 0,
      lookahead: 16,
      lookaheadLevel: 2,
    },
  },
];
// Recommended upload presets: a hardware (NVENC CQ) and a software (x264 CRF)
// variant. Scaling uses the long edge, so landscape and portrait sources both
// come out at 3840 / 1920.
const RECOMMENDED = [
  // id, name, long edge
  ["4k", "默认 4K", 3840],
  ["1080", "默认 1080p", 1920],
];
BUILTINS.splice(
  0,
  BUILTINS.length,
  ...RECOMMENDED.flatMap(([id, label, edge]) => {
    const base = {
      ...DEFAULTS,
      resizeMode: "long",
      width: edge,
      height: Math.round((edge * 9) / 16),
      keepAspect: true,
      audioBitrate: 320,
    };
    return [
      {
        id: "builtin-" + id,
        name: label + " · 硬件",
        // p4 measured as good as p7 at ~2.4× the 4K speed.
        settings: {
          ...base,
          encoder: "h264_nvenc",
          quality: 29,
          preset: "p4",
          lookahead: 32,
          lookaheadLevel: 0,
        },
      },
      {
        id: "builtin-" + id + "-sw",
        name: label + " · 软件",
        settings: {
          ...base,
          encoder: "libx264",
          quality: 21,
          preset: "medium",
        },
      },
    ];
  }),
  // Split: the recommended hardware encoder at the source size with a higher
  // quality (CQ 19, it is meant for editing), plus a separate lossless
  // grayscale mask (smaller than lossy masks, measured) used as a luma matte.
  {
    id: "builtin-alpha-mask",
    name: "分离 Alpha · H.264 MP4",
    settings: {
      ...DEFAULTS,
      encoder: "h264_nvenc",
      container: "mp4",
      quality: 19,
      preset: "p4",
      lookahead: 32,
      lookaheadLevel: 0,
      audioBitrate: 320,
      alphaMode: "discard",
      alphaMask: true,
    },
  },
  // Transparent output at the source size for editing (After Effects etc.).
  // ProRes 4444 in MOV: HEVC alpha lives in an auxiliary layer that only Apple's
  // decoder reads, so AE on Windows imports it without transparency.
  {
    id: "builtin-alpha",
    name: "保留 Alpha · ProRes 4444",
    settings: {
      ...DEFAULTS,
      encoder: "prores_ks",
      alphaMode: "preserve",
      bitDepth: 10,
      chroma: "444",
      container: "mov",
      audio: "pcm_s16le",
      preset: "medium",
      rateControl: "quality",
      quality: PRORES_QUALITY,
      lookahead: 0,
      lookaheadLevel: 0,
    },
  },
  // Editing intermediate without alpha: ProRes 422 HQ at the source size,
  // smaller than 4444 and read by every editor.
  {
    id: "builtin-prores422",
    name: "剪辑素材 · ProRes 422 HQ",
    settings: {
      ...DEFAULTS,
      encoder: "prores_ks",
      alphaMode: "discard",
      bitDepth: 10,
      chroma: "422",
      container: "mov",
      audio: "pcm_s16le",
      preset: "medium",
      rateControl: "quality",
      quality: PRORES_QUALITY,
      lookahead: 0,
      lookaheadLevel: 0,
    },
  },
);
for (const p of BUILTINS) {
  p.builtin = true;
  p.settings = { ...p.settings, presetName: p.name };
}

module.exports = { DEFAULTS, PRORES_QUALITY, ENGINES, BUILTINS };
