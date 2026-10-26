"use strict";
const { execFile } = require("node:child_process");
const { seekTime } = require("./trim-range.cjs");

// One frame as a JPEG (Buffer), height px tall, for the editor's preview.
// Seeks by the frame's presentation time relative to the first frame; the
// seek decodes up to it, so the picture is that exact frame. Only the main
// picture is shown (no alpha).
function frameJpeg(tools, idx, file, frame, { height = 360, signal } = {}) {
  const f = idx.frames[Math.max(0, Math.min(idx.frames.length - 1, frame))];
  const step = idx.fps.num ? idx.fps.den / idx.fps.num : 1 / 30;
  // A quarter frame early: the decoding seek keeps the first frame at or
  // after it, which is this frame.
  const t = Math.max(0, seekTime(idx, f.frame) - step / 4);
  return new Promise((resolve, reject) =>
    execFile(
      tools.ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        t.toFixed(6),
        "-i",
        file,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        `scale=-2:${height}`,
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-q:v",
        "4",
        "-",
      ],
      { windowsHide: true, encoding: "buffer", maxBuffer: 64 << 20, signal },
      (e, out) =>
        signal?.aborted
          ? reject(Object.assign(Error("已取消"), { cancelled: true }))
          : e
            ? reject(e)
            : resolve(out),
    ),
  );
}
module.exports = { frameJpeg };
