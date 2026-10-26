"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { run, compatibility } = require("./trim-probe.cjs");
const { seekTime, pieces, segment, containerFor } = require("./trim-range.cjs");
const { needsRemux, remuxed } = require("./trim-source.cjs");
const { addAudio } = require("./trim-audio.cjs");

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
module.exports = { cut };
