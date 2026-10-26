"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { probeInfo, streamPackets, rational } = require("./trim-probe.cjs");
const { needsRemux, remuxed } = require("./trim-source.cjs");
const { INTRA } = require("./trim-range.cjs");

// H.264 NAL 5 = IDR. HEVC 19 / 20 = IDR (CRA 21 and BLA 16–18 may carry
// leading pictures that need the previous GOP, so they are not used).
const IDR = { h264: (t) => t === 5, hevc: (t) => t === 19 || t === 20 };

// NAL unit types of the given keyframe packets [decode, pos, size], read
// from an MP4 / MOV file where byte positions are exact and NAL units are
// length-prefixed. Returns Map(decode index -> types | null).
function nalTypes(file, keys, codec) {
  const fd = fs.openSync(file, "r");
  const out = new Map();
  try {
    for (const [d, pos, size] of keys) {
      if (!(size > 0) || !(pos >= 0)) {
        out.set(d, null);
        continue;
      }
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, pos);
      const types = [];
      let ok = true;
      for (let i = 0; i < size;) {
        if (i + 4 > size) {
          ok = false;
          break;
        }
        const len = buf.readUInt32BE(i);
        if (!len || i + 4 + len > size) {
          ok = false;
          break;
        }
        const h = buf[i + 4];
        types.push(codec === "h264" ? h & 0x1f : (h >> 1) & 0x3f);
        i += 4 + len;
      }
      out.set(d, ok ? types : null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

// Index of a file's video: frames in display order, each with its decode
// position and whether a cut may start there (and if not, why).
async function index(tools, file, { signal } = {}) {
  const info = await probeInfo(tools, file, signal);
  const s = info.streams[0];
  const codec = s.codec_name;
  if (codec !== "h264" && codec !== "hevc" && !INTRA.has(codec))
    return {
      codec,
      supported: false,
      reason: `暂不支持无损裁切 ${codec} 编码`,
    };
  const { pts, keys, missing } = await streamPackets(tools, file, signal);
  const n = pts.length;
  if (!n) throw Error("视频轨没有数据");
  if (missing) throw Error("视频包缺少时间戳，无法无损裁切");
  let types = new Map();
  if (codec === "h264" || codec === "hevc") {
    if (needsRemux(file, codec)) {
      const copy = await remuxed(tools, file, signal);
      const again = await streamPackets(tools, copy, signal);
      if (again.pts.length !== n)
        throw Error("无法读取视频包的类型（包数量不一致）");
      types = nalTypes(copy, again.keys, codec);
    } else types = nalTypes(file, keys, codec);
  }
  const keySet = new Set(keys.map((k) => k[0]));
  const tb = rational(s.time_base);
  const fps = rational(
    s.avg_frame_rate !== "0/0" ? s.avg_frame_rate : s.r_frame_rate,
  );
  // Display order: decode positions sorted by presentation time.
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => pts[a] - pts[b],
  );
  // Constant frame rate only: frame numbers, cut times and the audio length
  // all assume evenly spaced frames. Containers that round timestamps (MKV
  // stores milliseconds) wobble by a tick, which is allowed.
  if (n > 2) {
    const step = [];
    for (let i = 1; i < n; i++) step.push(pts[order[i]] - pts[order[i - 1]]);
    const sorted = [...step].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const tol = Math.max(1.5, median * 0.02);
    if (!(median > 0) || step.some((d) => Math.abs(d - median) > tol))
      return {
        codec,
        supported: false,
        reason:
          "可变帧率（VFR）的视频暂不支持无损剪辑，请先在“视频压制”里转成固定帧率",
      };
  }
  // For each decode position: the latest time shown by anything decoded
  // before it, and the earliest time shown by anything decoded after it
  // (O(n) in total instead of scanning around every IDR).
  const before = new Float64Array(n),
    after = new Float64Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    before[i] = max;
    if (pts[i] > max) max = pts[i];
  }
  let min = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    after[i] = min;
    if (pts[i] < min) min = pts[i];
  }
  const frames = new Array(n);
  for (let f = 0; f < n; f++) {
    const d = order[f];
    const key = keySet.has(d);
    let safe = false,
      why = "";
    if (INTRA.has(codec)) {
      safe = key;
      if (!safe) why = "不是关键帧";
    } else if (!key) why = "不是关键帧";
    else {
      const t = types.get(d);
      if (!t) why = "无法读取帧类型";
      else if (!t.some(IDR[codec]))
        why = "关键帧但不是 IDR（开放 GOP），从这里开始会花屏";
      // Nothing decoded later shows earlier, nothing decoded earlier later.
      else if (after[d] < pts[d] || before[d] > pts[d])
        why = "IDR 前后有交叉显示的帧，不能在这里切开";
      else safe = true;
    }
    frames[f] = {
      frame: f,
      decode: d,
      pts: pts[d],
      key,
      safe,
      ...(why ? { why } : {}),
    };
  }
  // MMDEncoder's own outputs say how they were encoded and, for MMD
  // exports, which MMD frame they start at; older ones only in the name.
  const tag = require("./core.cjs").readTag(info.format?.tags?.comment);
  const named = /_(\d{4,})-(\d{4,})f(?:_alpha)?(?: \(\d+\))?$/.exec(
    path.parse(file).name,
  );
  const mmdStart = Number.isInteger(tag?.mmd?.start)
    ? { frame: tag.mmd.start, from: "tag" }
    : named
      ? { frame: Number(named[1]), from: "name" }
      : null;
  return {
    supported: true,
    codec,
    timeBase: tb,
    fps,
    // Seconds where the file's timeline begins: -ss positions count from it.
    startTime: Number(info.format?.start_time) || 0,
    width: s.width,
    height: s.height,
    pixFmt: s.pix_fmt,
    encoding: tag?.enc || null,
    mmdStart,
    frames,
  };
}
module.exports = { index };
