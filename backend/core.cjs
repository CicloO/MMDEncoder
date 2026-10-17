"use strict";
const path = require("node:path");
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
  alphaMask: false,
  alphaMode: "discard",
  outputMode: "encoded",
  outputDir: "",
  nameTemplate: "{name}",
  colorSpace: "bt709",
  colorRange: "tv",
  gop: -1,
  bframes: -1,
  lookahead: 0,
  lookaheadLevel: 0,
  vsr: false,
  vsrScale: 2,
  vsrQuality: 4,
  vsrStrength: 1,
  vfg: false,
  vfgMultiplier: 2,
  vfgMode: "medium",
  vfgModelDir: "",
};
const ENGINES = [
  ["libx264", "H.264 · 软件", "cpu", "h264", [8, 10]],
  ["libx265", "HEVC · 软件", "cpu", "hevc", [8, 10]],
  ["libsvtav1", "AV1 · 软件", "cpu", "av1", [8, 10]],
  ["libvpx-vp9", "VP9 · 软件", "cpu", "vp9", [8, 10]],
  ["prores_ks", "ProRes · 软件", "cpu", "prores", [10]],
  ...["nvenc", "qsv", "amf"].flatMap((b) =>
    ["h264", "hevc", ...(b === "nvenc" ? ["av1"] : [])].map((c) => [
      c + "_" + b,
      c.toUpperCase() + " · " + b.toUpperCase(),
      b,
      c,
      c === "h264" ? [8] : [8, 10],
    ]),
  ),
  ...["h264", "hevc", "av1"].map((c) => [
    "nvencc:" + c,
    c.toUpperCase() + " · NVEncC",
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
// Platform presets: a hardware (NVENC CQ) and a software (x264 CRF) variant at a
// similar bitrate. X stays hardware-only with a bitrate cap for its 512 MB limit.
const PLATFORMS = [
  // id, name, width, height, audio kbps, NVENC CQ, x264 CRF
  ["youtube", "YouTube 4K", 3840, 2160, 384, 27, 19],
  ["bilibili4k", "B站 4K", 3840, 2160, 320, 29, 21],
  ["bilibili1080", "B站 1080P60", 1920, 1080, 320, 29, 21],
  ["tiktok", "抖音 / TikTok 4K", 2160, 3840, 320, 29, 21],
  ["x", "X 1080p", 1920, 1080, 256, 25, 0],
];
BUILTINS.splice(
  0,
  BUILTINS.length,
  ...PLATFORMS.flatMap(([id, label, width, height, audioBitrate, cq, crf]) => {
    const base = {
      ...DEFAULTS,
      resizeMode: "custom",
      // Vertical preset scales by its long edge (height) so tall sources stay within 3840.
      resizeAxis: id === "tiktok" ? "height" : "width",
      width,
      height,
      keepAspect: true,
      audioBitrate,
    };
    const hardware = {
      id: "builtin-" + id,
      name: crf ? label + " · 硬件" : label,
      settings: {
        ...base,
        encoder: "h264_nvenc",
        quality: cq,
        // CQ presets: p4 measured as good as p7 at ~2.4× the 4K speed. X is
        // bitrate-capped, where a slower preset still buys quality, so it keeps p7.
        preset: id === "x" ? "p7" : "p4",
        lookahead: 32,
        lookaheadLevel: 0,
        ...(id === "x" ? { rateControl: "bitrate", bitrate: 20000 } : {}),
      },
    };
    const software = crf && {
      id: "builtin-" + id + "-sw",
      name: label + " · 软件",
      settings: { ...base, encoder: "libx264", quality: crf, preset: "medium" },
    };
    return [hardware, software].filter(Boolean).map((p) => ({
      ...p,
      builtin: true,
      settings: { ...p.settings, presetName: p.name },
    }));
  }),
);
function parseFps(value) {
  if (value === "source") return null;
  const s = String(value).trim();
  const aliases = {
    23.976: "24000/1001",
    29.97: "30000/1001",
    59.94: "60000/1001",
  };
  const text = aliases[s] || s;
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(text))
    throw Error("输出帧率须为 1–240 的正数或分数");
  const [a, b = "1"] = text.split("/");
  const n = Number(a) / Number(b);
  if (!Number.isFinite(n) || n < 1 || n > 240)
    throw Error("输出帧率须为 1–240 FPS，分母不能为零");
  return { text, value: n };
}
function filename(name) {
  if (
    !name ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  )
    throw Error("输出名称包含非法字符或 Windows 保留名");
  return name;
}
function validate(s, meta) {
  const e = [];
  const check = (ok, msg) => {
    if (!ok) e.push(msg);
  };
  const eng = ENGINES.find((x) => x.id === s.encoder);
  if (["h264_nvenc", "nvencc:h264"].includes(s.encoder))
    check(s.lookaheadLevel === 0, "H.264 NVENC 的前向分析级别须为 0");
  if (s.vsr || s.vfg) {
    check(eng?.backend === "nvencc", "RTX 增强需要 NVEncC 编码器");
    check(
      s.alphaMode !== "preserve" && !s.alphaMask,
      "RTX 增强暂不能与保留 Alpha 或独立 Alpha 遮罩组合",
    );
    check(s.bitDepth === 8 && s.chroma === "420", "RTX 增强使用 8-bit 4:2:0");
  }
  if (s.vsr) {
    check(
      Number.isFinite(s.vsrScale) && s.vsrScale >= 1 && s.vsrScale <= 4,
      "VSR 倍率须为 1.00–4.00",
    );
    check(
      [
        0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23,
      ].includes(s.vsrQuality),
      "VSR QualityLevel 无效",
    );
    check(
      Number.isFinite(s.vsrStrength) &&
        s.vsrStrength >= 0 &&
        s.vsrStrength <= 1,
      "VSR 强度须为 0.00–1.00",
    );
    check(
      s.resizeMode === "source",
      "启用 VSR 时请保持源分辨率，由 VSR 倍率控制输出尺寸",
    );
    if (s.vsrQuality >= 8 && s.vsrQuality <= 19)
      check(
        s.vsrScale === 1,
        "VSR 去噪 / 去模糊 / 补细节模式使用 1.00 倍原尺寸",
      );
  }
  if (s.vfg) {
    check(
      !s.vfgModelDir || path.isAbsolute(s.vfgModelDir),
      "VFG 模型目录必须为绝对路径",
    );
    check(
      Number.isInteger(s.vfgMultiplier) &&
        s.vfgMultiplier >= 2 &&
        s.vfgMultiplier <= 8,
      "VFG 倍率须为 2–8",
    );
    check(["low", "medium", "high"].includes(s.vfgMode), "VFG 模型无效");
    check(
      s.fps === "source",
      "VFG 使用源帧率乘倍率，请将输出帧率设为保持源帧率",
    );
    if (meta)
      check(meta.fps * s.vfgMultiplier <= 960, "VFG 输出帧率超过 960 FPS");
  }
  check(!!eng, "编码器无效");
  for (const [k, values] of Object.entries({
    container: ["mp4", "mkv", "mov", "webm"],
    bitDepth: [8, 10],
    chroma: ["420", "422", "444"],
    rateControl: ["quality", "qp", "bitrate"],
    audio: ["aac", "flac", "pcm_s16le", "libopus", "none"],
    alphaMode: ["discard", "black", "white", "preserve"],
    resizeMode: ["source", "custom"],
    resizeAxis: ["width", "height"],
    outputMode: ["source", "encoded", "custom"],
    colorSpace: ["bt709", "bt601", "bt2020"],
    colorRange: ["tv", "pc"],
  }))
    check(values.includes(s[k]), "无效设置：" + k);
  try {
    parseFps(s.fps);
  } catch (x) {
    e.push(x.message);
  }
  try {
    filename(
      String(s.nameTemplate).replace(/\{(?:name|preset|date|index)\}/g, "名称"),
    );
    check(
      !/[{}]/.test(
        String(s.nameTemplate).replace(/\{(?:name|preset|date|index)\}/g, ""),
      ),
      "命名模板含未知占位符",
    );
  } catch (x) {
    e.push(x.message);
  }
  for (const [k, min, max] of [
    ["quality", 0, 63],
    ["bitrate", 0, 1000000],
    ["gop", -1, 10000],
    ["bframes", -1, 16],
    ["lookahead", 0, 32],
    ["lookaheadLevel", 0, 3],
  ])
    check(
      Number.isFinite(s[k]) && s[k] >= min && s[k] <= max,
      "无效数值：" + k,
    );
  check(
    [0, 64, 96, 128, 160, 192, 256, 320, 384, 512].includes(
      s.audioBitrate ?? 0,
    ),
    "音频码率无效，请选择列表中的码率",
  );
  check(typeof s.alphaMask === "boolean", "透明遮罩开关无效");
  check(
    typeof s.preset === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(s.preset),
    "速度预设无效",
  );
  if (s.rateControl === "bitrate")
    check(s.bitrate > 0, "码率模式必须指定大于零的码率");
  if (s.outputMode === "custom")
    check(
      typeof s.outputDir === "string" && path.isAbsolute(s.outputDir),
      "请选择有效的自定义绝对输出目录",
    );
  if (eng) {
    const speedValid =
      eng.backend === "nvenc" || eng.backend === "nvencc"
        ? /^p[1-7]$/i.test(s.preset)
        : eng.backend === "qsv"
          ? /^(veryfast|faster|fast|medium|slow|slower|veryslow)$/.test(
              s.preset,
            )
          : eng.backend === "amf"
            ? ["speed", "balanced", "quality"].includes(s.preset)
            : s.encoder === "libsvtav1"
              ? /^(?:[0-9]|1[0-3])$/.test(s.preset)
              : s.encoder === "libvpx-vp9"
                ? ["ultrafast", "fast", "medium", "slow", "veryslow"].includes(
                    s.preset,
                  )
                : eng.codec === "prores" ||
                  /^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|placebo)$/.test(
                    s.preset,
                  );
    check(speedValid, "此编码器的速度预设无效，请重新选择");
    if (["h264", "hevc"].includes(eng.codec))
      check(s.quality <= 51, "H.264 / HEVC 质量值范围为 0–51");
    if (["libsvtav1", "libvpx-vp9", "prores_ks"].includes(s.encoder))
      check(
        s.rateControl !== "qp",
        "此编码器不开放固定 QP，请选择恒定质量或码率",
      );
    check(eng.depths.includes(s.bitDepth), "所选编码器不支持此位深");
    if (s.container === "webm") {
      check(["av1", "vp9"].includes(eng.codec), "WebM 仅支持 AV1 或 VP9");
      check(
        ["libopus", "none"].includes(s.audio),
        "WebM 音频请选择 Opus 或无音频",
      );
    }
    if (["mp4", "mov"].includes(s.container))
      check(
        [
          "aac",
          "none",
          ...(s.container === "mov" ? ["pcm_s16le"] : []),
        ].includes(s.audio),
        "此容器不支持所选音频，请更换 MKV",
      );
    if (eng.codec === "prores") {
      check(["mov", "mkv"].includes(s.container), "ProRes 请选择 MOV 或 MKV");
      check(
        s.bitDepth === 10 && ["422", "444"].includes(s.chroma),
        "ProRes 需要 10-bit 4:2:2 或 4:4:4",
      );
    }
    if (["qsv", "amf"].includes(eng.backend) || eng.codec === "av1")
      check(s.chroma === "420", "此编码器仅开放已验证的 4:2:0");
    if (eng.codec === "h264" && eng.backend === "nvenc")
      check(s.chroma !== "422", "H.264 NVENC 不支持此 4:2:2 配置");
  }
  if (s.resizeMode === "custom") {
    check(typeof s.keepAspect === "boolean", "保持宽高比开关无效");
    for (const key of ["width", "height"])
      check(
        Number.isInteger(s[key]) && s[key] >= 2 && s[key] <= 16384,
        "分辨率宽高须为 2–16384 的整数",
      );
  }
  if (s.alphaMode === "preserve") {
    check(
      (s.encoder === "prores_ks" &&
        ["mov", "mkv"].includes(s.container) &&
        s.bitDepth === 10 &&
        s.chroma === "444") ||
        (s.encoder === "libvpx-vp9" &&
          ["webm", "mkv"].includes(s.container) &&
          s.bitDepth === 8 &&
          s.chroma === "420") ||
        (s.encoder === "nvencc:hevc" &&
          ["mp4", "mov", "mkv"].includes(s.container) &&
          s.bitDepth === 8 &&
          s.chroma === "420"),
      "保留 Alpha 请选择 ProRes 4444（MOV/MKV、10-bit、4:4:4）、VP9（WebM/MKV、8-bit、4:2:0）或 NVEncC HEVC（MP4/MOV/MKV、8-bit、4:2:0）",
    );
  }
  if (meta) {
    if (s.vsr) {
      const size = dimensions(s, meta);
      check(
        size.width <= 16384 && size.height <= 16384,
        "VSR 输出尺寸超过 16384 像素",
      );
    }
    if (s.alphaMode === "preserve")
      check(meta.hasAlpha, "源视频没有可读 Alpha，不能保留透明通道");
    const size = dimensions(s, meta);
    if (s.resizeMode === "custom")
      check(
        size.width >= 2 &&
          size.height >= 2 &&
          size.width <= 16384 &&
          size.height <= 16384,
        "输出分辨率超出 2–16384 范围，请调整尺寸",
      );
    if (s.alphaMask) check(meta.hasAlpha, "源视频没有可读 Alpha，不能生成遮罩");
    if (s.chroma === "420" || s.alphaMask)
      check(!(size.width % 2 || size.height % 2), "4:2:0 要求宽高为偶数");
    if (s.chroma === "422") check(!(size.width % 2), "4:2:2 要求宽度为偶数");
  }
  return [...new Set(e)];
}
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
  for (let n = 1; n < 100000; n++) {
    const stem = base + (n === 1 ? "" : ` (${n})`);
    const output = p.join(dir, stem + "." + s.container),
      maskOutput = s.alphaMask
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
  for (const c of commands) {
    lines.push("& " + [c.exe, ...c.args].map(quote).join(" "));
    lines.push('if ($LASTEXITCODE -ne 0) { throw "编码失败" }');
  }
  if (prepare)
    for (const c of commands.filter((c) => c.temporary))
      lines.push(`Remove-Item -LiteralPath ${quote(c.temporary)}`);
  return lines.join("\r\n");
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
    audio: a
      ? {
          codec: a.codec_name,
          sampleRate: Number(a.sample_rate),
          channels: a.channels,
          channelLayout: a.channel_layout,
        }
      : undefined,
  };
}
function dimensions(s, meta) {
  if (s.vsr)
    return {
      width: Math.max(2, Math.round((meta.width * s.vsrScale) / 2) * 2),
      height: Math.max(2, Math.round((meta.height * s.vsrScale) / 2) * 2),
    };
  if (s.resizeMode !== "custom")
    return { width: meta.width, height: meta.height };
  let width = s.width,
    height = s.height;
  if (s.keepAspect && meta.width && meta.height) {
    if (s.resizeAxis === "height")
      width = Math.max(
        2,
        Math.round((height * meta.width) / meta.height / 2) * 2,
      );
    else
      height = Math.max(
        2,
        Math.round((width * meta.height) / meta.width / 2) * 2,
      );
  }
  return { width, height };
}
function pix(s) {
  return (
    (s.alphaMode === "preserve" ? "yuva" : "yuv") +
    s.chroma +
    "p" +
    (s.bitDepth === 10 ? "10le" : "")
  );
}
function videoOptions(s) {
  const e = ENGINES.find((x) => x.id === s.encoder);
  const a = ["-c:v", s.encoder, "-pix_fmt", pix(s)];
  if (e.codec === "prores")
    a.push("-profile:v", s.chroma === "444" ? "4" : "3");
  else if (e.backend === "nvenc") {
    a.push("-preset", s.preset.toLowerCase());
    if (s.rateControl === "quality")
      a.push("-rc", "vbr", "-cq", String(s.quality), "-b:v", "0");
    else if (s.rateControl === "qp")
      a.push("-rc", "constqp", "-qp", String(s.quality));
    else a.push("-rc", "vbr", "-b:v", s.bitrate + "k");
    a.push("-rc-lookahead", String(s.lookahead));
    if (s.lookaheadLevel) a.push("-lookahead_level", String(s.lookaheadLevel));
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
function filter(s, meta, mask) {
  const f = [];
  if (mask) f.push("alphaextract");
  else if (meta.hasAlpha && ["black", "white"].includes(s.alphaMode)) {
    const bg = s.alphaMode === "white" ? 255 : 0;
    f.push(
      "format=rgba",
      `geq=r='r(X,Y)*alpha(X,Y)/255+${bg}*(1-alpha(X,Y)/255)':g='g(X,Y)*alpha(X,Y)/255+${bg}*(1-alpha(X,Y)/255)':b='b(X,Y)*alpha(X,Y)/255+${bg}*(1-alpha(X,Y)/255)'`,
    );
  }
  const fps = parseFps(s.fps);
  if (fps) f.push("fps=" + fps.text);
  const size = dimensions(s, meta);
  const resize =
    s.resizeMode === "custom"
      ? `w=${size.width}:h=${size.height}:flags=lanczos:`
      : "";
  f.push(
    `scale=${resize}in_range=${mask ? "pc" : meta.colorRange === "pc" ? "pc" : meta.colorRange === "tv" ? "tv" : "auto"}:out_range=${s.colorRange}:out_color_matrix=${s.colorSpace}`,
    `format=${pix(s)}`,
  );
  if (s.resizeMode === "custom") f.push("setsar=1");
  return f.join(",");
}
function buildCommands(job, s, engines, paths) {
  const errors = validate(s, job.meta);
  if (errors.length) throw Error(errors.join("；"));
  const base = ["-hide_banner", "-nostdin", "-n"];
  if (job.meta?.hasAlpha && ["vp8", "vp9"].includes(job.meta.codec))
    base.push("-c:v", job.meta.codec === "vp9" ? "libvpx-vp9" : "libvpx");
  base.push("-i", job.path);
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
  const audio =
    job.meta?.audio && s.audio !== "none"
      ? [
          "-map",
          "0:a:0?",
          "-c:a",
          s.audio,
          ...(["aac", "libopus"].includes(s.audio) && s.audioBitrate
            ? ["-b:a", s.audioBitrate + "k"]
            : s.audio === "aac"
              ? ["-b:a", "192k"]
              : []),
        ]
      : ["-an"];
  const result = [];
  for (const mask of [false, ...(s.alphaMask ? [true] : [])]) {
    const output = mask ? paths.maskOutput : paths.output;
    if (s.encoder.startsWith("nvencc:") && !mask) {
      const prep = output + ".prepare.mkv",
        encoded = output + ".nvenc.mkv";
      result.push({
        exe: engines.ffmpeg,
        args: [
          ...base,
          "-map",
          "0:v:0",
          "-vf",
          filter(
            s.vsr ? { ...s, vsr: false, resizeMode: "source" } : s,
            job.meta || {},
            false,
          ),
          "-c:v",
          "ffv1",
          "-level",
          "3",
          "-pix_fmt",
          s.alphaMode === "preserve" ? "yuva444p" : pix(s),
          ...audio,
          ...colors,
          "-fps_mode",
          "passthrough",
          "-progress",
          "pipe:1",
          "-f",
          "matroska",
          prep,
        ],
        stage: "预处理",
        temporary: prep,
      });
      const a = [
        "--avsw",
        "-i",
        prep,
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
      if (s.lookahead)
        a.push(
          "--lookahead",
          String(s.lookahead),
          "--lookahead-level",
          String(s.lookaheadLevel),
        );
      if (s.gop >= 0) a.push("--gop-len", String(s.gop));
      if (s.bframes >= 0) a.push("--bframes", String(s.bframes));
      result.push({
        exe: engines.nvencc,
        args: a,
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
          "-i",
          prep,
          "-map",
          "0:v:0",
          ...(job.meta?.audio && s.audio !== "none" ? ["-map", "1:a:0?"] : []),
          "-c",
          "copy",
          ...colors,
          "-progress",
          "pipe:1",
          output,
        ],
        stage: "封装",
        output,
      });
    } else {
      const ms = mask
        ? {
            ...s,
            encoder: s.container === "webm" ? "libvpx-vp9" : "libx264",
            alphaMode: "discard",
            bitDepth: 8,
            chroma: "420",
            quality: 0,
            preset: "medium",
            rateControl: "quality",
            bframes: -1,
            gop: -1,
          }
        : s;
      result.push({
        exe: engines.ffmpeg,
        args: [
          ...base,
          "-map",
          "0:v:0",
          "-vf",
          filter(ms, job.meta || {}, mask),
          ...videoOptions(ms),
          ...(mask ? ["-an"] : audio),
          ...colors,
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
        mask,
      });
    }
  }
  return result;
}
function compatibility(s, engines = ENGINES) {
  const errors = validate({ ...s, outputMode: "encoded", outputDir: "" });
  const suggestions = [];
  const add = (id, label, patch) => {
    const fixed = { ...s, ...patch, outputMode: "encoded", outputDir: "" };
    if (
      !validate(fixed).length &&
      Object.entries(patch).some(([key, value]) => s[key] !== value)
    )
      suggestions.push({ id, label, patch });
  };
  const current = engines.find((e) => e.id === s.encoder);
  const alphaSupported =
    s.alphaMode !== "preserve" || s.encoder !== "nvencc:hevc" || current?.alpha;
  if (!alphaSupported) errors.push("本机未通过 NVEncC HEVC Alpha 试编码");
  if (
    (s.vsr || s.vfg) &&
    errors.length &&
    s.alphaMode !== "preserve" &&
    !s.alphaMask
  ) {
    const engine = engines.find((e) => e.backend === "nvencc");
    if (engine)
      add("rtx-compatible", "保留 RTX 增强并修正关联设置", {
        encoder: engine.id,
        preset: "p4",
        bitDepth: 8,
        chroma: "420",
        lookahead: 0,
        lookaheadLevel: 0,
        quality: Math.min(s.quality, 51),
        ...(s.vsr
          ? {
              resizeMode: "source",
              ...(s.vsrQuality >= 8 && s.vsrQuality <= 19
                ? { vsrScale: 1 }
                : {}),
            }
          : {}),
        ...(s.vfg ? { fps: "source" } : {}),
      });
  }
  if (s.alphaMode === "preserve" && errors.length) {
    for (const [id, label, patch] of [
      [
        "nvencc:hevc",
        "切换至 8-bit NVEncC HEVC Alpha",
        {
          encoder: "nvencc:hevc",
          bitDepth: 8,
          chroma: "420",
          container: ["mp4", "mov", "mkv"].includes(s.container)
            ? s.container
            : "mkv",
          audio: ["mp4", "mov"].includes(s.container) ? "aac" : s.audio,
          preset: "p4",
          rateControl: "quality",
          quality: Math.min(s.quality, 51),
          lookahead: 0,
          lookaheadLevel: 0,
        },
      ],
      [
        "prores_ks",
        "切换至 ProRes 4444 Alpha",
        {
          encoder: "prores_ks",
          bitDepth: 10,
          chroma: "444",
          container: ["mov", "mkv"].includes(s.container) ? s.container : "mov",
          audio: s.audio === "none" ? "none" : "pcm_s16le",
          preset: "medium",
          rateControl: "quality",
          lookahead: 0,
          lookaheadLevel: 0,
        },
      ],
      [
        "libvpx-vp9",
        "切换至 VP9 Alpha",
        {
          encoder: "libvpx-vp9",
          bitDepth: 8,
          chroma: "420",
          container: ["webm", "mkv"].includes(s.container)
            ? s.container
            : "webm",
          audio: s.audio === "none" ? "none" : "libopus",
          preset: "medium",
          rateControl: "quality",
          lookahead: 0,
          lookaheadLevel: 0,
        },
      ],
    ]) {
      const engine = engines.find((e) => e.id === id);
      if (engine && (id !== "nvencc:hevc" || engine.alpha))
        add(id, label, patch);
    }
  } else if (errors.length && current) {
    const patch = {};
    if (errors.some((e) => e.includes("速度预设")))
      patch.preset = ["nvenc", "nvencc"].includes(current.backend)
        ? "p4"
        : current.backend === "amf"
          ? "balanced"
          : s.encoder === "libsvtav1"
            ? "6"
            : "medium";
    if (["h264_nvenc", "nvencc:h264"].includes(s.encoder) && s.lookaheadLevel)
      patch.lookaheadLevel = 0;
    if (!current.depths.includes(s.bitDepth))
      patch.bitDepth = current.depths[0];
    if (current.codec === "prores")
      Object.assign(patch, {
        bitDepth: 10,
        chroma: ["422", "444"].includes(s.chroma) ? s.chroma : "422",
        container: ["mov", "mkv"].includes(s.container) ? s.container : "mov",
        rateControl: "quality",
        preset: "medium",
      });
    if (["qsv", "amf"].includes(current.backend) || current.codec === "av1")
      patch.chroma = "420";
    if (
      current.codec === "h264" &&
      current.backend === "nvenc" &&
      s.chroma === "422"
    )
      patch.chroma = "420";
    if (s.container === "webm" && !["vp9", "av1"].includes(current.codec))
      patch.container = "mkv";
    else if (s.container === "webm" && !["libopus", "none"].includes(s.audio))
      patch.audio = "libopus";
    const container = patch.container || s.container;
    if (
      ["mp4", "mov"].includes(container) &&
      !["aac", "none", ...(container === "mov" ? ["pcm_s16le"] : [])].includes(
        s.audio,
      )
    )
      patch.container = "mkv";
    if (
      ["libsvtav1", "libvpx-vp9", "prores_ks"].includes(s.encoder) &&
      s.rateControl === "qp"
    )
      patch.rateControl = "quality";
    if (["h264", "hevc"].includes(current.codec) && s.quality > 51)
      patch.quality = 51;
    add("compatible", "修正为当前编码器的兼容设置", patch);
  }
  return { errors, suggestions };
}
module.exports = {
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
};
