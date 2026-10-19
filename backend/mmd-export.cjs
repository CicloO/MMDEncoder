"use strict";
// MMD export plugin: the logic that runs outside MMD.
//
// The plugin DLL (mmd-plugin/src/plugin.cpp) runs this file with MMDEncoder.exe in
// Node mode (ELECTRON_RUN_AS_NODE), so presets and command building stay in one
// place (core.cjs):
//   plan   - at the first frame: build the FFmpeg command that reads MMD's raw
//            frames from stdin and encodes them with the chosen preset.
//   finish - after rendering: add audio (from the AVI, or cut from the project's
//            WAV when the export did not start at frame 0), move the optional
//            alpha mask into place, then delete MMD's placeholder AVI.
// The app writes the chosen preset and tool paths to mmd-export.json.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const core = require("./core.cjs");

const baseDir = () =>
  path.join(
    process.env.LOCALAPPDATA ||
      path.join(require("node:os").homedir(), "AppData", "Local"),
    "MMDEncoder",
    "mmd-plugin",
  );
const configPath = () => path.join(baseDir(), "mmd-export.json");
const historyPath = () => path.join(baseDir(), "exports.jsonl");
// MMD's timeline runs at 30 fps whatever the export frame rate is.
const TIMELINE_FPS = 30;
// Placeholder FOURCC the plugin writes into the AVI instead of real frames.
const PLACEHOLDER_TAG = "MMDE";

// The choice of preset and options. Both MMDEncoder and the plugin's settings
// window in MMD ("詳細設定") write it; the newer savedAt wins.
const selectionPath = () => path.join(baseDir(), "mmd-selection.json");
const FADES = [0, 0.5, 1, 2];

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readSelection() {
  try {
    const s = JSON.parse(fs.readFileSync(selectionPath(), "utf8"));
    return {
      presetId: typeof s.presetId === "string" ? s.presetId : "",
      // Use the size and frame rate set in MMD instead of the preset ones.
      followMmd: s.followMmd !== false,
      // Seconds of audio fade-in and fade-out (0 = off).
      audioFade: FADES.includes(s.audioFade) ? s.audioFade : 0,
      // Also write a black-and-white alpha mask (<name>_alpha.<ext>).
      alphaMask: s.alphaMask === true,
      savedAt: typeof s.savedAt === "string" ? s.savedAt : "",
    };
  } catch {
    return null;
  }
}

function writeSelection({
  presetId = "",
  followMmd = true,
  audioFade = 0,
  alphaMask = false,
  savedAt,
}) {
  const selection = {
    presetId,
    followMmd,
    audioFade,
    alphaMask,
    savedAt: savedAt || new Date().toISOString(),
  };
  writeAtomic(selectionPath(), selection);
  return selection;
}

// mmd-export.json: tools, the helper to run, and every preset the settings
// window may offer. Legacy single-preset form ({settings, presetName, …}) also
// writes the selection, for scripts and tests.
function writeConfig({
  presets,
  settings,
  presetName,
  presetId = "",
  followMmd = true,
  audioFade = 0,
  alphaMask = false,
  engines,
  appExe,
  helper,
}) {
  if (!presets) {
    const id = presetId || "export";
    presets = [{ id, name: presetName, settings }];
    writeSelection({ presetId: id, followMmd, audioFade, alphaMask });
  }
  const config = {
    version: 2,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      settings: { ...p.settings, presetName: p.name },
      unsupported: unsupported(p.settings),
    })),
    engines: { ffmpeg: engines.ffmpeg, ffprobe: engines.ffprobe },
    appExe,
    helper,
    writtenAt: new Date().toISOString(),
  };
  writeAtomic(configPath(), config);
  return config;
}

// The effective export settings: config + current selection.
function readConfig() {
  const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  if (config.version !== 2)
    throw Error("导出设置版本不支持，请打开 MMDEncoder 重新选择导出预设");
  const selection = readSelection();
  if (!selection?.presetId)
    throw Error(
      "还没有选择导出预设：请在 MMDEncoder 的“预设管理”或 MMD 的“詳細設定”里选择",
    );
  const preset = config.presets.find((p) => p.id === selection.presetId);
  if (!preset) throw Error("所选导出预设已不存在，请重新选择");
  if (preset.unsupported) throw Error(preset.unsupported);
  if (!config.engines?.ffmpeg || !config.engines?.ffprobe)
    throw Error("请先在 MMDEncoder 的“设置与引擎”里安装编码工具");
  return {
    ...config,
    presetId: preset.id,
    presetName: preset.name,
    settings: preset.settings,
    followMmd: selection.followMmd,
    audioFade: selection.audioFade,
    alphaMask: selection.alphaMask,
  };
}

// Why a preset cannot be used for a live MMD export (empty string = usable).
function unsupported(s) {
  if (s.alphaMode !== "mask" && s.encoder.startsWith("nvencc:"))
    return "NVEncC（含 RTX 超分 / 补帧）需要两段处理，MMD 直接导出暂不支持";
  return "";
}

// Where the mask is encoded before finish moves it next to the video.
const maskTemp = (temp) => {
  const ext = path.extname(temp);
  return temp.endsWith(".mmdencoder-video" + ext)
    ? temp.slice(0, -(".mmdencoder-video" + ext).length) +
        ".mmdencoder-mask" +
        ext
    : temp;
};
const maskOutput = (output) => {
  const ext = path.extname(output);
  return output.slice(0, -ext.length) + "_alpha" + ext;
};

// FFmpeg args for MMD's raw frames on stdin instead of a file input.
function fromPipe(args, runtime, rate, alpha) {
  args = [...args];
  const input = args.indexOf("pipe:0");
  args.splice(
    input - 1,
    2,
    "-f",
    "rawvideo",
    "-pix_fmt",
    alpha ? "bgra" : "bgr24",
    "-video_size",
    `${runtime.width}x${runtime.height}`,
    "-framerate",
    rate.text,
    "-i",
    "pipe:0",
  );
  // Progress output is useless here and would fill the plugin's log pipe.
  for (let i; (i = args.indexOf("-progress")) >= 0;) args.splice(i, 2);
  return args;
}

// Exact frame rate from DirectShow's AvgTimePerFrame (100 ns units).
function frameRate(avgTimePerFrame) {
  const fps = 1e7 / avgTimePerFrame;
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) < 0.01)
    return { num: whole, den: 1, text: String(whole) };
  for (const [num, den] of [
    [24000, 1001],
    [30000, 1001],
    [60000, 1001],
  ])
    if (Math.abs(fps - num / den) < 0.001)
      return { num, den, text: `${num}/${den}` };
  return {
    num: 1e7,
    den: avgTimePerFrame,
    text: `10000000/${avgTimePerFrame}`,
  };
}

// runtime: { avi, width, height, bits, bottomUp, avgTimePerFrame }
function plan(runtime, config = readConfig()) {
  const s = config.settings;
  const blocked = unsupported(s);
  if (blocked) throw Error(blocked);
  const rate = frameRate(runtime.avgTimePerFrame);
  const alpha = runtime.bits === 32;
  const meta = {
    width: runtime.width,
    height: runtime.height,
    fps: rate.num / rate.den,
    fpsText: rate.text,
    hasAlpha: alpha,
    colorRange: "pc", // MMD renders full-range RGB
    bitDepth: 8,
  };
  // Output next to the AVI with the AVI's name; never overwrite.
  const out = {
    ...s,
    ...(config.followMmd !== false
      ? { resizeMode: "source", fps: "source", vsr: false, vfg: false }
      : {}),
    outputMode: "source",
    nameTemplate: "{name}",
  };
  // The mask: from the export option or a split-alpha preset. MMD only sends
  // alpha with 32-bit frames; without it the mask is skipped, not the export.
  const notes = [];
  let mask =
    s.alphaMode !== "mask" && (config.alphaMask === true || !!s.alphaMask);
  if (mask && !alpha) {
    mask = false;
    notes.push("MMD 没有提供 Alpha 画面，未导出遮罩");
  }
  out.alphaMask = mask;
  const paths = core.outputPaths(runtime.avi, out, 1, fs.existsSync);
  const ext = path.extname(paths.output);
  const temp = path.join(
    path.dirname(paths.output),
    "." + path.basename(paths.output, ext) + ".mmdencoder-video" + ext,
  );
  // Video only; audio is added in finish once the whole render is known.
  const job = { path: "pipe:0", meta: { ...meta, audio: undefined } };
  const commands = core.buildCommands(
    job,
    { ...out, audio: "none" },
    config.engines,
    { output: temp, maskOutput: mask ? maskTemp(temp) : undefined },
  );
  // DirectShow frames are usually stored bottom-up.
  const flip = runtime.bottomUp ? "vflip," : "";
  let args;
  if (commands.length === 1) {
    args = fromPipe(commands[0].args, runtime, rate, alpha);
    const vf = args.indexOf("-vf");
    if (flip && vf >= 0) args[vf + 1] = flip + args[vf + 1];
  } else {
    // Colour video and mask from one FFmpeg: MMD's frames are read once and
    // split, each branch keeping its own filters and encoder options.
    const [video, matte] = commands.map((c) =>
      fromPipe(c.args, runtime, rate, alpha),
    );
    const outputOf = (a) => {
      const m = a.indexOf("-map");
      if (a[m + 2] !== "-vf") throw Error("无法组合遮罩命令");
      return { filter: a[m + 3], rest: a.slice(m + 4) };
    };
    const v = outputOf(video),
      k = outputOf(matte);
    args = [
      ...video.slice(0, video.indexOf("-map")),
      "-filter_complex",
      `[0:v]${flip}split=2[c][k];[c]${v.filter}[vc];[k]${k.filter}[vk]`,
      "-map",
      "[vc]",
      ...v.rest,
      "-map",
      "[vk]",
      ...k.rest,
    ];
  }
  const command = commands[0];
  return {
    exe: command.exe,
    args,
    temp,
    output: paths.output,
    ...(mask
      ? { maskTemp: maskTemp(temp), maskOutput: maskOutput(paths.output) }
      : {}),
    notes,
    fps: rate,
    presetName: config.presetName,
  };
}

// ------------------------------------------------------------------ finish ---

function run(exe, args, timeout = 0) {
  return new Promise((resolve, reject) =>
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, maxBuffer: 64 << 20, encoding: "utf8" },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(error, { stdout, stderr }))
          : resolve({ stdout, stderr }),
    ),
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(config, file) {
  const { stdout } = await run(config.engines.ffprobe, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    file,
  ]);
  return JSON.parse(stdout);
}

// MMD keeps the AVI open briefly after the last frame.
async function waitUnlocked(file, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, "r+"));
      return;
    } catch (e) {
      if (e.code === "ENOENT") return;
      if (Date.now() > end) throw Error("等待 MMD 释放 AVI 超时：" + file);
      await sleep(250);
    }
  }
}

// The project's music as stored in the .pmm: Chinese MMD writes paths in GBK,
// Japanese MMD in Shift-JIS; keep the decoding whose file exists.
function projectWav(pmm) {
  if (!pmm || !fs.existsSync(pmm)) return "";
  const data = fs.readFileSync(pmm);
  for (let i = data.indexOf(".wav"); i >= 0; i = data.indexOf(".wav", i + 4)) {
    let start = i;
    while (start > 0 && data[start - 1] >= 0x20) start--;
    const raw = data.subarray(start, i + 4);
    for (const encoding of ["gbk", "shift_jis", "utf-8"]) {
      let text;
      try {
        text = new TextDecoder(encoding, { fatal: true }).decode(raw);
      } catch {
        continue;
      }
      if (/^[a-z]:\\/i.test(text) && fs.existsSync(text)) return text;
    }
  }
  return "";
}

function audioArgs(s) {
  // A mask-only export is the mask alone, without sound.
  if (s.audio === "none" || s.alphaMode === "mask") return null;
  const args = ["-c:a", s.audio];
  if (["aac", "libopus"].includes(s.audio))
    args.push(
      "-b:a",
      (s.audioBitrate || (s.audio === "aac" ? 192 : 0) || 192) + "k",
    );
  return args;
}

// The mask's single luma level when every pixel of every frame is the same,
// otherwise null. Decodes the lossless mask once with signalstats.
async function flatLevel(config, file) {
  const { stderr } = await run(config.engines.ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "info",
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print:key=lavfi.signalstats.YMIN,metadata=print:key=lavfi.signalstats.YMAX",
    "-f",
    "null",
    "-",
  ]);
  const values = [
    ...stderr.matchAll(/lavfi\.signalstats\.Y(?:MIN|MAX)=(\d+)/g),
  ].map((m) => Number(m[1]));
  if (!values.length) throw Error("没有读到遮罩画面");
  return values.every((v) => v === values[0]) ? values[0] : null;
}

// job: { avi, temp, output, frames, avgTimePerFrame, startFrame, pmm }
async function finish(job, config = readConfig(), log = () => {}) {
  const s = config.settings;
  const rate = frameRate(job.avgTimePerFrame);
  await waitUnlocked(job.avi);
  let aviInfo = null;
  try {
    aviInfo = await probe(config, job.avi);
  } catch (e) {
    log("无法读取占位 AVI：" + e.message);
  }
  const placeholder = !!aviInfo?.streams?.some(
    (x) => x.codec_type === "video" && x.codec_tag_string === PLACEHOLDER_TAG,
  );
  const aviAudio = !!aviInfo?.streams?.some((x) => x.codec_type === "audio");
  const audio = audioArgs(s);
  let source = "none";
  let input = [];
  let trim = "";
  if (audio && aviAudio) {
    source = "avi";
    input = ["-i", job.avi];
  } else if (audio) {
    const wav = projectWav(job.pmm);
    if (wav && job.startFrame >= 0) {
      const info = await probe(config, wav);
      const sr = Number(
        info.streams?.find((x) => x.codec_type === "audio")?.sample_rate,
      );
      if (sr) {
        // Sample-exact: start = start frame on the 30 fps timeline, length =
        // frames actually received at the export frame rate.
        const first = Math.round((job.startFrame * sr) / TIMELINE_FPS);
        const count = Math.round((job.frames * sr * rate.den) / rate.num);
        trim = `atrim=start_sample=${first}:end_sample=${first + count},asetpts=PTS-STARTPTS`;
        source = "wav";
        input = ["-i", wav];
        log(
          `音频取自 WAV：${wav}，采样点 ${first}–${first + count}（${sr} Hz）`,
        );
      }
    } else log("没有找到可用的音频（AVI 无音轨，工程 WAV 未找到）");
  }
  // Optional fade in / out over the clip's audio, at most half its length each.
  const length = (job.frames * rate.den) / rate.num;
  const fade = Math.min(Number(config.audioFade) || 0, length / 2);
  const filters = [trim];
  if (source !== "none" && fade > 0) {
    filters.push(
      `afade=t=in:st=0:d=${fade}`,
      `afade=t=out:st=${(length - fade).toFixed(6)}:d=${fade}`,
    );
    log(`音频淡入淡出 ${fade} 秒`);
  }
  const af = filters.filter(Boolean).join(",");
  if (source === "none") {
    fs.renameSync(job.temp, job.output);
  } else {
    await run(config.engines.ffmpeg, [
      "-hide_banner",
      "-nostdin",
      "-n",
      "-i",
      job.temp,
      ...input,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      ...(af ? ["-af", af] : []),
      ...audio,
      "-shortest",
      ...(["mp4", "mov"].includes(s.container)
        ? ["-movflags", "+faststart"]
        : []),
      job.output,
    ]);
    fs.rmSync(job.temp, { force: true });
  }
  const result = await probe(config, job.output);
  const video = result.streams?.find((x) => x.codec_type === "video");
  if (!video) throw Error("成片没有视频流：" + job.output);
  // The mask was encoded next to the video during the render.
  let mask = "";
  const matte = maskTemp(job.temp);
  if (matte !== job.temp && fs.existsSync(matte)) {
    // One flat value from start to end (all white: nothing transparent; all
    // black: nothing visible) carries no information, so it is not kept.
    const flat = await flatLevel(config, matte).catch((e) => {
      log("无法检查遮罩内容，照常保留：" + e.message);
      return null;
    });
    if (flat !== null) {
      fs.rmSync(matte, { force: true });
      log(
        flat >= 128
          ? "遮罩全白（画面没有透明区域），未保留遮罩"
          : "遮罩全黑（画面全透明），未保留遮罩",
      );
    } else {
      mask = maskOutput(job.output);
      if (fs.existsSync(mask)) throw Error("遮罩文件已存在，未覆盖：" + mask);
      fs.renameSync(matte, mask);
      log("Alpha 遮罩：" + mask);
    }
  }
  // Only ever delete an AVI this plugin wrote (placeholder frames only).
  if (placeholder) fs.rmSync(job.avi, { force: true });
  return {
    output: job.output,
    ...(mask ? { mask } : {}),
    audio: source,
    duration: Number(result.format?.duration) || 0,
    aviDeleted: placeholder,
  };
}

function remember(entry) {
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    fs.appendFileSync(
      historyPath(),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {}
}

// CLI used by the plugin: MMD_EXPORT_MODE=plan|finish, MMD_EXPORT_JOB=<json>.
async function main() {
  const mode = process.env.MMD_EXPORT_MODE;
  const job = JSON.parse(process.env.MMD_EXPORT_JOB || "{}");
  if (mode === "plan") {
    try {
      process.stdout.write(JSON.stringify({ ok: true, ...plan(job) }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (mode === "finish") {
    const lines = [];
    const log = (m) => lines.push(m);
    try {
      const r = await finish(job, readConfig(), log);
      remember({
        ok: true,
        ...r,
        frames: job.frames,
        startFrame: job.startFrame,
        notes: lines,
      });
    } catch (e) {
      remember({
        ok: false,
        error: e.message,
        output: job.output,
        avi: job.avi,
        notes: lines,
      });
      process.exitCode = 1;
    }
  }
}
if (require.main === module) main();

module.exports = {
  FADES,
  configPath,
  selectionPath,
  readSelection,
  writeSelection,
  historyPath,
  writeConfig,
  readConfig,
  unsupported,
  frameRate,
  plan,
  finish,
  projectWav,
};
