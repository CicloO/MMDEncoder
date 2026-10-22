"use strict";
// Lossless trimming and joining (video stream copy, never re-encoded).
//
// A cut can only start where a decoder can start without anything before it:
// an IDR picture in H.264 / HEVC, or any frame of an all-intra codec. A
// segment is then the packets in decode order from one such point up to the
// next one (or the end of the file), and it shows exactly the frames whose
// presentation times lie between the two points. That property is checked
// per cut point from the index; points where it does not hold (open GOPs,
// leading pictures) are refused rather than guessed.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

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
// H.264 NAL 5 = IDR. HEVC 19 / 20 = IDR (CRA 21 and BLA 16–18 may carry
// leading pictures that need the previous GOP, so they are not used).
const IDR = { h264: (t) => t === 5, hevc: (t) => t === 19 || t === 20 };

// signal: an AbortSignal that stops the process (cancel).
function run(exe, args, { timeout = 0, maxBuffer = 1 << 30, signal } = {}) {
  return new Promise((resolve, reject) =>
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, maxBuffer, encoding: "utf8", signal },
      (e, stdout, stderr) =>
        signal?.aborted
          ? reject(Object.assign(Error("已取消"), { cancelled: true }))
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
  if (!j.streams?.length) throw Error("没有视频轨");
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
          ? Object.assign(Error("已取消"), { cancelled: true })
          : e,
      ),
    );
    child.on("close", (code) => {
      if (signal?.aborted)
        return reject(Object.assign(Error("已取消"), { cancelled: true }));
      if (code) return reject(Error(stderr.trim() || "读取视频包失败"));
      resolve({ pts: pts.subarray(0, n), keys, missing });
    });
  });
}

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

// H.264 / HEVC outside MP4 / MOV: the same packets copied into an MP4, which
// gives exact packet positions (index) and reliable seeking (cut). Kept per
// source (path, size, date) for the session, so indexing and exporting copy
// the stream once; release() / clearCache() remove them.
const remuxCache = new Map(); // key -> { file, promise }
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
  const points = idx.frames.filter((f) => f.safe).map((f) => f.frame);
  if (end) points.push(n);
  if (!points.length) throw Error("这个文件没有可以无损切开的位置");
  let best = points[0];
  for (const p of points)
    if (Math.abs(p - frame) < Math.abs(best - frame)) best = p;
  return best;
}

// Packets of the display range [from, to): checked to be exactly a run of
// packets in decode order that shows exactly those frames.
function segment(idx, from, to) {
  const n = idx.frames.length;
  if (!(from >= 0 && to <= n && from < to)) throw Error("片段为空或越界");
  const start = idx.frames[from];
  if (!start.safe) throw Error(`第 ${from} 帧不能作为入点：${start.why}`);
  if (to < n && !idx.frames[to].safe)
    throw Error(`第 ${to} 帧不能作为出点：${idx.frames[to].why}`);
  const firstDecode = start.decode;
  const lastDecode = to < n ? idx.frames[to].decode : n;
  const shown = idx.frames
    .slice(from, to)
    .map((f) => f.decode)
    .sort((a, b) => a - b);
  const ok =
    shown.length === lastDecode - firstDecode &&
    shown.every((d, i) => d === firstDecode + i);
  if (!ok) throw Error(`第 ${from}–${to} 帧在码流里不连续，不能无损切出`);
  return { from, to, startPts: start.pts, count: to - from };
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
        value: "参数集不同",
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
  const safe = idx.frames.filter((f) => f.safe).map((f) => f.frame);
  const a = safe.find((x) => x >= s.from) ?? n;
  const b = s.to === n ? n : ([...safe].reverse().find((x) => x <= s.to) ?? 0);
  if (a >= b) return [{ copy: false, from: s.from, to: s.to }];
  return [
    ...(s.from < a ? [{ copy: false, from: s.from, to: a }] : []),
    { copy: true, from: a, to: b },
    ...(b < s.to ? [{ copy: false, from: b, to: s.to }] : []),
  ];
}

// Re-encode frames [from, to) of a file with its recorded settings into
// out. The seek decodes up to the exact frame; the output starts with an
// IDR and must come out with the same parameter sets as the file.
async function encodeRange(tools, s, from, to, out, exec) {
  const core = require("./core.cjs");
  const { idx } = s;
  if (!idx.encoding)
    throw Error(
      `${path.basename(s.file)} 没有记录编码参数（不是 MMDEncoder 1.5.0 起导出的），不能智能剪切`,
    );
  if (String(idx.encoding.encoder).startsWith("nvencc:"))
    throw Error("NVEncC 编码的文件暂不支持智能剪切");
  const meta = core.metadata(
    JSON.parse(
      (
        await run(tools.ffprobe, [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          s.file,
        ])
      ).stdout,
    ),
  );
  const ext = path.extname(out).slice(1);
  const settings = {
    ...core.DEFAULTS,
    ...idx.encoding,
    container: ext,
    audio: "none",
    hiRes: false,
    editFriendly: false,
    resizeMode: "source",
    fps: "source",
    alphaMode: "discard",
    alphaMask: false,
    vsr: false,
    vfg: false,
    outputMode: "source",
    nameTemplate: "{name}",
  };
  const [cmd] = core.buildCommands({ path: s.file, meta }, settings, tools, {
    output: out,
  });
  const args = cmd.args.filter(
    (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
  );
  const tb = idx.timeBase;
  const frame = idx.fps.num ? idx.fps.den / idx.fps.num : 1 / 30;
  // A quarter frame early: the decoding seek keeps the first frame at or
  // after this time, i.e. frame "from".
  const at = seekTime(idx, from) - frame / 4;
  const input = args.indexOf("-i");
  if (at > 0) args.splice(input, 0, "-ss", at.toFixed(6));
  args.splice(
    args.length - 1,
    0,
    "-frames:v",
    String(to - from),
    // Same time scale as the copied parts, so the join keeps one time base.
    ...(["mp4", "mov"].includes(ext)
      ? ["-video_track_timescale", String(tb.den)]
      : []),
  );
  await exec(cmd.exe, args);
  // The edges must decode with the copied parts' parameter sets.
  const diffs = await compatibility(tools, [s.file, out]);
  const blocking = diffs.filter((d) => d.key !== "time_base");
  if (blocking.length)
    throw Error(
      "重新编码的片段与原片参数不一致，不能智能剪切：" +
        blocking
          .map((d) =>
            d.key === "extradata"
              ? "编码参数集不同"
              : `${d.key} ${d.value} / ${d.expected}`,
          )
          .join("；") +
        "。请确认本机编码器与导出原片时相同，或关闭智能剪切",
    );
}

async function audioStream(tools, file) {
  const { stdout } = await run(tools.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,channels",
    "-of",
    "json",
    file,
  ]);
  return JSON.parse(stdout).streams?.[0] || null;
}

const AUDIO_CODECS = {
  aac: (kbps) => ["-c:a", "aac", "-b:a", (kbps || 320) + "k"],
  flac: () => ["-c:a", "flac"],
  pcm: () => ["-c:a", "pcm_s16le"],
};

// Audio for the joined video, built separately (the video is only copied).
// The video's length is the measure: every segment's audio is cut to the
// segment's exact time and padded with silence when the source runs out or
// has no audio. Segments join sample to sample, with no fades (the user's
// choice), so nothing at a join shifts later audio.
//   audio.mode: "reencode" (the segments' own audio) | "replace" (audio.file
//     from audio.offset seconds: positive skips into the file, negative
//     starts it that much later)
//   audio.codec: aac | flac | pcm; audio.kbps for AAC.
async function addAudio(tools, segments, video, output, audio, signal) {
  const codec = AUDIO_CODECS[audio.codec || "aac"];
  if (!codec) throw Error("音频格式无效");
  if (audio.codec === "pcm" && /\.mp4$/i.test(output))
    throw Error("PCM 音频请输出 MOV 或 MKV");
  const times = segments.map(timing);
  const total = times.reduce((a, t) => a + t.length, 0);
  const inputs = [];
  const graph = [];
  let rate = 48000;
  if (audio.mode === "reencode") {
    const files = [...new Set(segments.map((s) => s.file))];
    const streams = await Promise.all(files.map((f) => audioStream(tools, f)));
    rate = Number(streams.find(Boolean)?.sample_rate) || 48000;
    inputs.push(...files.flatMap((f) => ["-i", f]));
    segments.forEach((s, i) => {
      const k = files.indexOf(s.file);
      const { start, length } = times[i];
      const head = streams[k]
        ? `[${k + 1}:a:0]atrim=start=${start.toFixed(6)}:end=${(start + length).toFixed(6)},asetpts=PTS-STARTPTS,`
        : `anullsrc=r=${rate}:cl=stereo,`;
      graph.push(
        head +
          [
            `aresample=${rate}`,
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
            `apad=whole_dur=${length.toFixed(6)}`,
            `atrim=end=${length.toFixed(6)}`,
          ].join(",") +
          `[a${i}]`,
      );
    });
    graph.push(
      segments.map((_, i) => `[a${i}]`).join("") +
        `concat=n=${segments.length}:v=0:a=1[aout]`,
    );
  } else if (audio.mode === "replace") {
    if (!audio.file || !fs.existsSync(audio.file))
      throw Error("请选择替换用的音频文件");
    const stream = await audioStream(tools, audio.file);
    if (!stream) throw Error("所选文件没有音轨");
    rate = Number(stream.sample_rate) || 48000;
    inputs.push("-i", audio.file);
    const offset = Number(audio.offset) || 0;
    graph.push(
      "[1:a:0]" +
        [
          offset > 0 ? `atrim=start=${offset.toFixed(6)}` : "anull",
          "asetpts=PTS-STARTPTS",
          ...(offset < 0 ? [`adelay=${Math.round(-offset * 1000)}:all=1`] : []),
          `aresample=${rate}`,
          "aformat=sample_fmts=fltp:channel_layouts=stereo",
          `apad=whole_dur=${total.toFixed(6)}`,
          `atrim=end=${total.toFixed(6)}`,
        ].join(",") +
        "[aout]",
    );
  } else throw Error("音频方式无效");
  await run(
    tools.ffmpeg,
    [
      "-v",
      "error",
      "-n",
      "-i",
      video,
      ...inputs,
      "-filter_complex",
      graph.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      ...codec(audio.kbps),
      ...(/\.(mp4|mov)$/i.test(output) ? ["-movflags", "+faststart"] : []),
      output,
    ],
    { signal },
  );
}

// Container the copied video goes into for a codec (and for the parts).
const containerFor = (codec) =>
  codec === "prores"
    ? "mov"
    : codec === "h264" || codec === "hevc"
      ? "mp4"
      : "mkv";

// Cut segments (each { file, idx, from, to } with idx = index(file)) and
// join them into output, video only, by copying packets.
//
// Each part seeks to just after its start point's timestamp (so the demuxer
// lands on that IDR / intra frame, the nearest seek point at or before it)
// and copies exactly the segment's packet count. Concat's inpoint/outpoint
// are not used: outpoint compares decode times, which drops or adds frames
// around B-frames. H.264 / HEVC outside MP4 / MOV are first copied packet
// for packet into a temporary MP4, since FFmpeg does not seek such MKV files
// reliably.
async function cut(
  tools,
  segments,
  output,
  { onPart = () => {}, audio = { mode: "none" }, signal, smart = false } = {},
) {
  const exec = (exe, args) => run(exe, args, { signal });
  if (!segments.length) throw Error("没有片段");
  const temp = fs.mkdtempSync(path.join(path.dirname(output), ".mmd-trim-"));
  try {
    const withAudio = audio && audio.mode !== "none";
    // Video goes straight to the output when there is no audio to add.
    const joined = withAudio
      ? path.join(temp, "video." + (path.extname(output).slice(1) || "mkv"))
      : output;
    const sourceFor = (s) =>
      needsRemux(s.file, s.idx.codec) ? remuxed(tools, s.file, signal) : s.file;
    const parts = [];
    const planned = segments.flatMap((s) =>
      pieces(s, smart).map((p) => ({ ...s, ...p })),
    );
    for (const [i, s] of planned.entries()) {
      if (!s.copy) {
        const part = path.join(temp, `part${i}.${containerFor(s.idx.codec)}`);
        await encodeRange(tools, s, s.from, s.to, part, exec);
        parts.push(part);
        onPart(i + 1, planned.length);
        continue;
      }
      const seg = segment(s.idx, s.from, s.to);
      const frame = s.idx.fps.num ? s.idx.fps.den / s.idx.fps.num : 1 / 30;
      // Half a frame past the start point: the demuxer lands on it.
      const at = seekTime(s.idx, s.from) + frame / 2;
      const part = path.join(temp, `part${i}.${containerFor(s.idx.codec)}`);
      await exec(tools.ffmpeg, [
        "-v",
        "error",
        ...(at > frame ? ["-ss", at.toFixed(6)] : []),
        "-i",
        await sourceFor(s),
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-frames:v",
        String(seg.count),
        "-avoid_negative_ts",
        "make_zero",
        part,
      ]);
      parts.push(part);
      onPart(i + 1, planned.length);
    }
    const list = path.join(temp, "parts.txt");
    fs.writeFileSync(
      list,
      parts
        .map(
          (p) => "file '" + p.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'",
        )
        .join("\n"),
    );
    await exec(tools.ffmpeg, [
      "-v",
      "error",
      "-n",
      "-f",
      "concat",
      "-safe",
      "0",
      // No H.264 Annex B round trip: it would add parameter sets to every
      // part's first packet. The parts share their parameter sets (checked).
      "-auto_convert",
      "0",
      "-i",
      list,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      ...(!withAudio && /\.(mp4|mov)$/i.test(output)
        ? ["-movflags", "+faststart"]
        : []),
      joined,
    ]);
    // FFmpeg reporting success is not proof: the result must hold exactly
    // the frames asked for.
    const want = segments.reduce((sum, s) => sum + (s.to - s.from), 0);
    const { stdout } = await exec(tools.ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_packets",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      joined,
    ]);
    const got = parseInt(stdout, 10) || 0;
    if (got !== want) {
      fs.rmSync(joined, { force: true });
      throw Error(`拼接结果应有 ${want} 帧，实际 ${got} 帧，已放弃这次导出`);
    }
    if (withAudio)
      await addAudio(tools, segments, joined, output, audio, signal);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
          ? reject(Object.assign(Error("已取消"), { cancelled: true }))
          : e
            ? reject(e)
            : resolve(out),
    ),
  );
}

module.exports = {
  INTRA,
  index,
  snap,
  segment,
  compatibility,
  containerFor,
  timing,
  pieces,
  cut,
  frameJpeg,
  release,
  clearCache,
  seekTime,
  rational,
  run,
};
