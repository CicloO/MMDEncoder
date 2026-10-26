"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const trim = require("./trim.cjs"),
  media = require("./media.cjs");
const { containerFor } = trim;

// Naming only: the queue chooses the first ready clip and supplies its
// filesystem collision check. No queue, application state or output writes.
function trimOutputPath(first, o, exists) {
  let dir = path.dirname(first.path);
  if (o.location === "encoded") dir = path.join(dir, "Encoded");
  if (o.location === "custom") {
    if (typeof o.outputDir !== "string" || !path.isAbsolute(o.outputDir))
      throw Error("请选择有效的自定义输出目录");
    dir = o.outputDir;
  }
  let ext = containerFor(first.codec);
  if (o.audio?.mode !== "none" && o.audio?.codec === "pcm" && ext === "mp4")
    ext = "mkv";
  const base = path.parse(first.path).name + "_trimmed";
  for (let n = 1; n < 100000; n++) {
    const out = path.join(dir, base + (n === 1 ? "" : ` (${n})`) + "." + ext);
    if (!exists(out)) return out;
  }
  throw Error("无法分配不重名的输出文件");
}

// Owns one export's controller and transaction; the shared flags and UI
// fields have one owner in the service, reached through narrow callbacks.
function createTrimExport({
  getClips,
  getIndex,
  engineInfo,
  isRunning,
  isEncoding,
  isResourcesBusy,
  isSmart,
  updateExport,
  emit,
  emitProgress,
}) {
  let trimAbort = null;
  const TRIM_KEYS = {
    codec_name: "编码",
    profile: "档次",
    level: "级别",
    width: "宽度",
    height: "高度",
    pix_fmt: "像素格式",
    sample_aspect_ratio: "像素宽高比",
    field_order: "场序",
    color_range: "色彩范围",
    color_space: "色彩矩阵",
    color_primaries: "色域",
    color_transfer: "传输特性",
    time_base: "时间基",
    r_frame_rate: "帧率",
    extradata: "编码参数集",
    rotation: "旋转",
  };

  async function trimExport(o) {
    if (isRunning()) throw Error("正在导出");
    if (isEncoding()) throw Error("请等待当前压制结束后再导出");
    if (isResourcesBusy())
      throw Error("请等待编码器检测或工具管理结束后再导出");
    const clips = getClips().filter((c) => c.status === "ready" && !c.empty);
    if (!clips.length) throw Error("没有可导出的片段");
    if (getClips().some((c) => c.status === "indexing"))
      throw Error("请等待片段读取完成");
    const files = [...new Set(clips.map((c) => c.path))];
    if (files.length > 1) {
      const diffs = await trim.compatibility(engineInfo(), files);
      if (diffs.length) {
        const name = (i) => path.basename(files[i]);
        throw Error(
          "这些片段不能无损拼接：" +
            diffs
              .slice(0, 4)
              .map(
                (d) =>
                  `${name(d.part - 1)} 的${TRIM_KEYS[d.key] || d.key}与 ${name(0)} 不同${d.key === "extradata" ? "" : `（${d.value} / ${d.expected}）`}`,
              )
              .join("；"),
        );
      }
    }
    const audio = {
      mode: ["reencode", "replace", "none"].includes(o.audio?.mode)
        ? o.audio.mode
        : "reencode",
      codec: ["aac", "flac", "pcm"].includes(o.audio?.codec)
        ? o.audio.codec
        : "aac",
      kbps: Number(o.audio?.kbps) || 320,
      file: o.audio?.file,
      offset: Number(o.audio?.offset) || 0,
      fade: media.FADES.includes(Number(o.audio?.fade))
        ? Number(o.audio.fade)
        : 0,
    };
    const output = trimOutputPath(
      getClips().find((c) => c.status === "ready"),
      { ...o, audio },
      fs.existsSync,
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    trimAbort = new AbortController();
    updateExport({
      running: true,
      progress: 0,
      stage: "准备",
      output,
      error: "",
    });
    emit();
    (async () => {
      try {
        await trim.cut(
          engineInfo(),
          clips.map((c) => ({
            file: c.path,
            idx: getIndex(c.id),
            from: c.from,
            to: c.to,
          })),
          output,
          {
            audio,
            smart: isSmart(),
            signal: trimAbort.signal,
            onPart: (i, n) => {
              updateExport({
                progress: Math.round(
                  (i / (n + (audio.mode === "none" ? 0 : 1))) * 100,
                ),
                stage: `复制第 ${i} / ${n} 段`,
              });
              emitProgress();
            },
          },
        );
        updateExport({ progress: 100, stage: "完成" });
      } catch (e) {
        fs.rmSync(output, { force: true });
        updateExport({
          stage: e.cancelled ? "已取消" : "失败",
          error: e.cancelled ? "" : e.message,
          output: "",
        });
      } finally {
        updateExport({ running: false });
        trimAbort = null;
        emit();
      }
    })();
  }

  return {
    start: trimExport,
    cancel() {
      trimAbort?.abort();
    },
  };
}
module.exports = { createTrimExport, trimOutputPath };
