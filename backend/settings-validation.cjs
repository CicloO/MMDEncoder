"use strict";
const path = require("node:path");
const { FADES } = require("./media.cjs");
const { ENGINES } = require("./definitions.cjs");
const { parseFps, dimensions } = require("./filter.cjs");
const { maskSettings } = require("./mask-settings.cjs");
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
  // Mask only: the colour encoder and audio settings are not used, so check
  // the mask's own encoding; RTX stays refused and the source needs alpha.
  if (s.alphaMode === "mask") {
    const e = validate({ ...maskSettings(s), vsr: false, vfg: false }, meta);
    if (s.vsr || s.vfg)
      e.push("RTX VSR / VFG 暂不能与保留 Alpha 或独立 Alpha 遮罩组合");
    if (meta && !meta.hasAlpha) e.push("源视频没有可读 Alpha，不能生成遮罩");
    return [...new Set(e)];
  }
  const e = [];
  const check = (ok, msg) => {
    if (!ok) e.push(msg);
  };
  const eng = ENGINES.find((x) => x.id === s.encoder);
  if (s.vsr || s.vfg) {
    check(eng?.backend === "nvencc", "RTX VSR / VFG 需要 NVEncC 编码器");
    check(
      s.alphaMode !== "preserve" && !s.alphaMask,
      "RTX VSR / VFG 暂不能与保留 Alpha 或独立 Alpha 遮罩组合",
    );
    check(
      s.bitDepth === 8 && s.chroma === "420",
      "RTX VSR / VFG 使用 8-bit 4:2:0",
    );
  }
  check(
    ["lanczos", "artcnn"].includes(s.upscaler ?? "lanczos"),
    "放大算法无效",
  );
  check(
    ["C4F16", "C4F32"].includes(s.artcnnModel ?? "C4F16"),
    "ArtCNN 模型无效",
  );
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
    // color = composited over alphaBackground; mask = only the
    // black-and-white alpha mask, no colour video.
    alphaMode: ["discard", "color", "preserve", "mask"],
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
  check(
    FADES.includes(s.audioFade ?? 0),
    "音频淡入淡出无效，请选择列表中的时长",
  );
  check(typeof s.alphaMask === "boolean", "透明遮罩开关无效");
  check(/^#[0-9a-f]{6}$/i.test(s.alphaBackground), "背景颜色须为 #RRGGBB");
  check(typeof s.hiRes === "boolean", "Hi-Res 开关无效");
  check(typeof s.editFriendly === "boolean", "剪辑友好开关无效");
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
module.exports = { filename, validate };
