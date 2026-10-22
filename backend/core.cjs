"use strict";
const path = require("node:path");
const media = require("./media.cjs");
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
  // Hi-Res audio (FLAC / PCM): 24-bit, twice the rate below 48 kHz.
  hiRes: false,
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
// ProRes quantizer for the built-in presets and when switching to ProRes:
// measured on a 4K MMD render at about 1/5 of the default size, colour SSIM
// 0.997 against the lossless source; alpha is unaffected by the quantizer.
const PRORES_QUALITY = 12;
const ENGINES = [
  ["libx264", "H.264 · CPU", "cpu", "h264", [8, 10]],
  ["libx265", "HEVC · CPU", "cpu", "hevc", [8, 10]],
  ["libsvtav1", "AV1 · CPU", "cpu", "av1", [8, 10]],
  ["libvpx-vp9", "VP9 · CPU", "cpu", "vp9", [8, 10]],
  ["prores_ks", "ProRes · CPU", "cpu", "prores", [10]],
  ...["nvenc", "qsv", "amf"].flatMap((b) =>
    ["h264", "hevc", ...(b === "nvenc" ? ["av1"] : [])].map((c) => [
      c + "_" + b,
      (c === "h264" ? "H.264" : c.toUpperCase()) + " · " + b.toUpperCase(),
      b,
      c,
      c === "h264" ? [8] : [8, 10],
    ]),
  ),
  ...["h264", "hevc", "av1"].map((c) => [
    "nvencc:" + c,
    (c === "h264" ? "H.264" : c.toUpperCase()) + " · NVEncC",
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
// Recommended upload presets: a hardware (NVENC CQ) and a software (x264 CRF)
// variant. Scaling uses the long edge, so landscape and portrait sources both
// come out at 3840 / 1920.
const RECOMMENDED = [
  // id, name, long edge
  ["4k", "默认 4K", 3840],
  ["1080", "默认 1080p", 1920],
];
BUILTINS.splice(
  0,
  BUILTINS.length,
  ...RECOMMENDED.flatMap(([id, label, edge]) => {
    const base = {
      ...DEFAULTS,
      resizeMode: "long",
      width: edge,
      height: Math.round((edge * 9) / 16),
      keepAspect: true,
      audioBitrate: 320,
    };
    return [
      {
        id: "builtin-" + id,
        name: label + " · 硬件",
        // p4 measured as good as p7 at ~2.4× the 4K speed.
        settings: {
          ...base,
          encoder: "h264_nvenc",
          quality: 29,
          preset: "p4",
          lookahead: 32,
          lookaheadLevel: 0,
        },
      },
      {
        id: "builtin-" + id + "-sw",
        name: label + " · 软件",
        settings: {
          ...base,
          encoder: "libx264",
          quality: 21,
          preset: "medium",
        },
      },
    ];
  }),
  // Transparent output at the source size for editing (After Effects etc.).
  // ProRes 4444 in MOV: HEVC alpha lives in an auxiliary layer that only Apple's
  // decoder reads, so AE on Windows imports it without transparency.
  {
    id: "builtin-alpha",
    name: "保留 Alpha · ProRes 4444",
    settings: {
      ...DEFAULTS,
      encoder: "prores_ks",
      alphaMode: "preserve",
      bitDepth: 10,
      chroma: "444",
      container: "mov",
      audio: "pcm_s16le",
      preset: "medium",
      rateControl: "quality",
      quality: PRORES_QUALITY,
      lookahead: 0,
      lookaheadLevel: 0,
    },
  },
  // Split: the recommended hardware encoder at the source size with a higher
  // quality (CQ 19, it is meant for editing), plus a separate lossless
  // grayscale mask (smaller than lossy masks, measured) used as a luma matte.
  {
    id: "builtin-alpha-mask",
    name: "分离 Alpha · H.264 MP4",
    settings: {
      ...DEFAULTS,
      encoder: "h264_nvenc",
      container: "mp4",
      quality: 19,
      preset: "p4",
      lookahead: 32,
      lookaheadLevel: 0,
      audioBitrate: 320,
      alphaMode: "discard",
      alphaMask: true,
    },
  },
  // Editing intermediate without alpha: ProRes 422 HQ at the source size,
  // smaller than 4444 and read by every editor.
  {
    id: "builtin-prores422",
    name: "ProRes 422 HQ · 剪辑素材",
    settings: {
      ...DEFAULTS,
      encoder: "prores_ks",
      alphaMode: "discard",
      bitDepth: 10,
      chroma: "422",
      container: "mov",
      audio: "pcm_s16le",
      preset: "medium",
      rateControl: "quality",
      quality: PRORES_QUALITY,
      lookahead: 0,
      lookaheadLevel: 0,
    },
  },
);
for (const p of BUILTINS) {
  p.builtin = true;
  p.settings = { ...p.settings, presetName: p.name };
}
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
function validate(s, meta) {
  // Mask only: the colour encoder and audio settings are not used, so check
  // the mask's own encoding; RTX stays refused and the source needs alpha.
  if (s.alphaMode === "mask") {
    const e = validate({ ...maskSettings(s), vsr: false, vfg: false }, meta);
    if (s.vsr || s.vfg)
      e.push("RTX 增强暂不能与保留 Alpha 或独立 Alpha 遮罩组合");
    if (meta && !meta.hasAlpha) e.push("源视频没有可读 Alpha，不能生成遮罩");
    return [...new Set(e)];
  }
  const e = [];
  const check = (ok, msg) => {
    if (!ok) e.push(msg);
  };
  const eng = ENGINES.find((x) => x.id === s.encoder);
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
    // black / white are kept so presets saved before 1.3.0 still load.
    // mask = only the black-and-white alpha mask, no colour video.
    alphaMode: ["discard", "green", "black", "white", "preserve", "mask"],
    resizeMode: ["source", "custom", "long"],
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
    ["quality", 0, s.encoder === "prores_ks" ? 64 : 63],
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
  check(typeof s.hiRes === "boolean", "Hi-Res 开关无效");
  if (s.hiRes)
    check(
      ["flac", "pcm_s16le"].includes(s.audio),
      "Hi-Res 音频请选择 FLAC 或 PCM",
    );
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
    if (eng.codec === "prores")
      check(
        Number.isInteger(s.quality) && s.quality >= 0 && s.quality <= 64,
        "ProRes 量化须为 0–64 的整数（0 为编码器默认）",
      );
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
  if (s.resizeMode === "long")
    check(
      Number.isInteger(s.width) && s.width >= 2 && s.width <= 16384,
      "长边须为 2–16384 的整数",
    );
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
      "保留 Alpha 请选择 ProRes 4444（MOV/MKV、10-bit、4:4:4）、VP9（WebM/MKV、8-bit、4:2:0）或 NVEncC HEVC（MP4/MOV/MKV、8-bit、4:2:0），也可以改为“分离 Alpha”保持当前格式",
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
    if (s.resizeMode !== "source")
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
  for (const c of commands) {
    lines.push("& " + [c.exe, ...c.args].map(quote).join(" "));
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
function dimensions(s, meta) {
  if (s.vsr)
    return {
      width: Math.max(2, Math.round((meta.width * s.vsrScale) / 2) * 2),
      height: Math.max(2, Math.round((meta.height * s.vsrScale) / 2) * 2),
    };
  if (s.resizeMode === "long" && meta.width && meta.height) {
    // Long edge: landscape sources get this width, portrait ones this height.
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return meta.width >= meta.height
      ? { width: s.width, height: even((s.width * meta.height) / meta.width) }
      : { width: even((s.width * meta.width) / meta.height), height: s.width };
  }
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
// Background colours for compositing alpha away; green is the chroma-key green screen.
const BACKGROUNDS = {
  green: [0, 255, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
};
function filter(s, meta, mask) {
  const f = [];
  if (mask) f.push("alphaextract");
  else if (meta.hasAlpha && BACKGROUNDS[s.alphaMode]) {
    const [r, g, b] = BACKGROUNDS[s.alphaMode];
    const mix = (c, bg) => `${c}(X,Y)*alpha(X,Y)/255+${bg}*(1-alpha(X,Y)/255)`;
    f.push(
      "format=rgba",
      `geq=r='${mix("r", r)}':g='${mix("g", g)}':b='${mix("b", b)}'`,
    );
  }
  const fps = parseFps(s.fps);
  if (fps) f.push("fps=" + fps.text);
  const size = dimensions(s, meta);
  const resize =
    s.resizeMode !== "source"
      ? `w=${size.width}:h=${size.height}:flags=lanczos:`
      : "";
  f.push(
    `scale=${resize}in_range=${mask ? "pc" : meta.colorRange === "pc" ? "pc" : meta.colorRange === "tv" ? "tv" : "auto"}:out_range=${s.colorRange}:out_color_matrix=${s.colorSpace}`,
    `format=${pix(s)}`,
  );
  if (s.resizeMode !== "source") f.push("setsar=1");
  return f.join(",");
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
function buildCommands(job, s, engines, paths) {
  const errors = validate(s, job.meta);
  if (errors.length) throw Error(errors.join("；"));
  const base = ["-hide_banner", "-nostdin", "-n"];
  if (job.meta?.hasAlpha && ["vp8", "vp9"].includes(job.meta.codec))
    base.push("-c:v", job.meta.codec === "vp9" ? "libvpx-vp9" : "libvpx");
  base.push(...inputArgs(job));
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
          ...(s.hiRes
            ? // PCM becomes 24-bit PCM; see media.hiResPlan for the rules.
              media.hiResArgs(
                media.hiResPlan(
                  s.audio === "flac" ? "flac" : "wav",
                  job.meta.audio,
                ),
                engines?.soxr,
              )
            : [
                "-c:a",
                s.audio,
                ...(["aac", "libopus"].includes(s.audio) && s.audioBitrate
                  ? ["-b:a", s.audioBitrate + "k"]
                  : s.audio === "aac"
                    ? ["-b:a", "192k"]
                    : []),
              ]),
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
      const ms = mask ? maskSettings(s) : s;
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
        mask: mask && !maskOnly,
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
    // No NVEncC HEVC Alpha fix: Windows editors (After Effects, Premiere)
    // cannot read HEVC alpha, so it is only offered by choosing it manually.
    for (const [id, label, patch] of [
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
          quality: PRORES_QUALITY,
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
    // Split alpha keeps the chosen encoder and container: the colour video
    // drops alpha and a separate mask carries it, so any format works.
    add("split-alpha", "改为分离 Alpha（保持当前格式）", {
      alphaMode: "discard",
      alphaMask: true,
    });
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
  PRORES_QUALITY,
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
};
