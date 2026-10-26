"use strict";
const { appError } = require("./errors.cjs");
const fs = require("node:fs");
const { run } = require("./trim-probe.cjs");
const { timing } = require("./trim-range.cjs");

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
module.exports = { addAudio };
