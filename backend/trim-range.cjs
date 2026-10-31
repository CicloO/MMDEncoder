"use strict";
const { appError } = require("./errors.cjs");

// Codecs whose every frame stands alone.
const INTRA = new Set([
  "prores",
  "utvideo",
  "ffv1",
  "dnxhd",
  "mjpeg",
  "huffyuv",
  "ffvhuff",
  "rawvideo",
  "png",
  "qtrle",
]);

// Seconds from the start of the file (what -ss expects) to a frame.
const seekTime = (idx, frame) =>
  (idx.frames[frame].pts * idx.timeBase.num) / idx.timeBase.den -
  (idx.startTime || 0);

// The safe point nearest to a frame number (ties go to the earlier one);
// frames.length means "end of file", always allowed as an out point.
function snap(idx, frame, { end = false } = {}) {
  const n = idx.frames.length;
  frame = Math.max(0, Math.min(n, Math.round(frame)));
  if (end && frame >= n) return n;
  const points = safePoints(idx);
  if (!points.length && !end) throw appError("TRIM_NO_CUT_POINTS");
  // The first point at or after the frame, and the one before it.
  const i = firstAtLeast(points, frame);
  const after = i < points.length ? points[i] : end ? n : undefined;
  const before = i > 0 ? points[i - 1] : undefined;
  if (before === undefined) return after;
  if (after === undefined) return before;
  return frame - before <= after - frame ? before : after;
}

// The safe cut points of an index, in display order: worked out once per
// index (a 100,000-frame file took 0.4 ms a lookup filtering every time).
const safeCache = new WeakMap();

function safePoints(idx) {
  let points = safeCache.get(idx);
  if (!points) {
    points = idx.frames.filter((f) => f.safe).map((f) => f.frame);
    safeCache.set(idx, points);
  }
  return points;
}

// Index of the first value >= x in an ascending list (its length if none).
function firstAtLeast(list, x) {
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Packets of the display range [from, to): checked to be exactly a run of
// packets in decode order that shows exactly those frames.
function segment(idx, from, to) {
  const n = idx.frames.length;
  if (!(from >= 0 && to <= n && from < to))
    throw appError("TRIM_INVALID_RANGE");
  const start = idx.frames[from];
  if (!start.safe)
    throw appError("TRIM_UNSAFE_IN", {
      frame: from,
      detail: start.why,
      reason: start.whyData || start.why,
    });
  if (to < n && !idx.frames[to].safe)
    throw appError("TRIM_UNSAFE_OUT", {
      frame: to,
      detail: idx.frames[to].why,
      reason: idx.frames[to].whyData || idx.frames[to].why,
    });
  const firstDecode = start.decode;
  const lastDecode = to < n ? idx.frames[to].decode : n;
  const shown = idx.frames
    .slice(from, to)
    .map((f) => f.decode)
    .sort((a, b) => a - b);
  const ok =
    shown.length === lastDecode - firstDecode &&
    shown.every((d, i) => d === firstDecode + i);
  if (!ok) throw appError("TRIM_NONCONTIGUOUS", { from, to });
  return { from, to, startPts: start.pts, count: to - from };
}

// Seconds of a segment: where it starts in its file and how long it lasts.
function timing(s) {
  const { frames, timeBase: tb, fps } = s.idx;
  const sec = (v) => (v * tb.num) / tb.den;
  const frame = fps.num ? fps.den / fps.num : 0;
  const end =
    s.to < frames.length
      ? sec(frames[s.to].pts)
      : sec(frames[frames.length - 1].pts) + frame;
  // Audio is cut on the streams' own timeline, so absolute times.
  return {
    start: sec(frames[s.from].pts),
    length: end - sec(frames[s.from].pts),
  };
}

// Smart cut: how a segment [from, to) is made. Whole runs between cut
// points are copied; only the frames before the first cut point inside the
// segment and after the last one are re-encoded (frame-exact), with the
// settings the file was encoded with.
function pieces(s, smart) {
  const { idx } = s;
  const n = idx.frames.length;
  if (!smart || idx.frames.every((f) => f.safe))
    return [{ copy: true, from: s.from, to: s.to }];
  const safe = safePoints(idx);
  const a = safe[firstAtLeast(safe, s.from)] ?? n;
  // The last safe point at or before s.to.
  const b = s.to === n ? n : (safe[firstAtLeast(safe, s.to + 1) - 1] ?? 0);
  if (a >= b) return [{ copy: false, from: s.from, to: s.to }];
  return [
    ...(s.from < a ? [{ copy: false, from: s.from, to: a }] : []),
    { copy: true, from: a, to: b },
    ...(b < s.to ? [{ copy: false, from: b, to: s.to }] : []),
  ];
}

// Container the copied video goes into for a codec (and for the parts).
const containerFor = (codec) =>
  codec === "prores"
    ? "mov"
    : codec === "h264" || codec === "hevc"
      ? "mp4"
      : "mkv";
module.exports = {
  INTRA,
  seekTime,
  snap,
  segment,
  timing,
  pieces,
  containerFor,
};
