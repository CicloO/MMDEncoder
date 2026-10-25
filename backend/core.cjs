"use strict";
const path = require("node:path");
const { streamDuration } = require("./audio-timing.mjs");
const {
  parseFps,
  dimensions,
  usesArtcnn,
  artcnnSkipped,
} = require("./filter.cjs");
const {
  DEFAULTS,
  PRORES_QUALITY,
  ENGINES,
  BUILTINS,
} = require("./definitions.cjs");
const {
  filename,
  validate,
  validateIssues,
} = require("./settings-validation.cjs");
const { compatibility } = require("./compatibility.cjs");
const {
  joinMask,
  singlePass,
  encodeTag,
  readTag,
  inputArgs,
  buildCommands,
} = require("./commands.cjs");
function outputPaths(
  input,
  s,
  index = 1,
  exists = () => false,
  date = new Date(),
) {
  const p = /^[a-z]:[\\/]/i.test(input) ? path.win32 : path;
  let dir = p.dirname(input);
  if (s.outputMode === "encoded") dir = p.join(dir, "Encoded");
  if (s.outputMode === "custom") dir = s.outputDir;
  const base = filename(
    s.nameTemplate.replace(
      /\{(name|preset|date|index)\}/g,
      (_, k) =>
        ({
          name: p.parse(input).name,
          preset: s.presetName || "自定义设置",
          date: [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
          ].join("-"),
          index: String(index),
        })[k],
    ),
  );
  const maskOnly = s.alphaMode === "mask";
  for (let n = 1; n < 100000; n++) {
    const stem = base + (n === 1 ? "" : ` (${n})`);
    // Mask only: the mask is the one output, still named with the _alpha suffix.
    const output = p.join(
        dir,
        stem + (maskOnly ? "_alpha." : ".") + s.container,
      ),
      maskOutput =
        s.alphaMask && !maskOnly
          ? p.join(dir, stem + "_alpha." + s.container)
          : undefined;
    if (
      output.toLowerCase() === input.toLowerCase() ||
      maskOutput?.toLowerCase() === input.toLowerCase() ||
      exists(output) ||
      (maskOutput && exists(maskOutput))
    )
      continue;
    return { output, maskOutput };
  }
  throw Error("无法分配不重名的输出文件");
}
const { quote, commandText } = require("./command-text.cjs");
// Audio stream summary. MKV often has no stream bit_rate; mkvmerge writes a
// BPS tag instead. Lossless / PCM streams may report none at all (0).
function audioInfo(a) {
  return {
    codec: a.codec_name,
    profile: a.profile && a.profile !== "unknown" ? a.profile : undefined,
    sampleRate: Number(a.sample_rate),
    channels: a.channels,
    channelLayout: a.channel_layout,
    bitRate: Number(a.bit_rate || a.tags?.BPS || a.tags?.["BPS-eng"]) || 0,
    // Effective bits per sample (0 = unknown). s32 storage alone does not
    // say 32 bits: FLAC stores 24-bit audio as s32 with bits_per_raw_sample 24.
    bits:
      Number(a.bits_per_raw_sample) ||
      Number(a.bits_per_sample) ||
      { u8: 8, u8p: 8, s16: 16, s16p: 16 }[a.sample_fmt] ||
      0,
    float: /^(flt|dbl)/.test(a.sample_fmt || ""),
  };
}
function metadata(data) {
  const v = data.streams?.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  if (!v) throw Error("未找到视频轨");
  const a = data.streams.find((s) => s.codec_type === "audio");
  const frac = (s) => {
    const [n, d = 1] = String(s || "0")
      .split("/")
      .map(Number);
    return d ? n / d : 0;
  };
  const fpsText =
    v.avg_frame_rate && frac(v.avg_frame_rate)
      ? v.avg_frame_rate
      : v.r_frame_rate;
  const pixFmt = v.pix_fmt || "未知";
  const depth =
    Number(v.bits_per_raw_sample) ||
    Number(pixFmt.match(/^p[024](10|12|16)(?:le|be)$/)?.[1]) ||
    Number(pixFmt.match(/f(16|32)(?:le|be)$/)?.[1]) ||
    (/^(?:x2rgb10|x2bgr10|y210)/.test(pixFmt) ? 10 : 0) ||
    Number(pixFmt.match(/(?:p|gray)(\d{2})(?:le|be)?$/)?.[1]) ||
    (/(?:rgba64|bgra64|rgb48|bgr48|gbrap16)/.test(pixFmt) ? 16 : 8);
  const duration = Number(data.format?.duration || v.duration) || 0;
  const videoDuration = streamDuration(v, duration);
  return {
    width: v.width,
    height: v.height,
    fps: frac(fpsText),
    fpsText,
    duration,
    // Preserve the existing file duration; only differing video lengths
    // need an additional value for replacement audio bounds.
    ...(Math.abs(videoDuration - duration) > 0.000001 ? { videoDuration } : {}),
    size: Number(data.format?.size) || 0,
    codec: v.codec_name || "未知",
    pixFmt,
    bitDepth: depth,
    hasAlpha:
      /^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya\d|ayuv)/.test(pixFmt) ||
      v.tags?.alpha_mode === "1",
    vfr: !!(
      frac(v.avg_frame_rate) &&
      frac(v.r_frame_rate) &&
      Math.abs(frac(v.avg_frame_rate) - frac(v.r_frame_rate)) > 0.01
    ),
    colorRange: v.color_range,
    colorSpace: v.color_space,
    videoBitRate: videoBitRate(data, v),
    audio: a ? audioInfo(a) : undefined,
  };
}
// Video stream bitrate (bit/s): the stream's own value, MKV's BPS tag, or the
// container's overall rate minus the audio; 0 when none is known.
function videoBitRate(data, v) {
  const own = Number(v.bit_rate || v.tags?.BPS || v.tags?.["BPS-eng"]);
  if (own) return own;
  const total = Number(data.format?.bit_rate);
  if (!total) return 0;
  const audio = data.streams
    .filter((s) => s.codec_type === "audio")
    .reduce((sum, s) => sum + (audioInfo(s).bitRate || 0), 0);
  return total - audio > 0 ? total - audio : 0;
}
module.exports = {
  joinMask,
  singlePass,
  PRORES_QUALITY,
  encodeTag,
  readTag,
  inputArgs,
  audioInfo,
  compatibility,
  DEFAULTS,
  dimensions,
  ENGINES,
  BUILTINS,
  parseFps,
  validate,
  validateIssues,
  outputPaths,
  quote,
  commandText,
  metadata,
  buildCommands,
  usesArtcnn,
  artcnnSkipped,
};
