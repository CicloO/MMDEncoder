"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const trim = require("./trim.cjs");

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
function setClipRange(clip, idx, smart, from, to) {
  if (!idx) throw Error("片段还没有读取完成");
  const n = idx.frames.length;
  const exact = smart && !smartBlocker(idx);
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

// Owns indexes, shared reads and clip actions. The service owns the list
// container and busy flags, supplied only through these capabilities.
function createTrimClips({
  getClips,
  setClips,
  engineInfo,
  locate,
  emit,
  isRunning,
  isSmart,
  setSmart,
  reorder,
  onUnusedFile,
}) {
  function releaseUnused(file) {
    if (!getClips().some((c) => c.path === file)) onUnusedFile(file);
  }
  function applyRange(clip, from, to) {
    setClipRange(clip, trimIndexes.get(clip.id), isSmart(), from, to);
  }
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
        promise: trim.index(engineInfo(), file, { signal: ctl.signal }),
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
  function requireClip(id) {
    const c = getClips().find((c) => c.id === id);
    if (!c) throw Error("未找到这个片段");
    return c;
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
    setClips(getClips().filter((c) => !clips.includes(c)));
    for (const file of new Set(clips.map((c) => c.path))) releaseUnused(file);
  }
  async function trimAdd(paths) {
    await locate();
    if (!engineInfo().ffmpeg || !engineInfo().ffprobe)
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
      getClips().push(clip);
      emit();
      fileKeys.set(clip.id, key);
      const shared = getClips().find(
        (c) =>
          c !== clip && fileKeys.get(c.id) === key && trimIndexes.has(c.id),
      );
      try {
        const idx = shared
          ? trimIndexes.get(shared.id)
          : await readIndex(clip, file, key);
        if (!getClips().includes(clip)) continue; // removed meanwhile
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
        applyRange(clip, 0, "end");
      } catch (e) {
        if (!getClips().includes(clip)) continue;
        Object.assign(clip, { status: "invalid", error: e.message });
      } finally {
        reading.get(key)?.users.delete(clip.id);
      }
      emit();
    }
  }
  const actions = {
    async trimAdd(payload) {
      await trimAdd(payload?.paths);
    },
    async trimRemove(payload) {
      const clip = requireClip(payload?.id);
      if (isRunning()) throw Error("导出时不能移除片段");
      dropClips([clip]);
    },
    async trimDuplicate(payload) {
      // Another range of the same file.
      const clip = requireClip(payload?.id);
      if (clip.status !== "ready") throw Error("片段还没有读取完成");
      const copy = { ...clip, id: crypto.randomUUID() };
      trimIndexes.set(copy.id, trimIndexes.get(clip.id));
      fileKeys.set(copy.id, fileKeys.get(clip.id));
      getClips().splice(getClips().indexOf(clip) + 1, 0, copy);
    },
    async trimReorder(payload) {
      setClips(reorder(getClips(), payload.ids));
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
        applyRange(clip, payload.from, payload.to);
    },
    async trimSmart(payload) {
      if (isRunning()) throw Error("导出时不能切换");
      setSmart(!!payload?.smart);
      // Re-apply every clip's requested range under the new rule.
      for (const c of getClips())
        if (c.status === "ready" && c.requested)
          applyRange(
            c,
            c.requested.from,
            c.requested.to >= c.frames ? "end" : c.requested.to,
          );
    },
  };
  return {
    actions,
    requireClip,
    getIndex: (id) => trimIndexes.get(id),
    dropClips,
    stop() {
      for (const r of reading.values()) r.ctl.abort();
    },
  };
}
module.exports = { createTrimClips };
