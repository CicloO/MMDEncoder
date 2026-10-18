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
// Pick MP4 only when the copied video and the output audio both fit in it.
function mergeContainer(p, source = {}) {
  if (p.container !== "mp4") return "mkv";
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
  const args = ["-hide_banner", "-nostdin", "-n", "-i", p.input];
  if (p.operation === "merge") args.push("-i", p.audioInput);
  if (p.operation === "audio")
    args.push("-map", "0:a:0", "-vn", "-c:a", audio[0]);
  else
    args.push(
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      ...(p.operation === "merge"
        ? ["-map", "1:a:0", "-c:a", audio[0]]
        : ["-an"]),
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
  command,
  suggestOutput,
  audioBitrate,
  mergeContainer,
  EXTENSIONS,
};
