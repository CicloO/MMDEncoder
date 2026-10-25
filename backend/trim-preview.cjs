"use strict";
const trim = require("./trim.cjs");
// Owns the JPEG LRU and one preview controller, never clip/app state.
function createTrimPreview({ engineInfo, requireClip, getIndex }) {
  let previewAbort = null;
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

  function release(file) {
    for (const [key, url] of previews)
      if (key.startsWith(file + "|")) {
        previews.delete(key);
        previewBytes -= url.length;
      }
  }
  async function frame(payload) {
    // One preview at a time: a newer request stops the older one.
    const clip = requireClip(payload?.id);
    const idx = getIndex(clip.id);
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
      const jpeg = await trim.frameJpeg(engineInfo(), idx, clip.path, frame, {
        signal: ctl.signal,
      });
      const url = "data:image/jpeg;base64," + jpeg.toString("base64");
      rememberPreview(key, url);
      return url;
    } catch (e) {
      if (e.cancelled) return null;
      throw e;
    }
  }
  return {
    frame,
    release,
    stop() {
      previewAbort?.abort();
    },
  };
}
module.exports = { createTrimPreview };
