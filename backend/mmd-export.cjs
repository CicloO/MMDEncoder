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
const media = require("./media.cjs");

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
// window in MMD ("詳細設定") write it; the newer savedAt wins, and MMDEncoder
// picks up a choice saved in MMD as soon as it lands.
const selectionPath = () => path.join(baseDir(), "mmd-selection.json");
const FADES = [0, 0.5, 1, 2];
// Alpha mask: none, next to the video (<name>_alpha.<ext>), or the mask alone.
// The choice overrides the preset's own alpha setting.
const MASK_MODES = ["off", "with", "only"];
// What a preset would do by itself; the default when a preset is picked.
const presetMask = (s) =>
  s?.alphaMode === "mask" ? "only" : s?.alphaMask ? "with" : "off";

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
      // "" = the preset decides.
      maskMode: MASK_MODES.includes(s.maskMode) ? s.maskMode : "",
      // Add the MMD frame range to the file name (_0400-0600f).
      rangeSuffix: s.rangeSuffix !== false,
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
  maskMode = "off",
  rangeSuffix = true,
  savedAt,
}) {
  const selection = {
    presetId,
    followMmd,
    audioFade,
    rangeSuffix: rangeSuffix !== false,
    maskMode: MASK_MODES.includes(maskMode) ? maskMode : "off",
    savedAt: savedAt || new Date().toISOString(),
  };
  writeAtomic(selectionPath(), selection);
  return selection;
}

// mmd-export.json: tools, the helper to run, and every preset the settings
// window may offer. The single-preset form ({settings, presetName, …}) also
// writes the selection, for scripts and tests.
function writeConfig({
  presets,
  settings,
  presetName,
  presetId = "",
  followMmd = true,
  audioFade = 0,
  maskMode = "",
  rangeSuffix = true,
  engines,
  appExe,
  helper,
}) {
  if (!presets) {
    const id = presetId || "export";
    presets = [{ id, name: presetName, settings }];
    writeSelection({
      rangeSuffix,
      presetId: id,
      followMmd,
      audioFade,
      maskMode: maskMode || presetMask(settings),
    });
  }
  const config = {
    version: 2,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      settings: { ...p.settings, presetName: p.name },
      unsupported: unsupported(p.settings),
    })),
    engines: {
      ffmpeg: engines.ffmpeg,
      ffprobe: engines.ffprobe,
      // NVEncC presets (mmd-pipe.cjs).
      nvencc: engines.nvencc || "",
      soxr: !!engines.soxr,
    },
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
  const maskMode = selection.maskMode || presetMask(preset.settings);
  // The mask alone does not use the preset's encoder.
  if (maskMode !== "only" && preset.unsupported)
    throw Error(preset.unsupported);
  if (!config.engines?.ffmpeg || !config.engines?.ffprobe)
    throw Error("请先在 MMDEncoder 的“设置与引擎”里安装编码工具");
  return {
    ...config,
    presetId: preset.id,
    presetName: preset.name,
    settings: preset.settings,
    followMmd: selection.followMmd,
    audioFade: selection.audioFade,
    maskMode,
    rangeSuffix: selection.rangeSuffix,
  };
}

// Why a preset cannot be used for a live MMD export (empty string = usable).
// Every preset can be now (NVEncC since 1.6.1, see mmd-pipe.cjs); this stays
// the one place for such rules, which the app and the plugin both show.
function unsupported() {
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

// Each export's settings as they were when it started, so finish (and a
// recovery after MMD crashed) never mixes in a preset chosen mid-render.
const pendingDir = () => path.join(baseDir(), "pending");
const snapshotPath = (temp) =>
  path.join(
    pendingDir(),
    require("node:crypto")
      .createHash("sha1")
      .update(path.resolve(temp).toLowerCase())
      .digest("hex")
      .slice(0, 16) + ".json",
  );

function readSnapshot(temp) {
  try {
    const s = JSON.parse(fs.readFileSync(snapshotPath(temp), "utf8"));
    return s.version === 1 ? s : null;
  } catch {
    return null;
  }
}

// runtime: { avi, width, height, bits, bottomUp, avgTimePerFrame, pmm?, startFrame? }
function plan(runtime, config = readConfig()) {
  const maskMode = config.maskMode || presetMask(config.settings);
  // The mask choice overrides the preset's own alpha setting.
  const s = {
    ...config.settings,
    alphaMode:
      maskMode === "only"
        ? "mask"
        : config.settings.alphaMode === "mask"
          ? "discard"
          : config.settings.alphaMode,
    alphaMask: false,
  };
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
  // MMD only sends alpha with 32-bit frames; without it a mask next to the
  // video is skipped, not the export.
  const notes = [];
  if (maskMode === "only" && !alpha)
    throw Error("MMD 没有提供 Alpha 画面，无法只导出遮罩");
  let mask = maskMode === "with";
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
    { ...out, audio: "none", hiRes: false },
    // The plugin keeps its x264 mask (the GPU one is for the video page).
    { ...config.engines, nvencLossless: false },
    {
      output: temp,
      maskOutput: mask ? maskTemp(temp) : undefined,
      // Where the export starts on MMD's timeline, for the trim page.
      tag:
        Number.isInteger(runtime.startFrame) && runtime.startFrame >= 0
          ? { mmd: { start: runtime.startFrame } }
          : {},
    },
  );
  // DirectShow frames are usually stored bottom-up.
  const flip = runtime.bottomUp ? "vflip," : "";
  // NVEncC: FFmpeg (MMD's frames, the mask) piped to NVEncC, then FFmpeg
  // puts the video in its container; mmd-pipe.cjs runs them (see there).
  if (commands.some((c) => c.pipeFrom)) {
    const steps = core.singlePass(commands).map((c) => {
      if (!c.pipeFrom) {
        // Container step: video only (finish adds the sound), so not the
        // source's second input, which here would be MMD's pipe again.
        const args = [...c.args];
        const i = args.indexOf("pipe:0");
        if (i > 0 && args[i - 1] === "-i") args.splice(i - 1, 2);
        for (let p; (p = args.indexOf("-progress")) >= 0;) args.splice(p, 2);
        return { exe: c.exe, args };
      }
      const from = fromPipe(c.pipeFrom.args, runtime, rate, alpha);
      if (flip) {
        const vf = from.indexOf("-vf");
        const fc = from.indexOf("-filter_complex");
        if (vf >= 0) from[vf + 1] = flip + from[vf + 1];
        else if (fc >= 0)
          from[fc + 1] = from[fc + 1].replace("[0:v]", "[0:v]" + flip);
      }
      return {
        exe: c.exe,
        args: c.args,
        pipeFrom: { exe: c.pipeFrom.exe, args: from },
      };
    });
    return finishPlan({
      exe: config.appExe || process.execPath,
      args: [path.join(__dirname, "mmd-pipe.cjs")],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        MMD_PIPE_JOB: JSON.stringify({
          steps,
          temporary: commands.map((c) => c.temporary).filter(Boolean),
        }),
      },
    });
  }
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
    args = core.joinMask(video, matte, flip);
  }
  return finishPlan({ exe: commands[0].exe, args });
  // The launch (exe, args, optional env for the plugin) with the paths, and
  // a snapshot of the settings for finish.
  function finishPlan(launch) {
    const result = {
      ...launch,
      temp,
      output: paths.output,
      ...(mask
        ? { maskTemp: maskTemp(temp), maskOutput: maskOutput(paths.output) }
        : {}),
      notes,
      fps: rate,
      presetName: config.presetName,
    };
    writeAtomic(snapshotPath(temp), {
      version: 1,
      at: new Date().toISOString(),
      // The MMD process that renders (this helper's parent): when it is gone and
      // the snapshot is still here, the export was cut off.
      mmdPid: process.ppid,
      avi: runtime.avi,
      pmm: runtime.pmm || "",
      startFrame: Number.isInteger(runtime.startFrame)
        ? runtime.startFrame
        : -1,
      avgTimePerFrame: runtime.avgTimePerFrame,
      temp,
      output: paths.output,
      presetName: config.presetName,
      settings: { ...s, alphaMask: mask },
      engines: config.engines,
      audioFade: config.audioFade,
      rangeSuffix: config.rangeSuffix !== false,
    });
    return result;
  }
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

// Video frames (packets) in a file, without decoding.
async function countFrames(config, file) {
  const { stdout } = await run(config.engines.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_packets",
    "-show_entries",
    "stream=nb_read_packets",
    "-of",
    "csv=p=0",
    file,
  ]);
  return parseInt(stdout, 10) || 0;
}

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

// The MMD frame range in the name, as rendered: "scene.mp4" with frames
// 400–600 → "scene_0400-0600f.mp4" (a mask-only "scene_alpha.mp4" →
// "scene_0400-0600f_alpha.mp4"). The end counts the frames that really
// arrived, so a cancelled render names what it holds.
function withRange(output, config, job) {
  if (
    config.rangeSuffix === false ||
    !(job.startFrame >= 0) ||
    !(job.frames > 0)
  )
    return output;
  const rate = frameRate(job.avgTimePerFrame);
  const end =
    job.startFrame +
    Math.max(1, Math.round((job.frames * TIMELINE_FPS * rate.den) / rate.num)) -
    1;
  const pad = (n) => String(n).padStart(4, "0");
  const ext = path.extname(output);
  const stem = output.slice(0, -ext.length);
  const suffix = `_${pad(job.startFrame)}-${pad(end)}f`;
  return stem.endsWith("_alpha")
    ? stem.slice(0, -6) + suffix + "_alpha" + ext
    : stem + suffix + ext;
}

// The output's name, or "<name> (2)" and so on when that name (or its mask's)
// was taken while MMD rendered: never overwrite someone's file.
function freeOutput(output, withMask) {
  const ext = path.extname(output);
  const stem = output.slice(0, -ext.length);
  for (let n = 1; n < 100000; n++) {
    const name = n === 1 ? output : `${stem} (${n})${ext}`;
    if (!fs.existsSync(name) && !(withMask && fs.existsSync(maskOutput(name))))
      return name;
  }
  throw Error("无法分配不重名的输出文件");
}

// Move a finished file into place without replacing an existing one: a hard
// link fails if the name exists; drives without hard links (exFAT) fall back
// to checking just before the rename.
function placeFile(from, to) {
  try {
    fs.linkSync(from, to);
    fs.rmSync(from, { force: true });
    return;
  } catch (e) {
    if (e.code === "EEXIST") throw Error("输出文件已存在，未覆盖：" + to);
  }
  if (fs.existsSync(to)) throw Error("输出文件已存在，未覆盖：" + to);
  fs.renameSync(from, to);
}

// job: { avi, temp, output, frames, avgTimePerFrame, startFrame, pmm }
// config: the settings the export started with (its snapshot) when there is one.
async function finish(
  job,
  config = readSnapshot(job.temp) || readConfig(),
  log = () => {},
) {
  // From here this process owns the export: MMD may close while it runs.
  if (config.version === 1)
    writeAtomic(snapshotPath(job.temp), { ...config, mmdPid: process.pid });
  const s = config.settings;
  const matte = maskTemp(job.temp);
  const hasMask = matte !== job.temp && fs.existsSync(matte);
  const planned = withRange(job.output, config, job);
  job = { ...job, output: freeOutput(planned, hasMask) };
  if (job.output !== planned)
    log("同名文件在导出期间已存在，改存为：" + job.output);
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
  let audio = audioArgs(s);
  let source = "none";
  // The source audio stream, for Hi-Res.
  let stream = aviInfo?.streams?.find((x) => x.codec_type === "audio");
  let input = [];
  let trim = "";
  if (audio && aviAudio) {
    source = "avi";
    input = ["-i", job.avi];
  } else if (audio) {
    const wav = projectWav(job.pmm);
    if (wav && job.startFrame >= 0) {
      const info = await probe(config, wav);
      stream = info.streams?.find((x) => x.codec_type === "audio");
      const sr = Number(stream?.sample_rate);
      const first = Math.round((job.startFrame * sr) / TIMELINE_FPS);
      const total = Math.round(Number(info.format?.duration) * sr) || Infinity;
      if (sr && first >= total)
        log("导出起点已超过工程 WAV 的结尾，成片没有音频");
      else if (sr) {
        // Sample-exact: start = start frame on the 30 fps timeline, length =
        // frames actually received at the export frame rate.
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
  // The rendered video sets the length: audio that runs out is padded with
  // silence, longer audio is cut (-t below). Never end at the shorter stream,
  // which would drop rendered frames.
  const filters = [trim, source !== "none" ? "apad" : ""];
  if (source !== "none" && fade > 0) {
    filters.push(
      `afade=t=in:st=0:d=${fade}`,
      `afade=t=out:st=${(length - fade).toFixed(6)}:d=${fade}`,
    );
    log(`音频淡入淡出 ${fade} 秒`);
  }
  // Hi-Res: the audio is filtered here anyway (trim, pad), so it is always
  // re-encoded, never copied.
  if (source !== "none" && s.hiRes) {
    const plan = media.hiResPlan(
      s.audio === "flac" ? "flac" : "wav",
      core.audioInfo(stream || {}),
    );
    if (plan.action === "copy") plan.action = "encode";
    filters.push(media.hiResFilter(plan, config.engines.soxr));
    audio = media.hiResCodec(plan);
    log(`Hi-Res：${plan.from} → ${plan.to}`);
  }
  const af = filters.filter(Boolean).join(",");
  if (source === "none") {
    placeFile(job.temp, job.output);
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
      "-t",
      length.toFixed(6),
      ...(["mp4", "mov"].includes(s.container)
        ? ["-movflags", "+faststart"]
        : []),
      job.output,
    ]);
    // Only drop the rendered video once the result holds all of its frames.
    const [have, want] = await Promise.all([
      countFrames(config, job.output),
      countFrames(config, job.temp),
    ]);
    if (have < want) {
      fs.rmSync(job.output, { force: true });
      throw Error(
        `合成音频后只剩 ${have} / ${want} 帧，已保留未合成的视频：${job.temp}`,
      );
    }
    fs.rmSync(job.temp, { force: true });
  }
  const result = await probe(config, job.output);
  const video = result.streams?.find((x) => x.codec_type === "video");
  if (!video) throw Error("成片没有视频流：" + job.output);
  // The mask was encoded next to the video during the render.
  let mask = "";
  // Always kept, even when it is all white or all black: checking that took
  // longer than the clip itself at 4K, and the user can judge it at a glance.
  if (hasMask) {
    mask = maskOutput(job.output);
    placeFile(matte, mask);
    log("Alpha 遮罩：" + mask);
  }
  // Only ever delete an AVI this plugin wrote (placeholder frames only).
  if (placeholder) fs.rmSync(job.avi, { force: true });
  fs.rmSync(snapshotPath(job.temp), { force: true });
  return {
    output: job.output,
    ...(mask ? { mask } : {}),
    audio: source,
    duration: Number(result.format?.duration) || 0,
    aviDeleted: placeholder,
  };
}

// ---------------------------------------------------------------- recovery ---
// When MMD crashes or is closed mid-render, FFmpeg sees its input end and
// still completes the video it has, but finish never runs: the frames sit in
// the hidden temp file without audio. Its snapshot outlives the MMD process.

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Exports cut off before finish: [{ id, output, temp, at, presetName, size }].
function interrupted() {
  let names = [];
  try {
    names = fs.readdirSync(pendingDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const list = [];
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (snap.version !== 1 || alive(snap.mmdPid)) continue;
    let size = 0;
    try {
      size = fs.statSync(snap.temp).size;
    } catch {}
    // Nothing was written, or finish moved it already: forget it.
    if (!size) {
      fs.rmSync(file, { force: true });
      fs.rmSync(maskTemp(snap.temp), { force: true });
      continue;
    }
    list.push({
      id: name.slice(0, -5),
      output: snap.output,
      temp: snap.temp,
      at: snap.at,
      presetName: snap.presetName,
      size,
    });
  }
  return list.sort((a, b) => (a.at < b.at ? 1 : -1));
}

function snapshotById(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw Error("无效的导出记录");
  const snap = JSON.parse(
    fs.readFileSync(path.join(pendingDir(), id + ".json"), "utf8"),
  );
  if (alive(snap.mmdPid)) throw Error("这个导出仍在进行中");
  return snap;
}

// Finish an interrupted export with the frames that were written.
async function recover(id, log = () => {}) {
  const snap = snapshotById(id);
  const frames = await countFrames(snap, snap.temp);
  if (!frames) throw Error("中断的导出里没有可用画面：" + snap.temp);
  log(`恢复中断的导出：${frames} 帧`);
  const job = {
    avi: snap.avi,
    temp: snap.temp,
    output: snap.output,
    pmm: snap.pmm,
    startFrame: snap.startFrame,
    avgTimePerFrame: snap.avgTimePerFrame,
    frames,
  };
  const r = await finish(job, snap, log);
  remember({
    ok: true,
    recovered: true,
    ...r,
    frames,
    startFrame: snap.startFrame,
  });
  return r;
}

// Throw an interrupted export away.
function discard(id) {
  const snap = snapshotById(id);
  fs.rmSync(snap.temp, { force: true });
  fs.rmSync(maskTemp(snap.temp), { force: true });
  fs.rmSync(path.join(pendingDir(), id + ".json"), { force: true });
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
    const started = Date.now();
    try {
      const r = await finish(job, undefined, log);
      remember({
        ok: true,
        ...r,
        frames: job.frames,
        startFrame: job.startFrame,
        // Seconds, measured by the plugin in MMD (setup, render, time MMD
        // waited for the encoder, FFmpeg's finish after the last frame) and
        // here (adding audio, moving files).
        ...(job.timing && typeof job.timing === "object"
          ? {
              timing: {
                ...job.timing,
                finish: (Date.now() - started) / 1000,
              },
            }
          : {}),
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
  MASK_MODES,
  presetMask,
  withRange,
  snapshotPath,
  interrupted,
  recover,
  discard,
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
