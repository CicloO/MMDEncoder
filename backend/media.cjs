const { appError, sourceText } = require("./errors.cjs");
const path = require("node:path");
// Audio codecs that store every sample exactly; "follow source" bitrate uses 320k for these.
const LOSSLESS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|truehd$|mlp$)/;
const BITRATE_LIMITS = { aac: 512, libopus: 512, libmp3lame: 320 };
// Codecs MP4 can hold; anything else falls back to MKV so the copy never fails.
const MP4_VIDEO = ["h264", "hevc", "av1", "vp9", "mpeg4"];
const MP4_AUDIO = ["aac", "mp3", "opus", "flac", "alac", "ac3", "eac3"];
// Audio a container can hold as copied (ffprobe codec names; MKV holds all).
function copyFits(container, codec) {
  if (!codec) return true;
  if (container === "mp4") return MP4_AUDIO.includes(codec);
  if (container === "mov")
    return (
      ["aac", "mp3", "alac", "ac3", "eac3"].includes(codec) ||
      codec.startsWith("pcm_")
    );
  if (container === "webm") return ["opus", "vorbis"].includes(codec);
  return true;
}
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
  if (!codec) throw appError("MEDIA_HIRES_FORMAT");
  const sr = Number(source.sampleRate) || 0;
  if (!sr) throw appError("MEDIA_SAMPLE_RATE");
  const rate = sr < 48000 ? sr * 2 : sr;
  const bits = Number(source.bits) || 0;
  const from = sourceText("media.hiresFrom", {
    rate: sr / 1000,
    depth: source.float
      ? sourceText("media.hiresFloat")
      : bits
        ? bits + "-bit"
        : sourceText("media.hiresUnknownDepth"),
  });
  const to = sourceText("media.hiresTo", { rate: rate / 1000 });
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
      reason: sourceText("media.hiresCopyReason"),
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
        ? sourceText("media.hiresResampleReason", { rate: rate / 1000 })
        : reduce
          ? sourceText("media.hiresDitherReason")
          : sourceText("media.hiresEncodeReason"),
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
// 音频对齐: line the audio up with a reference. offset > 0 drops that much
// from its start, offset < 0 puts that much silence before it, both counted
// in samples at the source's rate; length ends the result there (silence
// fills in if the audio runs out first).
function alignFilter(a, rate) {
  const n = Math.round(Math.abs(a.offset) * (Number(rate) || 48000));
  const f = [];
  if (a.offset > 0 && n)
    f.push(`atrim=start_sample=${n}`, "asetpts=PTS-STARTPTS");
  else if (a.offset < 0 && n) f.push(`adelay=delays=${n}S:all=1`);
  if (a.length > 0)
    f.push(
      `apad=whole_dur=${a.length.toFixed(6)}`,
      `atrim=end=${a.length.toFixed(6)}`,
    );
  return f.join(",");
}
function command(p, tools, output) {
  if (!["audio", "video", "merge"].includes(p.operation))
    throw appError("MEDIA_OPERATION");
  for (const value of [
    p.input,
    ...(p.operation === "merge" ? [p.audioInput] : []),
    p.output,
  ])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw appError("MEDIA_PATHS");
  if (
    [p.input, p.audioInput]
      .filter(Boolean)
      .some(
        (v) =>
          path.resolve(v).toLowerCase() ===
          path.resolve(p.output).toLowerCase(),
      )
  )
    throw appError("MEDIA_OVERWRITE");
  const audio = {
    wav: ["pcm_s16le", "wav"],
    flac: ["flac", "flac"],
    aac: ["aac", "m4a"],
    opus: ["libopus", "opus"],
    mp3: ["libmp3lame", "mp3"],
    copy: ["copy", "mka"],
  }[p.audioFormat || "wav"];
  if (!audio) throw appError("MEDIA_AUDIO_FORMAT");
  const ext = path.extname(p.output).toLowerCase();
  if (p.operation === "audio" && ext !== "." + audio[1])
    throw appError("MEDIA_AUDIO_EXTENSION", { extension: audio[1] });
  if (
    ["merge", "video"].includes(p.operation) &&
    ![".mkv", ".mp4"].includes(ext)
  )
    throw appError("MEDIA_VIDEO_EXTENSION");
  const hiRes = p.hiRes && p.operation !== "video";
  const fade = p.operation === "video" ? 0 : Number(p.fade) || 0;
  if (fade && p.audioFormat === "copy") throw appError("MEDIA_COPY_FADE");
  const plan = hiRes && hiResPlan(p.audioFormat, p.sourceAudio);
  let codecArgs = hiRes
    ? // Padding/trimming a merge also needs decoded samples.
      (fade || p.operation === "merge") && plan.action === "copy"
      ? hiResCodec(plan)
      : hiResArgs(plan, p.soxr)
    : ["-c:a", audio[0]];
  // Output duration belongs to the video. Copied audio may end earlier;
  // re-encoded audio is padded and trimmed to the video's duration.
  const merge = p.operation === "merge";
  const pad = merge && p.audioFormat !== "copy";
  // Extracting: p.align (with a reference length); merging: p.audioOffset
  // for the added audio (it then lasts as long as the video, as above).
  const aligned =
    p.operation === "audio"
      ? p.align
      : merge && (p.audioOffset || pad)
        ? {
            offset: Number(p.audioOffset) || 0,
            length: Number(p.videoDuration) || 0,
          }
        : null;
  if (aligned && p.audioFormat === "copy") throw appError("MEDIA_COPY_ALIGN");
  codecArgs = withAudioFilter(
    codecArgs,
    [
      aligned ? alignFilter(aligned, p.sourceAudio?.sampleRate) : "",
      fadeFilter(fade, p.fadeLength),
      pad && !(Number(p.videoDuration) > 0) ? "apad" : "",
    ]
      .filter(Boolean)
      .join(","),
  );
  const args = ["-hide_banner", "-nostdin", "-n", "-i", p.input];
  if (merge) args.push("-i", p.audioInput);
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
  if (merge && Number(p.videoDuration) > 0)
    args.push("-t", Number(p.videoDuration).toFixed(6));
  else if (pad) args.push("-shortest");
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
  const suffix = { audio: "", video: "_no_audio", merge: "_merged" }[
    p.operation
  ];
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
  throw appError("MEDIA_NAME_EXHAUSTED");
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
  copyFits,
  alignFilter,
  EXTENSIONS,
};
