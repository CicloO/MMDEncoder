"use strict";
// Cutting and its audio mux are one transaction with one temporary lifetime.
const fs = require("node:fs"),
  path = require("node:path");
const { appError, serializeError, sourceText } = require("./errors.cjs");
const {
  index,
  compatibility,
  frameJpeg,
  release,
  clearCache,
  rational,
  run,
  needsRemux,
  remuxed,
} = require("./trim-source.cjs");
const {
  INTRA,
  seekTime,
  snap,
  segment,
  timing,
  pieces,
  containerFor,
} = require("./trim-range.cjs");

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
//   audio.fade: seconds of fade in / out over the whole result (0 = off).
async function addAudio(tools, segments, video, output, audio, signal) {
  const codec = AUDIO_CODECS[audio.codec || "aac"];
  if (!codec) throw appError("TRIM_AUDIO_CODEC_INVALID");
  if (audio.codec === "pcm" && /\.mp4$/i.test(output))
    throw appError("TRIM_PCM_CONTAINER");
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
      throw appError("TRIM_AUDIO_FILE_REQUIRED");
    const stream = await audioStream(tools, audio.file);
    if (!stream) throw appError("TRIM_AUDIO_STREAM_MISSING");
    rate = Number(stream.sample_rate) || 48000;
    inputs.push("-i", audio.file);
    const offset = Number(audio.offset) || 0;
    graph.push(
      "[1:a:0]" +
        [
          offset > 0
            ? `atrim=start_sample=${Math.round(offset * rate)}`
            : "anull",
          "asetpts=PTS-STARTPTS",
          ...(offset < 0
            ? [`adelay=delays=${Math.round(-offset * rate)}S:all=1`]
            : []),
          `aresample=${rate}`,
          "aformat=sample_fmts=fltp:channel_layouts=stereo",
          `apad=whole_len=${Math.round(total * rate)}`,
          `atrim=end_sample=${Math.round(total * rate)}`,
        ].join(",") +
        "[aout]",
    );
  } else throw appError("TRIM_AUDIO_MODE_INVALID");
  // Optional fade in at the very start and out at the very end of the whole
  // result (joins between segments stay unfaded).
  const fade = require("./media.cjs").fadeFilter(audio.fade, total);
  if (fade) graph.push(`[aout]${fade}[afaded]`);
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
      fade ? "[afaded]" : "[aout]",
      "-c:v",
      "copy",
      ...codec(audio.kbps),
      ...(/\.(mp4|mov)$/i.test(output) ? ["-movflags", "+faststart"] : []),
      output,
    ],
    { signal },
  );
}

// Re-encode frames [from, to) of a file with its recorded settings into
// out. The seek decodes up to the exact frame; the output starts with an
// IDR and must come out with the same parameter sets as the file.
async function encodeRange(tools, s, from, to, out, exec) {
  const core = require("./core.cjs");
  const { idx } = s;
  if (!idx.encoding)
    throw appError("TRIM_SMART_TAG_REQUIRED", { name: path.basename(s.file) });
  if (String(idx.encoding.encoder).startsWith("nvencc:"))
    throw appError("TRIM_NV_SMART_UNSUPPORTED");
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
  if (blocking.length) {
    const differences = blocking.map((d) =>
      serializeError(
        d.key === "extradata"
          ? appError("TRIM_CODEC_DATA_MISMATCH")
          : appError("TRIM_PARAMETER_MISMATCH", {
              key: d.key,
              value: d.value,
              expected: d.expected,
            }),
      ),
    );
    throw appError("TRIM_REENCODE_MISMATCH", {
      detail: differences
        .map((d) => d.message)
        .join(sourceText("trim.listSeparator")),
      differences,
    });
  }
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
  if (!segments.length) throw appError("TRIM_NO_SEGMENTS");
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
      throw appError("TRIM_OUTPUT_FRAME_MISMATCH", { want, got });
    }
    if (withAudio)
      await addAudio(tools, segments, joined, output, audio, signal);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
