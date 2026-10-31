"use strict";
const { dimensions } = require("./filter.cjs");
const { summary } = require("./errors.cjs");
const MASK_FORMATS = ["lossless", "gpu-lossy", "x264-lossy"];
const VP9_MASK_CRF = 18;
// Mask parameters never inherit the colour encoder's quality or speed.
function maskSettings(s, encoder) {
  const lossless = (s.maskFormat ?? "lossless") === "lossless";
  const codec = encoder || (s.container === "webm" ? "libvpx-vp9" : "libx264");
  return {
    ...s,
    encoder: codec,
    alphaMode: "discard",
    alphaMask: false,
    audio: "none",
    bitDepth: 8,
    chroma: "420",
    quality: lossless
      ? 0
      : codec === "libvpx-vp9"
        ? VP9_MASK_CRF
        : codec === "hevc_nvenc"
          ? 22
          : codec === "h264_nvenc"
            ? 19
            : 18,
    // Lossless x264: veryfast is ~30% quicker than medium for ~7% more size
    // (4K MMD mask, docs/编码器实测对比.md); VP9 was not measured.
    preset: codec.endsWith("_nvenc")
      ? "p4"
      : s.container === "webm"
        ? "medium"
        : "veryfast",
    rateControl: "quality",
    lookahead: 0,
    lookaheadLevel: 0,
    bframes: -1,
    gop: -1,
  };
}
// The mask on the GPU when this machine's NVENC does lossless H.264
// (engines.nvencLossless, checked with the encoder detection): the frames
// are identical to x264's lossless ones, in the same High 4:4:4 Predictive
// profile, at about twice the speed. NVENC takes 145 × 49 to 4096 × 4096
// pixels; WebM masks stay VP9.
function maskOnNvenc(s, meta, engines) {
  if (
    !engines?.nvencLossless ||
    engines.allowGpuMask === false ||
    s.container === "webm"
  )
    return false;
  return gpuDimensions(s, meta);
}
function gpuDimensions(s, meta) {
  const size = dimensions(s, meta);
  return (
    size.width >= 145 &&
    size.height >= 49 &&
    size.width <= 4096 &&
    size.height <= 4096
  );
}
// These are already trial-encoded FFmpeg IDs, supplied by the queue owner.
// Do not probe or infer capability from the selected colour encoder.
function withMaskCapabilities(info, available) {
  return {
    ...info,
    maskEncoders: available
      .filter((e) => ["hevc_nvenc", "h264_nvenc"].includes(e.id))
      .map((e) => e.id),
  };
}
function maskChoice(s, meta, info = {}) {
  const format = s.maskFormat ?? "lossless";
  if (format === "lossless") {
    const gpu = maskOnNvenc(s, meta, info);
    return {
      format,
      settings: maskSettings(s),
      gpu,
      encoder: gpu
        ? "h264_nvenc"
        : s.container === "webm"
          ? "libvpx-vp9"
          : "libx264",
      ...(gpu ? { options: NVENC_LOSSLESS } : {}),
    };
  }
  if (s.container === "webm" || format === "x264-lossy")
    return {
      format,
      settings: maskSettings(s),
      gpu: false,
      encoder: s.container === "webm" ? "libvpx-vp9" : "libx264",
    };
  const available = info.allowGpuMask === false ? [] : info.maskEncoders || [];
  const encoder = ["hevc_nvenc", "h264_nvenc"].find((id) =>
    available.includes(id),
  );
  if (encoder && gpuDimensions(s, meta))
    return { format, settings: maskSettings(s, encoder), gpu: true, encoder };
  return {
    format,
    settings: maskSettings(s),
    gpu: false,
    encoder: "libx264",
    note: summary(encoder ? "MASK_GPU_SIZE_FALLBACK" : "MASK_GPU_UNAVAILABLE"),
  };
}
const NVENC_LOSSLESS = [
  "-c:v",
  "h264_nvenc",
  "-preset",
  "p1",
  "-tune",
  "lossless",
  "-pix_fmt",
  "yuv420p",
];

module.exports = {
  MASK_FORMATS,
  VP9_MASK_CRF,
  maskSettings,
  maskOnNvenc,
  maskChoice,
  withMaskCapabilities,
  NVENC_LOSSLESS,
};
