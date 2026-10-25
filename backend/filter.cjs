// The FFmpeg video filter graph for an encode, and the pure helpers it
// shares with core.cjs (output size, pixel format, frame rate, ArtCNN choice).
const path = require("node:path");
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
// The background of alphaMode "color" as [r, g, b] (0–255).
const background = (s) =>
  [1, 3, 5].map((i) => parseInt(s.alphaBackground.slice(i, i + 2), 16));
const artcnnPath = (s) =>
  path.join(
    __dirname,
    "..",
    "assets",
    "shaders",
    `ArtCNN_${s.artcnnModel || "C4F16"}.glsl`,
  );
// ArtCNN only enlarges; shrinking (or keeping the size) stays with Lanczos.
// ArtCNN is a 2x model: its shader only runs when both sides grow by more
// than 1.3x (its own //!WHEN), and libplacebo scales the 2x result to the
// target. Below that the shader would silently do nothing, so Lanczos is
// used instead. The mask is always Lanczos.
const ARTCNN_MIN = 1.3;
function usesArtcnn(s, meta) {
  return s.upscaler === "artcnn" && !s.vsr && !artcnnSkipped(s, meta);
}
// Why ArtCNN, though selected, is not used for this source ("" = it is used,
// or it is not selected at all).
function artcnnSkipped(s, meta) {
  if (s.upscaler !== "artcnn" || s.vsr) return "";
  if (s.alphaMode === "mask") return "只导出遮罩，遮罩用 Lanczos 放大";
  if (s.resizeMode === "source") return "保持源分辨率，没有放大";
  const size = dimensions(s, meta);
  const sx = size.width / (meta.width || size.width),
    sy = size.height / (meta.height || size.height);
  if (!(sx > ARTCNN_MIN && sy > ARTCNN_MIN))
    return `宽高都要放大超过 ${ARTCNN_MIN} 倍才会用 ArtCNN（这里是 ${sx.toFixed(2)} × ${sy.toFixed(2)} 倍），改用 Lanczos`;
  return "";
}
// A file path as a filter option value, escaped for both levels FFmpeg
// parses: the option value (\ ' :) and then the filter graph (\ ' [ ] , ;).
const filterPath = (p) =>
  p
    .replace(/\\/g, "/")
    .replace(/[\\':]/g, (c) => "\\" + c)
    .replace(/[\\'[\],;]/g, (c) => "\\" + c);
// FFmpeg's part before VSR in NVEncC: everything except the resize.
function vsrPrepare(s) {
  return { ...s, vsr: false, upscaler: "lanczos", resizeMode: "source" };
}
function filter(s, meta, mask) {
  const f = [];
  // YUV sources without a colour matrix tag are read as BT.709: FFmpeg would
  // assume BT.601 and shift the colours of most HD videos. Tagging the
  // frames first makes every conversion below agree.
  if (
    !mask &&
    [undefined, "", "unknown", "unspecified"].includes(meta.colorSpace) &&
    /^(?:yuv|yuva|nv12|nv21|p0|p2|p4)/.test(meta.pixFmt || "")
  )
    f.push("setparams=colorspace=bt709");
  if (mask) f.push("alphaextract");
  else if (meta.hasAlpha && s.alphaMode === "color") {
    // A copy of the frame turned into the opaque background colour, with the
    // frame laid over it: overlay blends with SIMD, about 8× faster at 4K
    // than a per-pixel geq, and gives the same pixels (±1 from rounding).
    // The background must be opaque, or overlay darkens it by its alpha.
    // Packed RGBA as before: FFmpeg turns YUVA into planar gbrap with other
    // chroma upsampling, up to ~130 levels off at sharp colour edges.
    const [r, g, b] = background(s);
    f.push(
      "format=rgba",
      `split[bg][fg];[bg]lutrgb=r=${r}:g=${g}:b=${b}:a=255[bgc];[bgc][fg]overlay=format=rgb`,
    );
  }
  const fps = parseFps(s.fps);
  if (fps) f.push("fps=" + fps.text);
  const size = dimensions(s, meta);
  const shader = !mask && usesArtcnn(s, meta);
  const range = (r) => (r === "pc" ? "pc" : "tv");
  const matrix = (m) =>
    m === "bt601" ? "smpte170m" : m === "bt2020" ? "bt2020nc" : m;
  if (shader) {
    // ArtCNN works on the luma plane: YUV frames go to the GPU as they are,
    // anything else (RGB, a colour background composited above) becomes
    // YUV first (in the output's matrix and range), or the shader silently
    // does nothing. libplacebo then also converts matrix and range and hands
    // back the output pixel format, so no 4K frame is converted on the CPU
    // (a 16-bit 4:4:4 copy back was a third of the speed). Its conversion
    // matches zimg; untagged sources count as BT.709, as in the scale below.
    // libplacebo blends colour with alpha (dark where transparent), so the
    // colour goes up without alpha, and kept alpha is enlarged with Lanczos
    // beside it and merged back.
    const keepAlpha = meta.hasAlpha && s.alphaMode === "preserve";
    const yuv =
      !(meta.hasAlpha && s.alphaMode === "color") &&
      /^(?:yuv|yuva|nv12|nv21|p0|p2|p4|gray)/.test(meta.pixFmt || "");
    const colour = [];
    if (!yuv)
      colour.push(
        `scale=out_range=${s.colorRange}:out_color_matrix=${s.colorSpace}`,
        "format=yuv444p" + ((meta.bitDepth || 8) > 8 ? "16le" : ""),
      );
    else if (/^yuva/.test(meta.pixFmt))
      // (scale converts here, so the split above still carries alpha)
      colour.push("scale", "format=" + meta.pixFmt.replace(/^yuva/, "yuv"));
    const known = (v) => v && v !== "unknown" && v !== "unspecified";
    const out = pix(s).replace(/^yuva/, "yuv");
    colour.push(
      `setparams=colorspace=${
        yuv
          ? known(meta.colorSpace)
            ? meta.colorSpace
            : "bt709"
          : matrix(s.colorSpace)
      }:range=${yuv ? range(meta.colorRange) : range(s.colorRange)}`,
      "hwupload",
      `libplacebo=w=${size.width}:h=${size.height}:custom_shader_path=${filterPath(artcnnPath(s))}:colorspace=${matrix(s.colorSpace)}:range=${range(s.colorRange)}:format=${out}`,
      "hwdownload",
      `format=${out}`,
    );
    if (keepAlpha)
      f.push(
        `split[c][a];[c]${colour.join(",")}[cc];[a]alphaextract,scale=${size.width}:${size.height}:flags=lanczos[aa];[cc][aa]alphamerge`,
        `format=${pix(s)}`,
      );
    else f.push(...colour);
  } else {
    const resize =
      s.resizeMode !== "source"
        ? `w=${size.width}:h=${size.height}:flags=lanczos:`
        : "";
    f.push(
      `scale=${resize}in_range=${mask ? "pc" : meta.colorRange === "pc" ? "pc" : meta.colorRange === "tv" ? "tv" : "auto"}:out_range=${s.colorRange}:out_color_matrix=${s.colorSpace}`,
      `format=${pix(s)}`,
    );
  }
  if (s.resizeMode !== "source") f.push("setsar=1");
  return f.join(",");
}
module.exports = {
  parseFps,
  dimensions,
  pix,
  usesArtcnn,
  artcnnSkipped,
  vsrPrepare,
  filter,
};
