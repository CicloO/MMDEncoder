"use strict";
const { appError, sourceText } = require("./errors.cjs");
const { execFile, spawn } = require("node:child_process");

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
module.exports = { run, rational, probeInfo, streamPackets, compatibility };
