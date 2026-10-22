const path = require("node:path");
// Audio codecs that store every sample exactly; "follow source" bitrate uses 320k for these.
const LOSSLESS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|truehd$|mlp$)/;
const BITRATE_LIMITS = { aac: 512, libopus: 512, libmp3lame: 320 };
// Codecs MP4 can hold; anything else falls back to MKV so the copy never fails.
const MP4_VIDEO = ["h264", "hevc", "av1", "vp9", "mpeg4"];
const MP4_AUDIO = ["aac", "mp3", "opus", "flac", "alac", "ac3", "eac3"];
// Resolve "follow source" (0) to a concrete kbps for a lossy target codec.
function audioBitrate(requested, encoder, source = {}) {
  const max = BITRATE_LIMITS[encoder] || 320;
  let kbps = Number(requested) || 0;
  if (!kbps)
    kbps = LOSSLESS.test(source.codec || "")
      ? 320
      : Math.round(Number(source.bitRate) / 1000) || 320;
  return Math.min(max, Math.max(32, kbps));
}
// Hi-Res output: 24-bit, and twice the sample rate when the source is below
// 48 kHz (44.1 → 88.2 kHz, 32 → 64 kHz); 48 kHz and above keep their rate.
// Upsampling adds no information; it only meets platforms' Hi-Res check.
// source: { codec, sampleRate, bits (effective, 0 = unknown), float }.
// Returns { action: "copy" | "encode" | "resample", codec, rate, from, reason }.
const HIRES_FORMATS = { wav: "pcm_s24le", flac: "flac" };
function hiResPlan(format, source = {}) {
  const codec = HIRES_FORMATS[format];
  if (!codec) throw Error("Hi-Res 只支持 WAV / FLAC 输出");
  const sr = Number(source.sampleRate) || 0;
  if (!sr) throw Error("读不到源音频的采样率，无法按 Hi-Res 输出");
  const rate = sr < 48000 ? sr * 2 : sr;
  const bits = Number(source.bits) || 0;
  const from = `${sr / 1000} kHz / ${source.float ? "浮点" : bits ? bits + "-bit" : "位深未知"}`;
  const to = `${rate / 1000} kHz / 24-bit`;
  // Same 24-bit codec at the target rate: the samples go across untouched.
  const same =
    rate === sr &&
    !source.float &&
    bits === 24 &&
    (source.codec === codec || (codec === "flac" && source.codec === "flac"));
  if (same)
    return {
      action: "copy",
      codec,
      rate,
      from,
      to,
      reason: "源音频已是 24-bit，直接复制",
    };
  const reduce = source.float || bits > 24;
  return {
    action: rate !== sr ? "resample" : "encode",
    codec,
    rate,
    from,
    to,
    // 32-bit and floating-point sources are reduced to 24-bit with dither.
    dither: reduce,
    reason:
      rate !== sr
        ? `源低于 48 kHz，升到 ${rate / 1000} kHz`
        : reduce
          ? "降为 24-bit（加抖动）"
          : "无损转为 24-bit",
  };
}
// Audio options for a Hi-Res plan; soxr is FFmpeg's best resampler when the
// installed build has it, otherwise its own resampler at high quality.
// Audio fade-in and fade-out lengths offered on every page (seconds, 0 = off).
const FADES = [0, 0.5, 1, 2];
// afade filters for a fade in at the start and out at the end of `length`
// seconds of audio, each at most half of it; "" when there is nothing to do.
function fadeFilter(fade, length) {
  const d = Math.min(Number(fade) || 0, (Number(length) || 0) / 2);
  if (!(d > 0)) return "";
  return `afade=t=in:st=0:d=${d},afade=t=out:st=${(length - d).toFixed(6)}:d=${d}`;
}
// Codec arguments with one more audio filter: joined into an existing -af
// (the fade first, then any resampling) or added as a new one.
function withAudioFilter(args, filter) {
  if (!filter) return args;
  const i = args.indexOf("-af");
  if (i < 0) return ["-af", filter, ...args];
  const out = args.slice();
  out[i + 1] = filter + "," + out[i + 1];
  return out;
}
function hiResArgs(plan, soxr) {
  if (plan.action === "copy") return ["-c:a", "copy"];
  const filter = hiResFilter(plan, soxr);
  return [...(filter ? ["-af", filter] : []), ...hiResCodec(plan)];
}
// The resampling / dither filter, or "" when the samples need neither (a
// same-rate, same-precision conversion).
function hiResFilter(plan, soxr) {
  if (plan.action !== "resample" && !plan.dither) return "";
  const resampler = soxr
    ? "resampler=soxr:precision=28"
    : "filter_size=128:phase_shift=10:cutoff=0.97";
  return `aresample=${plan.rate}:${resampler}${plan.dither ? ":dither_method=triangular" : ""}`;
}
function hiResCodec(plan) {
  return [
    "-c:a",
    plan.codec,
    ...(plan.codec === "flac"
      ? ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
      : []),
    "-ar",
    String(plan.rate),
  ];
}
// Pick MP4 only when the copied video and the output audio both fit in it.
function mergeContainer(p, source = {}) {
  if (p.container !== "mp4") return "mkv";
  // Hi-Res FLAC in MP4 is not known to pass platforms' checks: use MKV.
  if (p.operation === "merge" && p.hiRes) return "mkv";
  if (source.videoCodec && !MP4_VIDEO.includes(source.videoCodec)) return "mkv";
  if (p.operation === "merge") {
    if (p.audioFormat === "wav") return "mkv";
    if (
      p.audioFormat === "copy" &&
      source.audioCodec &&
      !MP4_AUDIO.includes(source.audioCodec)
    )
      return "mkv";
  }
  return "mp4";
}
function command(p, tools, output) {
  if (!["audio", "video", "merge"].includes(p.operation))
    throw Error("请选择提取音频、提取视频或音视频合并");
  for (const value of [
    p.input,
    ...(p.operation === "merge" ? [p.audioInput] : []),
    p.output,
  ])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw Error("请选择有效的输入文件与绝对输出路径");
  if (
    [p.input, p.audioInput]
      .filter(Boolean)
      .some(
        (v) =>
          path.resolve(v).toLowerCase() ===
          path.resolve(p.output).toLowerCase(),
      )
  )
    throw Error("输出不能覆盖输入文件");
  const audio = {
    wav: ["pcm_s16le", "wav"],
    flac: ["flac", "flac"],
    aac: ["aac", "m4a"],
    opus: ["libopus", "opus"],
    mp3: ["libmp3lame", "mp3"],
    copy: ["copy", "mka"],
  }[p.audioFormat || "wav"];
  if (!audio) throw Error("音频格式无效");
  const ext = path.extname(p.output).toLowerCase();
  if (p.operation === "audio" && ext !== "." + audio[1])
    throw Error("所选音频格式需要 ." + audio[1] + " 输出文件");
  if (
    ["merge", "video"].includes(p.operation) &&
    ![".mkv", ".mp4"].includes(ext)
  )
    throw Error("视频提取 / 合并使用 .mp4 或 .mkv 输出");
  const hiRes = p.hiRes && p.operation !== "video";
  const fade = p.operation === "video" ? 0 : Number(p.fade) || 0;
  if (fade && p.audioFormat === "copy")
    throw Error("复制原音轨时不能淡入淡出，请改为重新编码的格式");
  const plan = hiRes && hiResPlan(p.audioFormat, p.sourceAudio);
  let codecArgs = hiRes
    ? // A fade means re-encoding even when Hi-Res would copy.
      fade && plan.action === "copy"
      ? hiResCodec(plan)
      : hiResArgs(plan, p.soxr)
    : ["-c:a", audio[0]];
  codecArgs = withAudioFilter(codecArgs, fadeFilter(fade, p.fadeLength));
  const args = ["-hide_banner", "-nostdin", "-n", "-i", p.input];
  if (p.operation === "merge") args.push("-i", p.audioInput);
  if (p.operation === "audio") args.push("-map", "0:a:0", "-vn", ...codecArgs);
  else
    args.push(
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      ...(p.operation === "merge" ? ["-map", "1:a:0", ...codecArgs] : ["-an"]),
    );
  if (
    ["aac", "libopus", "libmp3lame"].includes(audio[0]) &&
    p.operation !== "video"
  )
    args.push(
      "-b:a",
      audioBitrate(p.audioBitrate, audio[0], p.sourceAudio) + "k",
    );
  if (p.operation === "merge" && p.shortest !== false) args.push("-shortest");
  if (ext === ".mp4") args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", output);
  return { exe: tools.ffmpeg, args };
}
const EXTENSIONS = {
  wav: "wav",
  flac: "flac",
  aac: "m4a",
  opus: "opus",
  mp3: "mp3",
  copy: "mka",
};
// Default output beside the source, following the video page's output location
// (source folder, its Encoded subfolder, or the custom folder) and never reusing a name.
function suggestOutput(p, settings, exists) {
  if (typeof p.input !== "string" || !path.isAbsolute(p.input)) return "";
  const ext =
    p.operation === "audio"
      ? EXTENSIONS[p.audioFormat] || "wav"
      : p.container === "mp4"
        ? "mp4"
        : "mkv";
  const suffix = { audio: "", video: "_无音频", merge: "_合并" }[p.operation];
  if (suffix === undefined) return "";
  let dir = path.dirname(p.input);
  if (settings.outputMode === "encoded") dir = path.join(dir, "Encoded");
  if (settings.outputMode === "custom" && settings.outputDir)
    dir = settings.outputDir;
  const base = path.parse(p.input).name + suffix;
  const inputs = [p.input, p.audioInput]
    .filter(Boolean)
    .map((f) => path.resolve(f).toLowerCase());
  for (let n = 1; n < 100000; n++) {
    const output = path.join(
      dir,
      base + (n === 1 ? "" : ` (${n})`) + "." + ext,
    );
    if (!inputs.includes(output.toLowerCase()) && !exists(output))
      return output;
  }
  throw Error("无法分配不重名的输出文件");
}
module.exports = {
  FADES,
  fadeFilter,
  withAudioFilter,
  hiResPlan,
  hiResArgs,
  hiResFilter,
  hiResCodec,
  command,
  suggestOutput,
  audioBitrate,
  mergeContainer,
  EXTENSIONS,
};
