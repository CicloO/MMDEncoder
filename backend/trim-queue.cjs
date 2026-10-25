"use strict";
// Lossless trim page (无损剪辑): clips of files, each a frame range snapped
// to safe cut points (trim.cjs), their preview frames, and the export that
// joins them without re-encoding.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const trim = require("./trim.cjs");
const media = require("./media.cjs");

// ctx: the service's shared state and helpers (see createService).
function createTrimQueue(ctx) {
  const { state, emit, emitProgress, locate, reorder, tools } = ctx;
  // Indexes stay here (they can be large); the window gets what it shows.
  const trimIndexes = new Map(); // clip id -> index
  // A file added again (same path, size and date) shares the index of the
  // clips already there, or their reading still in progress; that reading
  // stops only when every clip waiting for it is removed.
  const fileKeys = new Map(); // clip id -> "path|size|mtime"
  const reading = new Map(); // file key -> { promise, ctl, users: Set<clip id> }
  function readIndex(clip, file, key) {
    let r = reading.get(key);
    if (!r) {
      const ctl = new AbortController();
      r = {
        ctl,
        users: new Set(),
        promise: trim.index(state.engineInfo, file, { signal: ctl.signal }),
      };
      reading.set(key, r);
      const entry = r;
      r.promise
        .finally(() => reading.get(key) === entry && reading.delete(key))
        .catch(() => {});
    }
    r.users.add(clip.id);
    return r.promise;
  }
  let trimAbort = null,
    previewAbort = null;
  // A file's cached copy (non-MP4 H.264 / HEVC) goes once no clip uses it.
  function releaseUnused(file) {
    if (state.trim.clips.some((c) => c.path === file)) return;
    trim.release(file);
    for (const [key, url] of previews)
      if (key.startsWith(file + "|")) {
        previews.delete(key);
        previewBytes -= url.length;
      }
  }
  // Recent preview frames (data URLs), so stepping back to a frame just seen
  // needs no FFmpeg run. Bounded by total size; oldest go first.
  const previews = new Map(); // "path|frame" -> data URL
  const PREVIEW_BYTES = 32 * 1024 * 1024;
  let previewBytes = 0;
  function rememberPreview(key, url) {
    previews.set(key, url);
    previewBytes += url.length;
    for (const [k, v] of previews) {
      if (previewBytes <= PREVIEW_BYTES) break;
      previews.delete(k);
      previewBytes -= v.length;
    }
  }
  function dropClips(clips) {
    for (const c of clips) {
      const r = reading.get(fileKeys.get(c.id));
      if (r) {
        r.users.delete(c.id);
        if (!r.users.size) r.ctl.abort();
      }
      fileKeys.delete(c.id);
      trimIndexes.delete(c.id); // other clips of the file keep their own
    }
    state.trim.clips = state.trim.clips.filter((c) => !clips.includes(c));
    for (const file of new Set(clips.map((c) => c.path))) releaseUnused(file);
  }
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
  function requireClip(id) {
    const c = state.trim.clips.find((c) => c.id === id);
    if (!c) throw Error("未找到这个片段");
    return c;
  }
  // Why a clip cannot be smart-cut ("" = it can, or needs no re-encoding).
  function smartBlocker(idx) {
    if (idx.frames.every((f) => f.safe)) return "";
    if (!idx.encoding)
      return "没有记录编码参数（不是 MMDEncoder 1.5.0 起导出的）";
    if (String(idx.encoding.encoder).startsWith("nvencc:"))
      return "NVEncC 编码的文件暂不支持";
    return "";
  }
  // The clip's requested range, snapped to safe cut points (out may be the
  // end) — or, with smart cut on a clip that allows it, exactly as asked.
  function setClipRange(clip, from, to) {
    const idx = trimIndexes.get(clip.id);
    if (!idx) throw Error("片段还没有读取完成");
    const n = idx.frames.length;
    const exact = state.trim.smart && !smartBlocker(idx);
    const clamp = (v) => Math.max(0, Math.min(n, Math.round(Number(v) || 0)));
    const a = exact
      ? Math.min(clamp(from), n - 1)
      : trim.snap(idx, Number(from) || 0);
    const b = exact
      ? to === "end"
        ? n
        : clamp(to)
      : trim.snap(idx, to === "end" ? n : Number(to), { end: true });
    Object.assign(clip, {
      requested: { from: Number(from) || 0, to: to === "end" ? n : Number(to) },
      from: a,
      to: b,
      empty: a >= b,
    });
  }
  async function trimAdd(paths) {
    await locate();
    if (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe)
      throw Error("请先安装 FFmpeg / ffprobe");
    for (const raw of paths || []) {
      if (typeof raw !== "string" || !path.isAbsolute(raw)) continue;
      const file = path.resolve(raw);
      let key;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        key = [file.toLowerCase(), st.size, st.mtimeMs].join("|");
      } catch {
        continue;
      }
      const clip = {
        id: crypto.randomUUID(),
        path: file,
        name: path.basename(file),
        status: "indexing",
      };
      state.trim.clips.push(clip);
      emit();
      fileKeys.set(clip.id, key);
      const shared = state.trim.clips.find(
        (c) =>
          c !== clip && fileKeys.get(c.id) === key && trimIndexes.has(c.id),
      );
      try {
        const idx = shared
          ? trimIndexes.get(shared.id)
          : await readIndex(clip, file, key);
        if (!state.trim.clips.includes(clip)) continue; // removed meanwhile
        if (!idx.supported) throw Error(idx.reason);
        trimIndexes.set(clip.id, idx);
        const safe = idx.frames.filter((f) => f.safe).map((f) => f.frame);
        Object.assign(clip, {
          status: "ready",
          codec: idx.codec,
          width: idx.width,
          height: idx.height,
          fps: idx.fps,
          frames: idx.frames.length,
          // Every frame, or the list of frames a cut may start at.
          cuts: safe.length === idx.frames.length ? "all" : safe,
          // MMD frame of the video's first frame (from MMDEncoder's tag or
          // the _0400-0600f name), and whether the encode settings are known.
          mmdStart: idx.mmdStart?.frame ?? null,
          mmdStartFrom: idx.mmdStart?.from || "",
          encoding: idx.encoding,
          smartBlocker: smartBlocker(idx),
          refused:
            safe.length < idx.frames.filter((f) => f.key).length
              ? [
                  ...new Set(
                    idx.frames
                      .filter((f) => f.key && !f.safe)
                      .map((f) => f.why),
                  ),
                ]
              : [],
        });
        setClipRange(clip, 0, "end");
      } catch (e) {
        if (!state.trim.clips.includes(clip)) continue;
        Object.assign(clip, { status: "invalid", error: e.message });
      } finally {
        reading.get(key)?.users.delete(clip.id);
      }
      emit();
    }
  }
  function trimOutputPath(o) {
    const first = state.trim.clips.find((c) => c.status === "ready");
    let dir = path.dirname(first.path);
    if (o.location === "encoded") dir = path.join(dir, "Encoded");
    if (o.location === "custom") {
      if (typeof o.outputDir !== "string" || !path.isAbsolute(o.outputDir))
        throw Error("请选择有效的自定义输出目录");
      dir = o.outputDir;
    }
    let ext = trim.containerFor(first.codec);
    if (o.audio?.mode !== "none" && o.audio?.codec === "pcm" && ext === "mp4")
      ext = "mkv";
    const base = path.parse(first.path).name + "_剪辑";
    for (let n = 1; n < 100000; n++) {
      const out = path.join(dir, base + (n === 1 ? "" : ` (${n})`) + "." + ext);
      if (!fs.existsSync(out)) return out;
    }
    throw Error("无法分配不重名的输出文件");
  }
  async function trimExport(o) {
    if (state.trim.running) throw Error("正在导出");
    if (state.running) throw Error("请等待当前压制结束后再导出");
    if (state.detecting || tools.state.busy || state.enhancements.busy)
      throw Error("请等待编码器检测或工具管理结束后再导出");
    const clips = state.trim.clips.filter(
      (c) => c.status === "ready" && !c.empty,
    );
    if (!clips.length) throw Error("没有可导出的片段");
    if (state.trim.clips.some((c) => c.status === "indexing"))
      throw Error("请等待片段读取完成");
    const files = [...new Set(clips.map((c) => c.path))];
    if (files.length > 1) {
      const diffs = await trim.compatibility(state.engineInfo, files);
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
    const output = trimOutputPath({ ...o, audio });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    trimAbort = new AbortController();
    Object.assign(state.trim, {
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
          state.engineInfo,
          clips.map((c) => ({
            file: c.path,
            idx: trimIndexes.get(c.id),
            from: c.from,
            to: c.to,
          })),
          output,
          {
            audio,
            smart: state.trim.smart,
            signal: trimAbort.signal,
            onPart: (i, n) => {
              Object.assign(state.trim, {
                progress: Math.round(
                  (i / (n + (audio.mode === "none" ? 0 : 1))) * 100,
                ),
                stage: `复制第 ${i} / ${n} 段`,
              });
              emitProgress();
            },
          },
        );
        Object.assign(state.trim, { progress: 100, stage: "完成" });
      } catch (e) {
        fs.rmSync(output, { force: true });
        Object.assign(state.trim, {
          stage: e.cancelled ? "已取消" : "失败",
          error: e.cancelled ? "" : e.message,
          output: "",
        });
      } finally {
        state.trim.running = false;
        trimAbort = null;
        emit();
      }
    })();
  }

  const actions = {
    async trimAdd(payload) {
      await trimAdd(payload?.paths);
    },
    async trimRemove(payload) {
      const clip = requireClip(payload?.id);
      if (state.trim.running) throw Error("导出时不能移除片段");
      dropClips([clip]);
    },
    async trimDuplicate(payload) {
      // Another range of the same file.
      const clip = requireClip(payload?.id);
      if (clip.status !== "ready") throw Error("片段还没有读取完成");
      const copy = { ...clip, id: crypto.randomUUID() };
      trimIndexes.set(copy.id, trimIndexes.get(clip.id));
      fileKeys.set(copy.id, fileKeys.get(clip.id));
      state.trim.clips.splice(state.trim.clips.indexOf(clip) + 1, 0, copy);
    },
    async trimReorder(payload) {
      state.trim.clips = reorder(state.trim.clips, payload.ids);
    },
    async trimSet(payload) {
      const clip = requireClip(payload?.id);
      if (payload.mmdStart !== undefined) {
        const n = Number(payload.mmdStart);
        if (!Number.isInteger(n) || n < 0)
          throw Error("MMD 起始帧须为 0 或正整数");
        Object.assign(clip, { mmdStart: n, mmdStartFrom: "manual" });
      }
      if (payload.from !== undefined)
        setClipRange(clip, payload.from, payload.to);
    },
    async trimExport(payload) {
      await trimExport(payload || {});
    },
    async trimSmart(payload) {
      if (state.trim.running) throw Error("导出时不能切换");
      state.trim.smart = !!payload?.smart;
      // Re-apply every clip's requested range under the new rule.
      for (const c of state.trim.clips)
        if (c.status === "ready" && c.requested)
          setClipRange(
            c,
            c.requested.from,
            c.requested.to >= c.frames ? "end" : c.requested.to,
          );
    },
    async trimCancel(payload) {
      trimAbort?.abort();
    },
    async trimClear(payload) {
      if (state.trim.running) throw Error("导出时不能清空");
      dropClips([...state.trim.clips]);
      Object.assign(state.trim, {
        output: "",
        error: "",
        stage: "",
        progress: 0,
      });
    },
  };
  const queries = {
    async trimFrame(payload) {
      // One preview at a time: a newer request stops the older one.
      const clip = requireClip(payload?.id);
      const idx = trimIndexes.get(clip.id);
      if (!idx) throw Error("片段还没有读取完成");
      const frame = Number(payload.frame) || 0;
      const key = clip.path + "|" + frame;
      previewAbort?.abort();
      if (previews.has(key)) {
        const url = previews.get(key);
        previews.delete(key); // most recently used goes last
        previews.set(key, url);
        return url;
      }
      const ctl = (previewAbort = new AbortController());
      try {
        const jpeg = await trim.frameJpeg(
          state.engineInfo,
          idx,
          clip.path,
          frame,
          {
            signal: ctl.signal,
          },
        );
        const url = "data:image/jpeg;base64," + jpeg.toString("base64");
        rememberPreview(key, url);
        return url;
      } catch (e) {
        if (e.cancelled) return null;
        throw e;
      }
    },
  };
  return {
    actions,
    queries,
    // The app is closing: stop the export, the preview and any indexing.
    stop() {
      trimAbort?.abort();
      previewAbort?.abort();
      for (const r of reading.values()) r.ctl.abort();
    },
  };
}
module.exports = { createTrimQueue };
