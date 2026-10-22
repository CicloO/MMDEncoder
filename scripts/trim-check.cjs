"use strict";
// Verification program for lossless trimming (docs/开发计划.md, step 1).
//
//   node scripts/trim-check.cjs --out joined.mp4 a.mp4:30-90 b.mp4:0-end
//   node scripts/trim-check.cjs --matrix [work folder]
//
// Cuts the given frame ranges (snapped to safe cut points), joins them with
// backend/trim.cjs, then proves the result:
//   1. decoded frames: every output frame's MD5 equals the source frame it
//      should be, in order, and the count matches;
//   2. packets: the copied video packets are byte-identical to the source's
//      (so nothing was re-encoded);
//   3. timestamps: decode times strictly increase.
// --matrix builds sample files for each format and reports which can be cut
// where. Exit code 1 when any check fails.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const trim = require("../backend/trim.cjs");
const { createTools } = require("../backend/tools.cjs");

function engines() {
  const managed = createTools({
    root:
      process.env.MMD_TEST_TOOLS_ROOT ||
      path.join(
        process.env.LOCALAPPDATA || os.homedir(),
        "MMDEncoder",
        "tools",
      ),
  }).paths();
  if (!managed.ffmpeg)
    throw Error("找不到 FFmpeg（先在 MMDEncoder 里安装编码工具）");
  return managed;
}

async function frameMd5(tools, file, copy = false) {
  const { stdout } = await trim.run(tools.ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    ...(copy ? ["-c", "copy"] : []),
    "-f",
    "framemd5",
    "-",
  ]);
  return stdout
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").pop().trim());
}

async function dtsList(tools, file) {
  const { stdout } = await trim.run(tools.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=dts",
    "-of",
    "csv=p=0",
    file,
  ]);
  return stdout.trim().split(/\r?\n/).map(Number);
}

// Audio decoded to 16-bit stereo samples at a rate (Int16Array, interleaved).
async function samples(tools, file, rate) {
  const { execFile } = require("node:child_process");
  const buf = await new Promise((resolve, reject) =>
    execFile(
      tools.ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        String(rate),
        "-f",
        "s16le",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 1 << 30, windowsHide: true },
      (e, out) => (e ? reject(e) : resolve(out)),
    ),
  );
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
}

// Output audio against the sources: total length equals the video's, and
// (for PCM) every sample of each segment equals the source at the segment's
// time, joins included; silence where a source ran out.
async function checkAudio(tools, ranges, output, rate) {
  const times = ranges.map(trim.timing);
  const out = await samples(tools, output, rate);
  const total = times.reduce((a, x) => a + x.length, 0);
  const result = {
    seconds: +(out.length / 2 / rate).toFixed(6),
    video: +total.toFixed(6),
  };
  result.lengthOk = Math.abs(out.length / 2 - Math.round(total * rate)) <= 1;
  const cache = new Map();
  let at = 0,
    worst = 0;
  for (const [i, r] of ranges.entries()) {
    if (!cache.has(r.file))
      cache.set(
        r.file,
        await samples(tools, r.file, rate).catch(() => new Int16Array(0)),
      );
    const src = cache.get(r.file);
    const n = Math.round(times[i].length * rate);
    const first = Math.round(times[i].start * rate);
    for (let k = 0; k < n; k++)
      for (let c = 0; c < 2; c++) {
        const want = src[(first + k) * 2 + c] ?? 0; // past the source's end: silence
        const got = out[(at + k) * 2 + c] ?? 0;
        worst = Math.max(worst, Math.abs(got - want));
      }
    at += n;
  }
  result.maxDifference = worst;
  result.ok = result.lengthOk && worst <= 2;
  return result;
}

// ranges: [{ file, from, to }] with to = Infinity for "end".
// audio: undefined (video only) or backend/trim.cjs cut()'s audio option.
async function check(tools, ranges, output, audio) {
  const report = { output, segments: [], checks: {}, ok: false };
  const indexes = new Map();
  for (const r of ranges) {
    if (!indexes.has(r.file))
      indexes.set(r.file, await trim.index(tools, r.file));
    const idx = indexes.get(r.file);
    if (!idx.supported) throw Error(`${path.basename(r.file)}：${idx.reason}`);
    const n = idx.frames.length;
    const from = trim.snap(idx, r.from);
    const to = trim.snap(idx, Math.min(r.to, n), { end: true });
    report.segments.push({
      file: r.file,
      requested: [r.from, r.to === Infinity ? "end" : r.to],
      snapped: [from, to === n ? "end" : to],
      frames: Math.max(0, to - from),
      codec: idx.codec,
    });
    if (from >= to)
      throw Error(`${path.basename(r.file)} ${r.from}–${r.to}：吸附后片段为空`);
    r.idx = idx;
    r.from = from;
    r.to = to;
  }
  const files = [...indexes.keys()];
  if (files.length > 1) {
    const diffs = await trim.compatibility(tools, files);
    report.checks.compatible = diffs.length ? diffs : true;
    if (diffs.length) return report;
  }
  fs.rmSync(output, { force: true });
  await trim.cut(tools, ranges, output, audio ? { audio } : {});

  // 1. decoded frames
  const expected = [],
    expectedPackets = [];
  const md5 = new Map(),
    packets = new Map();
  for (const r of ranges) {
    if (!md5.has(r.file)) {
      md5.set(r.file, await frameMd5(tools, r.file));
      packets.set(r.file, await frameMd5(tools, r.file, true));
    }
    expected.push(...md5.get(r.file).slice(r.from, r.to));
    const first = r.idx.frames[r.from].decode;
    const last =
      r.to < r.idx.frames.length
        ? r.idx.frames[r.to].decode
        : r.idx.frames.length;
    expectedPackets.push(...packets.get(r.file).slice(first, last));
  }
  const got = await frameMd5(tools, output);
  const firstBad = got.findIndex((m, i) => m !== expected[i]);
  report.checks.frames = {
    expected: expected.length,
    got: got.length,
    ok: got.length === expected.length && firstBad === -1,
    ...(firstBad >= 0 ? { firstDifference: firstBad } : {}),
  };
  // 2. packets
  const gotPackets = await frameMd5(tools, output, true);
  report.checks.packets = {
    ok:
      gotPackets.length === expectedPackets.length &&
      gotPackets.every((m, i) => m === expectedPackets[i]),
  };
  // 3. timestamps
  const dts = await dtsList(tools, output);
  // MKV stores no decode times for B-frame streams; check what is there.
  const known = dts.filter(Number.isFinite);
  report.checks.dts = known.length
    ? { ok: known.every((d, i) => i === 0 || d > known[i - 1]) }
    : { ok: true, note: "容器不记录解码时间" };
  report.ok =
    report.checks.frames.ok && report.checks.packets.ok && report.checks.dts.ok;
  if (audio && audio.mode === "reencode" && audio.codec === "pcm") {
    report.checks.audio = await checkAudio(
      tools,
      ranges,
      output,
      audio.rate || 48000,
    );
    report.ok = report.ok && report.checks.audio.ok;
  }
  return report;
}

function parseRange(arg) {
  const m = /^(.*):(\d+)-(\d+|end)$/.exec(arg);
  if (!m) throw Error("片段格式应为 文件:起-止，如 a.mp4:30-90 或 a.mp4:0-end");
  return {
    file: path.resolve(m[1]),
    from: Number(m[2]),
    to: m[3] === "end" ? Infinity : Number(m[3]),
  };
}

// Sample files: 6 s, 30 fps, picture changes every frame, keyframe every 30.
const SAMPLES = [
  [
    "H.264 x264 B 帧",
    "h264-b3.mp4",
    [
      "-c:v",
      "libx264",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-bf",
      "3",
    ],
  ],
  [
    "H.264 x264 无 B 帧",
    "h264-b0.mp4",
    [
      "-c:v",
      "libx264",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-bf",
      "0",
    ],
  ],
  [
    "H.264 x264 B 帧 · MKV",
    "h264-b3.mkv",
    [
      "-c:v",
      "libx264",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-bf",
      "3",
    ],
  ],
  [
    "H.264 x264 开放 GOP",
    "h264-open.mp4",
    [
      "-c:v",
      "libx264",
      "-x264-params",
      "open-gop=1:keyint=30:min-keyint=30:scenecut=0:bframes=3",
    ],
  ],
  [
    "H.264 NVENC",
    "h264-nvenc.mp4",
    ["-c:v", "h264_nvenc", "-g", "30", "-bf", "2"],
  ],
  [
    "HEVC NVENC",
    "hevc-nvenc.mp4",
    ["-c:v", "hevc_nvenc", "-g", "30", "-bf", "2"],
  ],
  [
    "HEVC x265（默认开放 GOP）",
    "hevc-x265.mp4",
    [
      "-c:v",
      "libx265",
      "-x265-params",
      "keyint=30:min-keyint=30:scenecut=0:log-level=error",
    ],
  ],
  [
    "HEVC x265 闭合 GOP",
    "hevc-x265-closed.mp4",
    [
      "-c:v",
      "libx265",
      "-x265-params",
      "keyint=30:min-keyint=30:scenecut=0:open-gop=0:log-level=error",
    ],
  ],
  ["ProRes 422 HQ", "prores.mov", ["-c:v", "prores_ks", "-profile:v", "3"]],
  [
    "ProRes 4444（带 Alpha）",
    "prores4444.mov",
    ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"],
    "alpha",
  ],
  ["UtVideo", "utvideo.mkv", ["-c:v", "utvideo"]],
  ["FFV1", "ffv1.mkv", ["-c:v", "ffv1"]],
];

async function matrix(tools, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let failed = false;
  for (const [label, name, args, alpha] of SAMPLES) {
    const file = path.join(dir, name);
    try {
      if (!fs.existsSync(file))
        await trim.run(tools.ffmpeg, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=s=320x180:r=30:d=6${alpha ? ",format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='X'" : ""}`,
          ...args,
          file,
        ]);
    } catch (e) {
      rows.push({
        label,
        result:
          "跳过（本机无法生成：" + e.message.split("\n")[0].slice(0, 60) + "）",
      });
      continue;
    }
    const idx = await trim.index(tools, file);
    if (!idx.supported) {
      rows.push({ label, result: "拒绝：" + idx.reason });
      continue;
    }
    const safe = idx.frames.filter((f) => f.safe).length;
    const keys = idx.frames.filter((f) => f.key).length;
    const whyNot = [
      ...new Set(idx.frames.filter((f) => f.key && !f.safe).map((f) => f.why)),
    ];
    // Two cuts from the middle plus the tail, joined.
    const ranges = [
      { file, from: 30, to: 60 },
      { file, from: 90, to: 120 },
      { file, from: 150, to: Infinity },
    ];
    const out = path.join(
      dir,
      "out-" + path.parse(name).name + "." + trim.containerFor(idx.codec),
    );
    let verdict;
    try {
      const r = await check(tools, ranges, out);
      verdict = r.ok
        ? `通过（${r.checks.frames.got} 帧，逐帧与逐包一致）`
        : `失败：${JSON.stringify(r.checks)}`;
      if (!r.ok) failed = true;
      if (alpha && r.ok) {
        const { stdout } = await trim.run(tools.ffprobe, [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=pix_fmt",
          "-of",
          "csv=p=0",
          out,
        ]);
        verdict += `；输出像素格式 ${stdout.trim()}`;
      }
    } catch (e) {
      verdict = "无法切：" + e.message;
    }
    rows.push({
      label,
      cuts:
        safe === idx.frames.length
          ? "逐帧"
          : `${safe} / ${idx.frames.length} 帧（关键帧 ${keys}）`,
      note: whyNot.join("；"),
      result: verdict,
    });
  }
  return { rows, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const tools = engines();
  if (args[0] === "--matrix") {
    const dir = path.resolve(
      args[1] || path.join(os.tmpdir(), "mmd-trim-matrix"),
    );
    const { rows, failed } = await matrix(tools, dir);
    console.log("| 格式 | 可切位置 | 说明 | 结果 |\n| --- | --- | --- | --- |");
    for (const r of rows)
      console.log(
        `| ${r.label} | ${r.cuts || "—"} | ${r.note || ""} | ${r.result} |`,
      );
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const o = args.indexOf("--out");
  if (o < 0 || !args[o + 1])
    throw Error(
      "用法：trim-check.cjs --out 输出 文件:起-止 …  或 --matrix [目录]",
    );
  const output = path.resolve(args[o + 1]);
  const ranges = args.filter((_, i) => i !== o && i !== o + 1).map(parseRange);
  const report = await check(tools, ranges, output);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

module.exports = { check, matrix, engines };
