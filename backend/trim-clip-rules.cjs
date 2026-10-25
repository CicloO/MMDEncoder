"use strict";
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

module.exports = { smartBlocker, setClipRange };
