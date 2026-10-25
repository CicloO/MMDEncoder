"use strict";
const path = require("node:path");
const media = require("./media.cjs");
const {
  parseFps,
  dimensions,
  pix,
  usesArtcnn,
  artcnnSkipped,
  vsrPrepare,
  filter,
} = require("./filter.cjs");
const {
  DEFAULTS,
  PRORES_QUALITY,
  ENGINES,
  BUILTINS,
} = require("./definitions.cjs");
const { filename, validate } = require("./settings-validation.cjs");
const { compatibility } = require("./compatibility.cjs");
const {
  maskSettings,
  maskOnNvenc,
  NVENC_LOSSLESS,
} = require("./mask-settings.cjs");
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
const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
function commandText(commands, { prepare = false } = {}) {
  const lines = [];
  if (prepare && commands.length) {
    lines.push('$ErrorActionPreference = "Stop"');
    const files = commands.map((c) => c.output || c.temporary).filter(Boolean);
    for (const file of files)
      lines.push(
        `if (Test-Path -LiteralPath ${quote(file)}) { throw "输出已存在，停止以避免覆盖" }`,
      );
    for (const dir of new Set(files.map((file) => path.dirname(file))))
      lines.push(`[void][System.IO.Directory]::CreateDirectory(${quote(dir)})`);
  }
  // FFmpeg -> NVEncC: a PowerShell pipe would turn the video into text in
  // Windows PowerShell 5.1 and only reports the last program's exit code,
  // so the script copies the bytes itself and checks both programs.
  const piped = commands.some((c) => c.pipeFrom);
  if (prepare && piped)
    lines.push(
      'if ($PSVersionTable.PSVersion.Major -lt 7) { throw "请用 PowerShell 7（pwsh）运行这段命令" }',
      "function Invoke-Piped([string]$Writer, [string[]]$WriterArgs, [string]$Reader, [string[]]$ReaderArgs) {",
      "  $w = [Diagnostics.ProcessStartInfo]::new($Writer); foreach ($a in $WriterArgs) { $w.ArgumentList.Add($a) }",
      "  $w.UseShellExecute = $false; $w.RedirectStandardOutput = $true",
      "  $r = [Diagnostics.ProcessStartInfo]::new($Reader); foreach ($a in $ReaderArgs) { $r.ArgumentList.Add($a) }",
      "  $r.UseShellExecute = $false; $r.RedirectStandardInput = $true",
      "  $wp = [Diagnostics.Process]::Start($w); $rp = [Diagnostics.Process]::Start($r)",
      "  try { $wp.StandardOutput.BaseStream.CopyTo($rp.StandardInput.BaseStream) } catch { } finally { $rp.StandardInput.Close() }",
      "  $wp.WaitForExit(); $rp.WaitForExit()",
      '  if ($wp.ExitCode -ne 0) { throw "预处理失败（退出码 $($wp.ExitCode)）" }',
      '  if ($rp.ExitCode -ne 0) { throw "编码失败（退出码 $($rp.ExitCode)）" }',
      "}",
    );
  const list = (args) => "@(" + args.map(quote).join(", ") + ")";
  for (const c of commands) {
    const call = (x) => "& " + [x.exe, ...x.args].map(quote).join(" ");
    if (c.pipeFrom && prepare) {
      lines.push(
        `Invoke-Piped ${quote(c.pipeFrom.exe)} ${list(c.pipeFrom.args)} ${quote(c.exe)} ${list(c.args)}`,
      );
      continue;
    }
    // In the job log: what ran, the two programs joined by a pipe.
    lines.push((c.pipeFrom ? call(c.pipeFrom) + " | " : "") + call(c));
    lines.push('if ($LASTEXITCODE -ne 0) { throw "编码失败" }');
  }
  if (prepare)
    for (const c of commands.filter((c) => c.temporary))
      lines.push(`Remove-Item -LiteralPath ${quote(c.temporary)}`);
  return lines.join("\r\n");
}
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
  return {
    width: v.width,
    height: v.height,
    fps: frac(fpsText),
    fpsText,
    duration: Number(data.format?.duration || v.duration) || 0,
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
  // Aligned later in the file (job.audioOffset > 0): read that much more.
  const d =
    (Number(job.meta?.duration) || 0) +
    Math.max(0, Number(job.audioOffset) || 0);
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
    if (m < 0 || a[m + 2] !== "-vf") throw Error("无法组合遮罩命令");
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
            stage: c.stage + " + Alpha 遮罩",
            mask: true,
          }
        : c,
    );
  const [colour] = rest;
  return [
    {
      ...colour,
      args: joinMask(colour.args, mask.args),
      stage: colour.stage + " + Alpha 遮罩",
      mask: true,
    },
    ...rest.slice(1),
  ];
}
function buildCommands(job, s, engines, paths) {
  s = keyframes(s, job.meta);
  const errors = validate(s, job.meta);
  if (errors.length) throw Error(errors.join("；"));
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
  // 音频对齐 of a replacement (job.audioOffset, seconds: > 0 its start is
  // cut, < 0 silence goes first); the audio then ends at the video's end or
  // its own, whichever is first.
  const audioOffset = job.audioPath ? Number(job.audioOffset) || 0 : 0;
  const audioLength = job.audioPath
    ? Math.min(
        (Number(job.audioDuration) || Infinity) - audioOffset,
        Number(job.meta?.duration) || Infinity,
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
                // A fade or an alignment means re-encoding even where
                // Hi-Res would copy.
                (s.audioFade || audioOffset) && hiResPlan.action === "copy"
                ? media.hiResCodec(hiResPlan)
                : media.hiResArgs(hiResPlan, engines?.soxr)
              : [
                  "-c:a",
                  s.audio,
                  ...(["aac", "libopus"].includes(s.audio) && s.audioBitrate
                    ? ["-b:a", s.audioBitrate + "k"]
                    : s.audio === "aac"
                      ? ["-b:a", "192k"]
                      : []),
                ],
            [
              audioOffset
                ? media.alignFilter(
                    // Ends with the video (silence padded in front must not
                    // make it longer).
                    {
                      offset: audioOffset,
                      length: Number(job.meta?.duration) || 0,
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
      // FFmpeg applies the filters and hands NVEncC raw frames through a
      // pipe (NUT keeps each frame's time and the alpha plane), so no
      // intermediate file is written. Audio is taken from the source when
      // the result is packaged.
      const encoded = output + ".nvenc.mkv";
      const prepare = {
        exe: engines.ffmpeg,
        args: [
          ...baseFor(mask),
          "-map",
          "0:v:0",
          "-vf",
          filter(s.vsr ? vsrPrepare(s) : s, job.meta || {}, false),
          "-c:v",
          "rawvideo",
          "-pix_fmt",
          s.alphaMode === "preserve" ? "yuva444p" : pix(s),
          "-an",
          ...colors,
          "-fps_mode",
          "passthrough",
          // stdout carries the frames; progress goes with the log.
          "-progress",
          "pipe:2",
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
        encoded,
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
      if (s.alphaMode === "preserve")
        a.push("--alpha-channel-mode", "straight");
      if (s.vsr) {
        const size = dimensions(s, job.meta);
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
      result.push({
        exe: engines.nvencc,
        args: a,
        pipeFrom: prepare,
        stage: "NVEncC 编码",
        temporary: encoded,
      });
      result.push({
        exe: engines.ffmpeg,
        args: [
          "-hide_banner",
          "-nostdin",
          "-n",
          "-i",
          encoded,
          ...(job.audioPath ? audioInputArgs(job) : inputArgs(job)),
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          // The source's (or replacement) audio, encoded as set (input 1).
          ...audio.map((x) => (x === "0:a:0?" ? "1:a:0?" : x)),
          ...colors,
          "-metadata",
          "comment=" + encodeTag(s, paths.tag),
          "-progress",
          "pipe:1",
          output,
        ],
        stage: "封装",
        output,
      });
    } else {
      const ms = mask ? maskSettings(s) : s;
      result.push({
        exe: engines.ffmpeg,
        args: [
          ...baseFor(mask),
          ...(mask ? [] : audioInputArgs(job)),
          "-map",
          "0:v:0",
          "-vf",
          filter(ms, job.meta || {}, mask),
          ...(mask && maskOnNvenc(s, job.meta || {}, engines)
            ? NVENC_LOSSLESS
            : videoOptions(ms)),
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
        stage: mask ? "Alpha 遮罩" : "视频编码",
        output,
        mask: mask && !maskOnly,
      });
    }
  }
  return result;
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
  outputPaths,
  quote,
  commandText,
  metadata,
  buildCommands,
  usesArtcnn,
  artcnnSkipped,
};
