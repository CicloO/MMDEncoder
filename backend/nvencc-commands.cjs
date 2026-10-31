"use strict";
const { filter, pix, vsrPrepare, dimensions } = require("./filter.cjs");
const { stage } = require("./errors.cjs");
// Pure NVEncC command assembly; process execution belongs to the runner.
function nvenccCommands({
  s,
  meta,
  ffmpeg,
  nvencc,
  base,
  output,
  audio,
  audioSource,
  colors,
  tag,
}) {
  // FFmpeg applies the filters and hands NVEncC raw frames through a
  // pipe (NUT keeps each frame's time and the alpha plane), so no
  // intermediate file is written. Audio is taken from the source when
  // the result is packaged.
  const prepare = {
    exe: ffmpeg,
    args: [
      ...base,
      "-map",
      "0:v:0",
      "-vf",
      filter(s.vsr ? vsrPrepare(s) : s, meta || {}, false),
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      s.alphaMode === "preserve" ? "yuva444p" : pix(s),
      "-an",
      ...colors,
      "-fps_mode",
      "passthrough",
      "-nostats",
      "-f",
      "nut",
      "-",
    ],
  };
  const a = [
    "--avsw",
    "--input-format",
    "nut",
    "-i",
    "-",
    "-o",
    "-",
    // Streaming Matroska retains the old MKV timestamps. NVEncC's NUT
    // muxer shifts the first PTS by two frames with B-frames (live probe).
    "--output-format",
    "matroska",
    "--codec",
    s.encoder.split(":")[1],
    "--output-depth",
    String(s.bitDepth),
    "--output-csp",
    (s.alphaMode === "preserve" ? "yuva" : "yuv") + s.chroma,
    "--preset",
    /^p[1-7]$/i.test(s.preset) ? s.preset.toUpperCase() : s.preset,
    "--avsync",
    "vfr",
    "--colormatrix",
    s.colorSpace === "bt601"
      ? "smpte170m"
      : s.colorSpace === "bt2020"
        ? "bt2020nc"
        : "bt709",
  ];
  if (s.alphaMode === "preserve") a.push("--alpha-channel-mode", "straight");
  if (s.vsr) {
    const size = dimensions(s, meta);
    a.push(
      "--output-res",
      `${size.width}x${size.height}`,
      "--vpp-resize",
      `algo=ngx-vsr,vsr-quality=${s.vsrQuality},vsr-strength=${s.vsrStrength}`,
    );
  }
  if (s.vfg) {
    a.push(
      "--vpp-nvvfx-framegen",
      `mode=${s.vfgMode},multiplier=${s.vfgMultiplier}`,
    );
    if (s.vfgModelDir) a.push("--vpp-nvvfx-model-dir", s.vfgModelDir);
  }
  a.push(
    ...(s.rateControl === "qp"
      ? ["--cqp", String(s.quality)]
      : [
          "--vbr",
          s.rateControl === "quality" ? "0" : String(s.bitrate),
          ...(s.rateControl === "quality"
            ? ["--vbr-quality", String(s.quality)]
            : []),
        ]),
  );
  if (s.lookahead) {
    a.push("--lookahead", String(s.lookahead));
    if (s.encoder !== "nvencc:h264")
      a.push("--lookahead-level", String(s.lookaheadLevel));
  }
  if (s.gop >= 0) a.push("--gop-len", String(s.gop));
  if (s.bframes >= 0) a.push("--bframes", String(s.bframes));
  return [
    {
      exe: nvencc,
      args: a,
      pipeFrom: prepare,
      stage: stage("nvencc_encoding_muxing"),
      pipeTo: {
        exe: ffmpeg,
        args: [
          "-hide_banner",
          "-nostdin",
          "-n",
          "-f",
          "matroska",
          "-i",
          "-",
          ...audioSource,
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          // The source's (or replacement) audio, encoded as set (input 1).
          ...audio.map((x) => (x === "0:a:0?" ? "1:a:0?" : x)),
          ...colors,
          "-metadata",
          "comment=" + tag,
          ...(["mp4", "mov"].includes(s.container)
            ? ["-movflags", "+faststart"]
            : []),
          "-progress",
          "pipe:1",
          output,
        ],
      },
      output,
    },
  ];
}
module.exports = { nvenccCommands };
