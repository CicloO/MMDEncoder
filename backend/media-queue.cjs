"use strict";
// Media page queue (音视频提取与合并): each file is processed on its own with
// the options chosen when the queue starts; the output name is generated per
// file and never reused.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const media = require("./media.cjs");
const align = require("./align.cjs");
const { spawn } = require("node:child_process");

// ctx: the service's shared state and helpers (see createService). `stopped`
// is read and set through ctx because the video queue shares it.
function createMediaQueue(ctx) {
  const { state, emit, emitProgress, run, locate, probeMedia, hasSoxr } = ctx;
  function mediaLocation(o) {
    return {
      outputMode: ["source", "encoded", "custom"].includes(o.location)
        ? o.location
        : "source",
      outputDir: o.outputDir || "",
    };
  }
  function requireMediaJob(id) {
    const job = state.mediaJobs.find((j) => j.id === id);
    if (!job) throw Error("文件不在列表中");
    return job;
  }
  // File parameters for the media queue, read like the video queue's. Audio-only
  // files get an audio summary; a failed read leaves the file usable.
  const mediaProbes = new Set();
  async function probeMediaJob(job) {
    try {
      await locate();
      if (!state.engineInfo.ffprobe) return;
      const r = await run(
        state.engineInfo.ffprobe,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          job.path,
        ],
        { timeout: 30000 },
      );
      const data = JSON.parse(r.stdout);
      try {
        job.meta = core.metadata(data);
      } catch {
        const a = data.streams?.find((s) => s.codec_type === "audio");
        if (!a) throw Error("未找到音视频轨");
        job.meta = {
          audioOnly: true,
          codec: a.codec_name || "未知",
          duration: Number(data.format?.duration || a.duration) || 0,
          size: Number(data.format?.size) || job.size,
          audio: {
            ...core.audioInfo(a),
            // An audio-only file's overall rate is the audio rate.
            bitRate:
              core.audioInfo(a).bitRate || Number(data.format?.bit_rate) || 0,
          },
        };
      }
    } catch (e) {
      job.metaError = "无法读取文件信息：" + e.message;
    }
    emit();
  }
  async function runMediaJob(job, o) {
    job.status = "running";
    job.error = undefined;
    job.output = undefined;
    job.log = "";
    job.startedAt = Date.now();
    emit();
    let temp;
    try {
      if (o.operation === "merge" && !job.audioPath)
        throw Error("缺少要合并的音频文件");
      if (
        o.hiRes &&
        o.operation !== "video" &&
        !["wav", "flac"].includes(o.audioFormat)
      )
        throw Error("Hi-Res 只支持 WAV / FLAC 输出");
      const p = {
        operation: o.operation,
        input: job.path,
        audioInput: job.audioPath,
        audioFormat: o.audioFormat,
        hiRes: !!o.hiRes && o.operation !== "video",
        audioBitrate: Number(o.audioBitrate) || 0,
        container: o.container === "mkv" ? "mkv" : "mp4",
        fade: media.FADES.includes(Number(o.audioFade))
          ? Number(o.audioFade)
          : 0,
      };
      const source = await probeMedia(job.path);
      const audioSource =
        o.operation === "merge" ? await probeMedia(job.audioPath) : source;
      p.sourceAudio = {
        codec: audioSource.audioCodec,
        bitRate: audioSource.audioBitRate,
        sampleRate: audioSource.audio?.sampleRate,
        bits: audioSource.audio?.bits,
        float: audioSource.audio?.float,
      };
      // A merge is as long as the video (see media.command). The fade-out
      // ends where the audio does: at the video's end, or earlier when the
      // audio is shorter (silence follows).
      if (o.operation === "merge") {
        p.videoDuration = source.videoDuration;
        // The added audio lined up with the video's own (音频对齐).
        p.audioOffset = Number(job.audioOffset) || 0;
      }
      const shift = p.audioOffset || 0;
      p.fadeLength =
        o.operation === "merge" && source.videoDuration
          ? Math.min(audioSource.audioDuration - shift, source.videoDuration)
          : audioSource.audioDuration;
      // Extracting audio lined up with a reference (音频对齐): cut or pad
      // its start; the result ends where the reference does when trimmed.
      if (o.operation === "audio" && job.align) {
        p.align = job.align;
        p.fadeLength =
          job.align.length || audioSource.audioDuration - job.align.offset;
      }
      let hiResNote = "";
      if (p.hiRes) {
        p.soxr = await hasSoxr();
        const plan = media.hiResPlan(p.audioFormat, p.sourceAudio);
        hiResNote = `# Hi-Res：${plan.from} → ${plan.to}，${plan.reason}${plan.action === "resample" ? (p.soxr ? "（soxr 重采样）" : "（当前 FFmpeg 没有 soxr，用内置重采样）") : ""}
`;
      }
      let note = hiResNote;
      if (o.operation !== "audio") {
        const container = media.mergeContainer(p, {
          videoCodec: source.videoCodec,
          audioCodec: audioSource.audioCodec,
        });
        if (container !== p.container) {
          const audio =
            o.operation !== "merge"
              ? ""
              : " / " +
                (p.audioFormat === "copy"
                  ? audioSource.audioCodec || "未知"
                  : p.audioFormat);
          note = `# MP4 放不下此编码（${source.videoCodec || "未知"}${audio}），已改用 MKV\n`;
        }
        p.container = container;
      }
      p.output = media.suggestOutput(p, mediaLocation(o), fs.existsSync);
      if (!p.output) throw Error("无法生成输出文件名");
      media.command(p, state.engineInfo, p.output);
      fs.mkdirSync(path.dirname(p.output), { recursive: true });
      temp = fs.mkdtempSync(path.join(path.dirname(p.output), ".mmd-media-"));
      const target = path.join(temp, "output" + path.extname(p.output));
      const cmd = media.command(p, state.engineInfo, target);
      job.log = note + core.commandText([cmd]) + "\n";
      await run(cmd.exe, cmd.args, {
        encoding: true,
        onData: (t) => {
          job.log = (job.log + t).slice(-200000);
          emitProgress();
        },
      });
      if (ctx.stopped) throw Error("已取消");
      ctx.commit(target, p.output);
      job.output = p.output;
      job.status = "done";
    } catch (e) {
      job.status = ctx.stopped ? "cancelled" : "failed";
      job.error = e.message;
      job.log += "\n" + e.message;
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      try {
        fs.mkdirSync(path.join(ctx.dataDir, "logs"), { recursive: true });
        fs.writeFileSync(
          path.join(ctx.dataDir, "logs", "media-" + job.id + ".log"),
          job.log,
        );
      } catch (e) {
        job.error =
          (job.error ? job.error + "；" : "") + "日志保存失败：" + e.message;
      }
      emit();
    }
  }
  // Actions that change the queue; the service sends the new state after each.
  const actions = {
    mediaAdd(payload) {
      for (const raw of payload?.paths || []) {
        if (typeof raw !== "string" || !path.isAbsolute(raw)) continue;
        const file = path.resolve(raw); // same separators as the video queue
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        if (
          state.mediaJobs.some(
            (j) =>
              j.status === "ready" &&
              j.path.toLowerCase() === file.toLowerCase(),
          )
        )
          continue;
        state.mediaJobs.push({
          id: crypto.randomUUID(),
          path: file,
          name: path.basename(file),
          size: stat.size,
          status: "ready",
        });
        const probe = probeMediaJob(state.mediaJobs.at(-1));
        mediaProbes.add(probe);
        void probe.finally(() => mediaProbes.delete(probe));
      }
    },
    async mediaSetAudio(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw Error("处理中的文件不能更换音频");
      const file = payload?.path || "";
      if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw Error("请选择有效的音频文件");
      if (file) job.audioPath = file;
      else delete job.audioPath;
      delete job.audioMeta;
      delete job.audioOffset; // another audio: its alignment no longer holds
      // The replacement audio's own parameters (Hi-Res preview, checks).
      if (file) {
        await locate();
        const info = await probeMedia(file);
        if (job.audioPath === file && info.audio) job.audioMeta = info.audio;
      }
    },
    mediaRemove(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw Error("处理中的文件不能移除");
      state.mediaJobs = state.mediaJobs.filter((j) => j !== job);
    },
    mediaClearCompleted() {
      state.mediaJobs = state.mediaJobs.filter(
        (j) => !["done", "cancelled"].includes(j.status),
      );
    },
    mediaRequeue(payload) {
      if (state.running) throw Error("请等待当前处理结束后再重新导出");
      const job = requireMediaJob(payload?.id);
      if (!["done", "cancelled", "failed"].includes(job.status))
        throw Error("只有已完成、已取消或失败的文件可以重新导出");
      for (const key of ["output", "error", "log", "elapsed", "startedAt"])
        delete job[key];
      job.status = "ready";
    },
    async mediaStart(payload) {
      // File-info reads started by mediaAdd are short; let them finish
      // instead of reporting them as a busy task.
      await Promise.all([...mediaProbes]);
      if (
        state.running ||
        state.trim.running ||
        state.detecting ||
        ctx.tools.state.busy ||
        state.enhancements.busy ||
        ctx.children.size
      )
        throw Error("请等待当前任务结束");
      const options = payload || {};
      if (!["audio", "video", "merge"].includes(options.operation))
        throw Error("请选择提取音频、提取视频或音视频合并");
      if (
        options.location === "custom" &&
        !(
          typeof options.outputDir === "string" &&
          path.isAbsolute(options.outputDir)
        )
      )
        throw Error("请选择有效的自定义输出目录");
      await locate();
      if (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe)
        throw Error("请先安装 FFmpeg / ffprobe");
      const jobs = state.mediaJobs.filter((j) => j.status === "ready");
      if (!jobs.length) throw Error("没有待处理的文件");
      state.running = true;
      ctx.stopped = false;
      emit();
      (async () => {
        const pending = new Set(jobs);
        while (pending.size) {
          const job =
            state.mediaJobs.find((j) => pending.has(j)) ||
            pending.values().next().value;
          pending.delete(job);
          // Removed from the queue while waiting: withdrawn, not run.
          if (!state.mediaJobs.includes(job)) continue;
          if (ctx.stopped) {
            job.status = "cancelled";
            continue;
          }
          await runMediaJob(job, options);
        }
      })()
        .catch((e) => (state.notice = e.message))
        .finally(() => {
          state.running = false;
          emit();
        });
    },
    mediaReorder(payload) {
      state.mediaJobs = ctx.reorder(state.mediaJobs, payload.ids);
    },
    // 音频对齐 of a merge's added audio with the video's own sound (seconds,
    // > 0 its start is cut, < 0 silence first); null clears it.
    mediaSetAudioOffset(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw Error("处理中的文件不能更改对齐");
      const offset = payload?.offset;
      if (offset === null || offset === undefined) {
        delete job.audioOffset;
        return;
      }
      if (!job.audioPath) throw Error("请先选择要合并的音频");
      if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600)
        throw Error("对齐数据无效");
      job.audioOffset = offset;
    },
    // The 音频对齐 dialog's result for one file: extracting its audio then
    // cuts (offset > 0) or pads (offset < 0) its start to line up with the
    // reference, and with trim ends where the reference does. null clears it.
    async mediaSetAlign(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw Error("处理中的文件不能更改对齐");
      const a = payload?.align;
      if (!a) {
        delete job.align;
        return;
      }
      if (
        typeof a.reference !== "string" ||
        !path.isAbsolute(a.reference) ||
        !Number.isFinite(a.offset) ||
        Math.abs(a.offset) > 24 * 3600
      )
        throw Error("对齐数据无效");
      let length = 0;
      if (a.trim) {
        await locate();
        length = (await probeMedia(a.reference)).audioDuration || 0;
        if (!length) throw Error("读不到参考音频的长度，无法截到参考长度");
      }
      job.align = {
        reference: a.reference,
        offset: a.offset,
        ...(length ? { length } : {}),
      };
    },
  };
  // Questions answered without changing anything.
  const queries = {
    mediaSuggest: (payload) =>
      media.suggestOutput(
        {
          ...(payload || {}),
          // Hi-Res merges go to MKV (see media.mergeContainer).
          ...(payload?.hiRes && payload.operation === "merge"
            ? { container: "mkv" }
            : {}),
        },
        mediaLocation(payload || {}),
        fs.existsSync,
      ),
    mediaLog: (payload) => requireMediaJob(payload?.id).log || "",
    // Sound of a file for the 音频对齐 dialog: mono 16-bit samples at a rate
    // the window can draw and play (Web Audio), at most 20 minutes.
    async alignPreview(payload) {
      const file = payload?.path;
      if (typeof file !== "string" || !path.isAbsolute(file))
        throw Error("请选择有效的音频或视频文件");
      await locate();
      const samples = await align.decode(state.engineInfo.ffmpeg, file, 24000, {
        length: 20 * 60,
      });
      if (!samples.length) throw Error("这个文件没有可用的音轨");
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++)
        pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
      return { rate: 24000, duration: samples.length / 24000, pcm };
    },
    // Where the reference starts in the target (see align.cjs), worked out
    // in a separate process.
    alignRun(payload) {
      for (const f of [payload?.reference, payload?.target])
        if (typeof f !== "string" || !path.isAbsolute(f))
          throw Error("请选择参考音频与目标音频");
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(__dirname, "align-worker.cjs")],
          {
            windowsHide: true,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              MMD_ALIGN_JOB: JSON.stringify({
                ffmpeg: state.engineInfo.ffmpeg,
                reference: payload.reference,
                target: payload.target,
              }),
            },
          },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (err = (err + b).slice(-4000)));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(JSON.parse(out))
            : reject(Error(err.trim() || "自动对齐失败")),
        );
      });
    },
  };
  return { actions, queries, requireMediaJob };
}
module.exports = { createMediaQueue };
