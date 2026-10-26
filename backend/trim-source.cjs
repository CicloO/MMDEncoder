"use strict";
// Source media I/O, indexing and the shared remux cache have one owner.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { appError, serializeError, sourceText } = require("./errors.cjs");
const { INTRA, seekTime } = require("./trim-range.cjs");

// signal: an AbortSignal that stops the process (cancel).
function run(exe, args, { timeout = 0, maxBuffer = 1 << 30, signal } = {}) {
  return new Promise((resolve, reject) =>
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, maxBuffer, encoding: "utf8", signal },
      (e, stdout, stderr) =>
        signal?.aborted
          ? reject(
              Object.assign(appError("TRIM_CANCELLED"), { cancelled: true }),
            )
          : e
            ? reject(
                Object.assign(
                  Error((stderr || e.message).trim().slice(-2000)),
                  {
                    stderr,
                  },
                ),
              )
            : resolve({ stdout, stderr }),
    ),
  );
}

const rational = (s) => {
  const [n, d = 1] = String(s || "0")
    .split("/")
    .map(Number);
  return d ? { num: n, den: d } : { num: 0, den: 1 };
};

// Stream and container facts (small), separate from the packet list.
async function probeInfo(tools, file, signal) {
  const { stdout } = await run(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,time_base,avg_frame_rate,r_frame_rate,width,height,pix_fmt:format=start_time:format_tags=comment",
      "-of",
      "json",
      file,
    ],
    { signal, timeout: 60000 },
  );
  const j = JSON.parse(stdout);
  if (!j.streams?.length) throw appError("TRIM_NO_VIDEO");
  return j;
}

// The video packets, read as ffprobe prints them (one line each) instead of
// one JSON document, so a long file is never held as text or as one object
// per field; only keyframes keep their byte position and size.
function streamPackets(tools, file, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      tools.ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts,flags,pos,size",
        "-of",
        "compact=p=0",
        file,
      ],
      { windowsHide: true, signal },
    );
    let pts = new Float64Array(4096),
      n = 0,
      missing = false,
      rest = "",
      stderr = "";
    const keys = []; // [decode index, pos, size] of keyframes
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let p = NaN,
          key = false,
          pos = -1,
          size = 0;
        for (const field of line.split("|")) {
          const eq = field.indexOf("=");
          const k = field.slice(0, eq),
            v = field.slice(eq + 1);
          if (k === "pts") p = Number(v);
          else if (k === "flags") key = v.startsWith("K");
          else if (k === "pos") pos = Number(v);
          else if (k === "size") size = Number(v);
        }
        if (!Number.isFinite(p)) missing = true;
        if (n === pts.length) {
          const grown = new Float64Array(pts.length * 2);
          grown.set(pts);
          pts = grown;
        }
        if (key) keys.push([n, pos, size]);
        pts[n++] = p;
      }
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (e) =>
      reject(
        signal?.aborted
          ? Object.assign(appError("TRIM_CANCELLED"), { cancelled: true })
          : e,
      ),
    );
    child.on("close", (code) => {
      if (signal?.aborted)
        return reject(
          Object.assign(appError("TRIM_CANCELLED"), { cancelled: true }),
        );
      if (code)
        return reject(
          stderr.trim()
            ? Error(stderr.trim())
            : appError("TRIM_PACKET_READ_FAILED"),
        );
      resolve({ pts: pts.subarray(0, n), keys, missing });
    });
  });
}

// Parameters every joined segment must share (P03 of the review). Returns a
// list of differences; extradata is compared too.
async function compatibility(tools, files) {
  const keys = [
    "codec_name",
    "profile",
    "level",
    "width",
    "height",
    "pix_fmt",
    "sample_aspect_ratio",
    "field_order",
    "color_range",
    "color_space",
    "color_primaries",
    "color_transfer",
    "time_base",
    "r_frame_rate",
  ];
  const infos = [];
  for (const file of files) {
    const { stdout } = await run(tools.ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_streams",
      "-show_data",
      "-of",
      "json",
      file,
    ]);
    const s = JSON.parse(stdout).streams[0];
    infos.push({
      file,
      values: Object.fromEntries(keys.map((k) => [k, s[k] ?? ""])),
      extradata: (s.extradata || "").replace(/\s+/g, ""),
      rotation:
        s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
    });
  }
  const diffs = [];
  const [first] = infos;
  infos.slice(1).forEach((info, i) => {
    for (const k of keys)
      if (info.values[k] !== first.values[k])
        diffs.push({
          part: i + 2,
          key: k,
          value: info.values[k],
          expected: first.values[k],
        });
    if (info.extradata !== first.extradata)
      diffs.push({
        part: i + 2,
        key: "extradata",
        value: sourceText("error.TRIM_PARAMETER_SETS_DIFFER"),
        expected: "",
      });
    if (info.rotation !== first.rotation)
      diffs.push({
        part: i + 2,
        key: "rotation",
        value: info.rotation,
        expected: first.rotation,
      });
  });
  return diffs;
}

// H.264 / HEVC outside MP4 / MOV: the same packets copied into an MP4, which
// gives exact packet positions (index) and reliable seeking (cut). Kept per
// source (path, size, date) for the session, so indexing and exporting copy
// the stream once; release() / clearCache() remove them.
const remuxCache = new Map();

// key -> { file, promise }
const cacheDir = () => path.join(os.tmpdir(), "mmdencoder-trim-cache");

function sourceKey(file) {
  const st = fs.statSync(file);
  return `${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}`;
}

function needsRemux(file, codec) {
  return (
    (codec === "h264" || codec === "hevc") &&
    ![".mp4", ".mov", ".m4v"].includes(path.extname(file).toLowerCase())
  );
}

async function remuxed(tools, file, signal) {
  const key = sourceKey(file);
  let entry = remuxCache.get(key);
  if (!entry) {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const out = path.join(
      cacheDir(),
      require("node:crypto")
        .createHash("sha1")
        .update(key)
        .digest("hex")
        .slice(0, 16) + ".mp4",
    );
    entry = {
      file: out,
      promise: (async () => {
        fs.rmSync(out, { force: true });
        await run(
          tools.ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-f",
            "mp4",
            out,
          ],
          { signal },
        );
        return out;
      })(),
    };
    remuxCache.set(key, entry);
    entry.promise.catch(() => {
      remuxCache.delete(key);
      fs.rmSync(out, { force: true });
    });
  }
  return entry.promise;
}

function release(file) {
  for (const [key, entry] of remuxCache)
    if (key.startsWith(path.resolve(file).toLowerCase() + "|")) {
      remuxCache.delete(key);
      entry.promise
        .finally(() => fs.rmSync(entry.file, { force: true }))
        .catch(() => {});
    }
}

function clearCache() {
  for (const [, entry] of remuxCache)
    entry.promise
      .finally(() => fs.rmSync(entry.file, { force: true }))
      .catch(() => {});
  remuxCache.clear();
}

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
  if (codec !== "h264" && codec !== "hevc" && !INTRA.has(codec)) {
    const reasonData = serializeError(
      appError("TRIM_CODEC_UNSUPPORTED", { codec }),
    );
    return {
      codec,
      supported: false,
      reason: reasonData.message,
      reasonData,
    };
  }
  const { pts, keys, missing } = await streamPackets(tools, file, signal);
  const n = pts.length;
  if (!n) throw appError("TRIM_EMPTY_VIDEO");
  if (missing) throw appError("TRIM_MISSING_TIMESTAMPS");
  let types = new Map();
  if (codec === "h264" || codec === "hevc") {
    if (needsRemux(file, codec)) {
      const copy = await remuxed(tools, file, signal);
      const again = await streamPackets(tools, copy, signal);
      if (again.pts.length !== n) throw appError("TRIM_PACKET_COUNT_MISMATCH");
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
    if (!(median > 0) || step.some((d) => Math.abs(d - median) > tol)) {
      const reasonData = serializeError(appError("TRIM_VFR_UNSUPPORTED"));
      return {
        codec,
        supported: false,
        reason: reasonData.message,
        reasonData,
      };
    }
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
      why = null;
    if (INTRA.has(codec)) {
      safe = key;
      if (!safe) why = serializeError(appError("TRIM_NOT_KEYFRAME"));
    } else if (!key) why = serializeError(appError("TRIM_NOT_KEYFRAME"));
    else {
      const t = types.get(d);
      if (!t) why = serializeError(appError("TRIM_FRAME_TYPE_UNREADABLE"));
      else if (!t.some(IDR[codec]))
        why = serializeError(appError("TRIM_OPEN_GOP"));
      // Nothing decoded later shows earlier, nothing decoded earlier later.
      else if (after[d] < pts[d] || before[d] > pts[d])
        why = serializeError(appError("TRIM_CROSSING_FRAMES"));
      else safe = true;
    }
    frames[f] = {
      frame: f,
      decode: d,
      pts: pts[d],
      key,
      safe,
      ...(why ? { why: why.message, whyData: why } : {}),
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
          ? reject(
              Object.assign(appError("TRIM_CANCELLED"), { cancelled: true }),
            )
          : e
            ? reject(e)
            : resolve(out),
    ),
  );
}
module.exports = {
  index,
  compatibility,
  frameJpeg,
  release,
  clearCache,
  rational,
  run,
  needsRemux,
  remuxed,
};
