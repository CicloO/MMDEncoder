"use strict";
const { dimensions } = require("./filter.cjs");
// How the black-and-white mask is encoded: lossless x264 (VP9 in WebM), no audio.
function maskSettings(s) {
  return {
    ...s,
    encoder: s.container === "webm" ? "libvpx-vp9" : "libx264",
    alphaMode: "discard",
    alphaMask: false,
    audio: "none",
    bitDepth: 8,
    chroma: "420",
    quality: 0,
    // Lossless x264: veryfast is ~30% quicker than medium for ~7% more size
    // (4K MMD mask, docs/编码器实测对比.md); VP9 was not measured.
    preset: s.container === "webm" ? "medium" : "veryfast",
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
  if (!engines?.nvencLossless || s.container === "webm") return false;
  const size = dimensions(s, meta);
  return (
    size.width >= 145 &&
    size.height >= 49 &&
    size.width <= 4096 &&
    size.height <= 4096
  );
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

module.exports = { maskSettings, maskOnNvenc, NVENC_LOSSLESS };
