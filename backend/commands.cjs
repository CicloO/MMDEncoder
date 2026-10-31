"use strict";
const { appError, validationError, stage } = require("./errors.cjs");
// Pure encoding options, pipeline construction and recording tags. The caller
// supplies settings, source metadata, engine paths and allocated output paths.
const media = require("./media.cjs");
const { nvenccCommands } = require("./nvencc-commands.cjs");
const { ENGINES } = require("./definitions.cjs");
const { parseFps, pix, usesArtcnn, filter } = require("./filter.cjs");
const { validateIssues } = require("./settings-validation.cjs");
const { maskChoice } = require("./mask-settings.cjs");
const { frameOffset } = require("./audio-alignment.cjs");
const { sequenceDuration } = require("./audio-timing.mjs");
const replacementOffset = (job) =>
  frameOffset(
    Number(job.audioOffset) || 0,
    job.audioShiftFrames ?? 0,
    job.sequence?.fpsText ||
      job.sequence?.fps ||
      job.meta?.fpsText ||
      job.meta?.fps,
  );
const replacementDuration = (job) =>
  sequenceDuration(job.sequence) ||
  Number(job.meta?.videoDuration ?? job.meta?.duration) ||
  0;
function videoOptions(s) {
  const e = ENGINES.find((x) => x.id === s.encoder);
  const a = ["-c:v", s.encoder, "-pix_fmt", pix(s)];
  if (e.codec === "prores") {
    a.push("-profile:v", s.chroma === "444" ? "4" : "3");
    // Quantizer 1–64 (smaller = better); 0 leaves the encoder's default rate,
    // about 4× the size of quantizer 8 for MMD footage at similar quality.
    if (s.quality > 0) a.push("-qscale:v", String(s.quality));
  } else if (e.backend === "nvenc") {
    a.push("-preset", s.preset.toLowerCase());
    if (s.rateControl === "quality")
      a.push("-rc", "vbr", "-cq", String(s.quality), "-b:v", "0");
    else if (s.rateControl === "qp")
      a.push("-rc", "constqp", "-qp", String(s.quality));
    else a.push("-rc", "vbr", "-b:v", s.bitrate + "k");
    a.push("-rc-lookahead", String(s.lookahead));
    // H.264 NVENC 不支持前向分析级别（只有 HEVC / AV1 支持），界面上也已禁用
    if (s.lookaheadLevel && e.codec !== "h264")
      a.push("-lookahead_level", String(s.lookaheadLevel));
  } else if (e.backend === "qsv") {
    a.push(
      "-preset",
      /^(veryfast|faster|fast|medium|slow|slower|veryslow)$/.test(s.preset)
        ? s.preset
        : "medium",
    );
    a.push(
      ...(s.rateControl === "bitrate"
        ? ["-b:v", s.bitrate + "k"]
        : ["-global_quality", String(s.quality)]),
    );
  } else if (e.backend === "amf") {
    a.push(
      "-quality",
      ["speed", "balanced", "quality"].includes(s.preset)
        ? s.preset
        : "balanced",
    );
    if (s.rateControl === "bitrate")
      a.push("-rc", "vbr_peak", "-b:v", s.bitrate + "k");
    else
      a.push(
        "-rc",
        "cqp",
        "-qp_i",
        String(s.quality),
        "-qp_p",
        String(s.quality),
      );
  } else {
    // Closed GOP: x265 defaults to open GOP, whose keyframes cannot start a
    // lossless cut; closing it costs about 0.1–0.4% (docs/开发计划.md).
    if (s.encoder === "libx265") a.push("-x265-params", "open-gop=0");
    if (["libx264", "libx265"].includes(s.encoder))
      a.push(
        "-preset",
        /^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|placebo)$/.test(
          s.preset,
        )
          ? s.preset
          : "medium",
      );
    if (s.encoder === "libsvtav1")
      a.push("-preset", /^\d+$/.test(s.preset) ? s.preset : "6");
    if (s.rateControl === "bitrate") a.push("-b:v", s.bitrate + "k");
    else
      a.push(
        s.rateControl === "qp" && ["libx264", "libx265"].includes(s.encoder)
          ? "-qp"
          : "-crf",
        String(s.quality),
      );
    if (s.encoder === "libvpx-vp9")
      a.push(
        "-deadline",
        "good",
        "-cpu-used",
        String(
          { ultrafast: 8, fast: 6, medium: 4, slow: 2, veryslow: 0 }[
            s.preset
          ] ?? 4,
        ),
      );
    if (s.encoder === "libvpx-vp9" && s.rateControl !== "bitrate")
      a.push("-b:v", "0");
  }
  if (s.gop >= 0) a.push("-g", String(s.gop));
  if (s.bframes >= 0) a.push("-bf", String(s.bframes));
  return a;
}
// The source as FFmpeg input options: a file, or a PNG sequence read by the
// image2 demuxer at the frame rate the user gave it (job.sequence).
function inputArgs(job) {
  const q = job.sequence;
  return q
    ? [
        "-f",
        "image2",
        "-framerate",
        String(q.fpsText || q.fps),
        "-start_number",
        String(q.start),
        "-i",
        q.pattern,
      ]
    : ["-i", job.path];
}
// A replacement audio file chosen for this video (job.audioPath), read only
// as long as the video so the output keeps the video's length.
function audioInputArgs(job) {
  if (!job.audioPath) return [];
  // A positive effective waveform/frame offset needs that much extra input.
  const d = replacementDuration(job) + Math.max(0, replacementOffset(job));
  return [...(d > 0 ? ["-t", d.toFixed(6)] : []), "-i", job.audioPath];
}
// Written into each output's "comment" tag: how it was encoded, so the
// lossless trim page can re-encode cut edges with exactly these settings
// (smart cut), and where an MMD export starts on MMD's timeline.
const TAG = "MMDEncoder ";
const TAG_KEYS = [
  "encoder",
  "preset",
  "quality",
  "rateControl",
  "bitrate",
  "bitDepth",
  "chroma",
  "gop",
  "bframes",
  "lookahead",
  "lookaheadLevel",
  "colorSpace",
  "colorRange",
];
function encodeTag(s, extra = {}) {
  return (
    TAG +
    JSON.stringify({
      v: 1,
      enc: Object.fromEntries(TAG_KEYS.map((k) => [k, s[k]])),
      ...extra,
    })
  );
}
// The tag's content, or null when a file was not made by MMDEncoder.
function readTag(comment) {
  if (typeof comment !== "string" || !comment.startsWith(TAG)) return null;
  try {
    const v = JSON.parse(comment.slice(TAG.length));
    return v && v.v === 1 ? v : null;
  } catch {
    return null;
  }
}
// The keyframe interval "edit friendly" asks for: one per second of output.
function keyframes(s, meta) {
  if (!s.editFriendly || s.gop >= 0) return s;
  let out = 0;
  try {
    out = parseFps(s.fps)?.value || 0;
  } catch {} // reported by validate()
  const fps =
    (out || Number(meta?.fps) || 30) *
    (s.vfg ? Number(s.vfgMultiplier) || 1 : 1);
  return { ...s, gop: Math.max(1, Math.round(fps)) };
}
// One FFmpeg run for two outputs from one decode: the colour video's
// arguments with the mask's filter and encoder added as a second output.
// Both come from buildCommands ("-map 0:v:0 -vf <filter>" then the output
// options); the mask's progress option is dropped, as the colour run's
// already reports (and may write to stdout, which can carry the frames).
// flip: a filter applied to the input before the split (MMD's bottom-up frames).
function joinMask(video, mask, flip = "") {
  const part = (a) => {
    const m = a.indexOf("-map");
    if (m < 0 || a[m + 2] !== "-vf") throw appError("MASK_COMMAND_COMBINE");
    return { head: a.slice(0, m), filter: a[m + 3], rest: a.slice(m + 4) };
  };
  const v = part(video),
    k = part(mask);
  const rest = k.rest.filter(
    (x, i, all) => x !== "-progress" && all[i - 1] !== "-progress",
  );
  return [
    ...v.head,
    "-filter_complex",
    `[0:v]${flip}split=2[v0][m0];[v0]${v.filter}[vout];[m0]${k.filter}[mout]`,
    "-map",
    "[vout]",
    ...v.rest,
    "-map",
    "[mout]",
    ...rest,
  ];
}
// Colour video and mask in one pass: buildCommands writes the mask with a
// run of its own (still used to redo just the mask); here it joins the
// colour's FFmpeg, or with NVEncC the FFmpeg that feeds NVEncC its frames.
function singlePass(commands) {
  const i = commands.findIndex((c) => c.mask);
  if (i < 0 || commands.length < 2) return commands;
  const mask = commands[i];
  const rest = commands.filter((c) => c !== mask);
  const piped = rest.find((c) => c.pipeFrom);
  if (piped)
    return rest.map((c) =>
      c === piped
        ? {
            ...c,
            pipeFrom: {
              ...c.pipeFrom,
              args: joinMask(c.pipeFrom.args, mask.args),
            },
            stage: stage("nvencc_encoding_muxing_with_mask"),
            mask: true,
            maskOutput: mask.output,
            ...(mask.maskEncoding ? { maskEncoding: mask.maskEncoding } : {}),
          }
        : c,
    );
  const [colour] = rest;
  return [
    {
      ...colour,
      args: joinMask(colour.args, mask.args),
      stage: stage("video_encoding_with_mask"),
      mask: true,
      ...(mask.maskEncoding ? { maskEncoding: mask.maskEncoding } : {}),
    },
    ...rest.slice(1),
  ];
}
function buildCommands(job, s, engines, paths) {
  s = keyframes(s, job.meta);
  const issues = validateIssues(s, job.meta);
  if (issues.length) throw validationError(issues);
  const base = ["-hide_banner", "-nostdin", "-n"];
  // libplacebo's Vulkan device, only where the filter runs the shader.
  const baseFor = (mask) =>
    !mask && usesArtcnn(s, job.meta || {})
      ? [...base.slice(0, 3), "-init_hw_device", "vulkan", ...base.slice(3)]
      : base;
  if (job.meta?.hasAlpha && ["vp8", "vp9"].includes(job.meta.codec))
    base.push("-c:v", job.meta.codec === "vp9" ? "libvpx-vp9" : "libvpx");
  base.push(...inputArgs(job));
  // The audio's parameters and its stream: the source's, or a replacement
  // file (job.audioMeta, read when it was chosen) given as the next input.
  const sourceAudio = job.audioPath ? job.audioMeta : job.meta?.audio;
  // The effective waveform/frame offset cuts the start (> 0) or adds silence
  // (< 0). A replacement is padded and trimmed to the video's duration.
  const audioOffset = job.audioPath ? replacementOffset(job) : 0;
  const audioLength = job.audioPath
    ? Math.min(
        (Number(job.audioDuration) || Infinity) - audioOffset,
        replacementDuration(job) || Infinity,
      )
    : job.meta?.duration;
  const colors = [
    "-colorspace",
    s.colorSpace === "bt601"
      ? "smpte170m"
      : s.colorSpace === "bt2020"
        ? "bt2020nc"
        : s.colorSpace,
    "-color_range",
    s.colorRange,
  ];
  // Copying keeps the source's own audio packets: nothing to trim, pad or
  // fade, so it cannot take a replacement, and the codec must fit the file.
  if (s.audio === "copy" && sourceAudio) {
    if (job.audioPath) throw appError("AUDIO_COPY_REPLACEMENT");
    if (!media.copyFits(s.container, sourceAudio.codec))
      throw appError("AUDIO_COPY_CONTAINER", {
        codec: sourceAudio.codec,
        container: s.container.toUpperCase(),
      });
  }
  const hiResPlan =
    s.hiRes &&
    sourceAudio &&
    media.hiResPlan(s.audio === "flac" ? "flac" : "wav", sourceAudio);
  const audio =
    sourceAudio && s.audio !== "none"
      ? [
          "-map",
          job.audioPath ? "1:a:0" : "0:a:0?",
          // Fade in / out over the source's length (audio keeps its timing).
          ...media.withAudioFilter(
            s.hiRes
              ? // PCM becomes 24-bit PCM; see media.hiResPlan for the rules.
                // Fading or padding/trimming a replacement needs decoded
                // samples even where Hi-Res alone would copy.
                (s.audioFade || job.audioPath) && hiResPlan.action === "copy"
                ? media.hiResCodec(hiResPlan)
                : media.hiResArgs(hiResPlan, engines?.soxr)
              : [
                  "-c:a",
                  s.audio,
                  ...(["aac", "libopus"].includes(s.audio)
                    ? ["-b:a", s.audioBitrate + "k"]
                    : []),
                ],
            [
              job.audioPath
                ? media.alignFilter(
                    // Ends with the video (silence padded in front must not
                    // make it longer).
                    {
                      offset: audioOffset,
                      length: replacementDuration(job),
                    },
                    sourceAudio.sampleRate,
                  )
                : "",
              media.fadeFilter(s.audioFade, audioLength),
            ]
              .filter(Boolean)
              .join(","),
          ),
        ]
      : ["-an"];
  const result = [];
  // Mask only: one mask encode written as the main output (no audio, no colour).
  const maskOnly = s.alphaMode === "mask";
  for (const mask of maskOnly
    ? [true]
    : [false, ...(s.alphaMask ? [true] : [])]) {
    const output = mask && !maskOnly ? paths.maskOutput : paths.output;
    if (s.encoder.startsWith("nvencc:") && !mask) {
      result.push(
        ...nvenccCommands({
          s,
          meta: job.meta,
          ffmpeg: engines.ffmpeg,
          nvencc: engines.nvencc,
          base: baseFor(mask),
          output,
          audio,
          audioSource: job.audioPath ? audioInputArgs(job) : inputArgs(job),
          colors,
          tag: encodeTag(s, paths.tag),
        }),
      );
    } else {
      const choice = mask ? maskChoice(s, job.meta || {}, engines) : null;
      const ms = choice ? choice.settings : s;
      result.push({
        exe: engines.ffmpeg,
        args: [
          ...baseFor(mask),
          ...(mask ? [] : audioInputArgs(job)),
          "-map",
          "0:v:0",
          "-vf",
          filter(ms, job.meta || {}, mask),
          ...(choice?.options || videoOptions(ms)),
          ...(mask ? ["-an"] : audio),
          ...colors,
          "-metadata",
          "comment=" + encodeTag(ms, paths.tag),
          "-fps_mode",
          "passthrough",
          ...(["mp4", "mov"].includes(s.container)
            ? ["-movflags", "+faststart"]
            : []),
          "-progress",
          "pipe:1",
          output,
        ],
        stage: stage(mask ? "alpha_mask" : "video_encoding"),
        output,
        mask: mask && !maskOnly,
        ...(choice && (choice.gpu || choice.format !== "lossless")
          ? {
              maskEncoding: {
                format: choice.format,
                encoder: choice.encoder,
                gpu: choice.gpu,
                quality: ms.quality,
                ...(choice.note ? { note: choice.note } : {}),
              },
            }
          : {}),
      });
    }
  }
  return result;
}
module.exports = {
  joinMask,
  singlePass,
  encodeTag,
  readTag,
  inputArgs,
  buildCommands,
};
