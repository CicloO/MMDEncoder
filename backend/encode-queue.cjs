"use strict";
// Video page queue (视频压制): adding sources (files and PNG sequences),
// the per-job preview, and encoding the queue with settings frozen per job.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const { signature: enhancementSignature } = require("./enhancements.cjs");
const sequence = require("./sequence.cjs");
const { uiState } = require("./ui-state.cjs");
// Frame rate a PNG sequence starts with; it can be changed per sequence.
const SEQUENCE_FPS = 30;
const SEQUENCE_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
// The NTSC rates as exact fractions for FFmpeg.
const sequenceRate = (fps) => ({
  fps,
  fpsText:
    { 23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001" }[fps] ||
    String(fps),
});
// Output names come from the sequence name (frame_0001.png → frame).
const nameSource = (job) =>
  job.sequence
    ? path.join(job.sequence.dir, job.sequence.name + ".png")
    : job.path;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ctx: the service's shared state and helpers (see createService). `stopped`
// and `detectPromise` are read through ctx because other parts change them.
function createEncodeQueue(ctx) {
  const { state, emit, emitProgress, run, locate, probeMedia, hasSoxr } = ctx;
  // Presentation times (seconds, ascending) of about the first 120 frames.
  // Packet timestamps need no decoding (a 4K intermediate took seconds to
  // decode); packets come in decode order, so a few more are read and the
  // last ones dropped in case a reordered frame falls past the sample.
  // Without packet timestamps the frames are decoded as before.
  const SAMPLE = 120,
    REORDER = 16;
  async function sampleTimes(input) {
    const probe = async (entries, extra = []) =>
      JSON.parse(
        (
          await run(
            state.engineInfo.ffprobe,
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-read_intervals",
              "%+#" + (SAMPLE + REORDER),
              ...extra,
              "-show_entries",
              entries,
              "-of",
              "json",
              input,
            ],
            { timeout: 15000 },
          )
        ).stdout,
      );
    const packets = (await probe("packet=pts_time")).packets || [];
    const pts = packets.map((p) => Number(p.pts_time));
    if (packets.length && pts.every(Number.isFinite)) {
      pts.sort((a, b) => a - b);
      // Fewer packets than asked: the whole file was read, nothing is missing.
      return packets.length < SAMPLE + REORDER ? pts : pts.slice(0, SAMPLE);
    }
    const frames = (await probe("frame=best_effort_timestamp_time")).frames;
    return (frames || [])
      .slice(0, SAMPLE)
      .map((f) => Number(f.best_effort_timestamp_time))
      .filter(Number.isFinite);
  }
  async function add(paths) {
    if (!Array.isArray(paths) || paths.length > 1000)
      throw Error("请选择最多 1000 个视频文件");
    await locate();
    const folders = new Map(); // picked PNGs of one folder: read it once
    // A video can be queued more than once (e.g. two different settings);
    // only several pictures of one sequence picked together count once.
    const sequences = new Set();
    const added = [];
    for (const input of paths) {
      if (typeof input !== "string" || !path.isAbsolute(input))
        throw Error("素材必须为绝对路径");
      let resolved = path.resolve(input);
      // A PNG, or a folder of them, is read as an image sequence; picking
      // several frames of one sequence adds it once.
      let seq = null,
        isDir = false;
      try {
        isDir = (await fs.promises.stat(resolved)).isDirectory();
        if (isDir || /\.png$/i.test(resolved))
          seq = await sequence.find(resolved, folders);
      } catch {}
      if (isDir && !seq) {
        state.notice = "文件夹里没有 PNG 序列：" + path.basename(input);
        continue;
      }
      if (seq) {
        resolved = seq.first;
        const key = seq.pattern.toLowerCase();
        if (sequences.has(key)) continue;
        sequences.add(key);
      }
      const job = {
        id: crypto.randomUUID(),
        path: resolved,
        name: seq ? seq.name + "（PNG 序列）" : path.basename(input),
        status: "probing",
        progress: 0,
        ...(seq ? { sequence: { ...seq, ...sequenceRate(SEQUENCE_FPS) } } : {}),
      };
      state.jobs.push(job);
      added.push({ job, input, seq });
    }
    // All files are in the queue (in order) before any is read; then a few
    // are read at a time. A file removed meanwhile is not read. Finished
    // reads reach the window at most every 200 ms (emitProgress), not once
    // per file; the response carries the final state.
    emit();
    await Promise.all(
      added.map((a) =>
        ctx.probeLimit(() =>
          state.jobs.includes(a.job) ? probeJob(a) : undefined,
        ),
      ),
    );
    return uiState(state);
  }
  async function probeJob({ job, input, seq }) {
    const resolved = job.path;
    try {
      if (!state.engineInfo.ffprobe)
        throw Error("未找到 ffprobe，无法读取素材");
      if (/\.png$/i.test(resolved) && !seq)
        throw Error(
          "只有一张 PNG，不是图片序列（需要 name_0001.png 这样带连续编号的文件）",
        );
      if (seq?.missing !== null && seq?.missing !== undefined)
        throw Error(
          `PNG 序列不连续：缺少第 ${seq.missing} 帧（从 ${seq.start} 开始找到 ${seq.total} 张）`,
        );
      if (seq) {
        job.meta = await sequenceMeta(job);
        job.status = "ready";
        emitProgress();
        // Usable now; the total size (one stat per frame) follows, outside
        // the import limit so other files are not held up.
        void sequence
          .size(seq, () => state.jobs.includes(job))
          .then((total) => {
            if (total === undefined || !job.sequence || !job.meta) return;
            job.sequence.size = total;
            job.meta = withSequenceRate(job.meta, job.sequence);
            emitProgress();
          });
        return;
      }
      const stat = fs.statSync(input);
      if (!stat.isFile()) throw Error("输入不是文件");
      const r = await run(
        state.engineInfo.ffprobe,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", input],
        { timeout: 30000 },
      );
      job.meta = core.metadata(JSON.parse(r.stdout));
      // Stream rates often both say 30/1 even when individual timestamps vary.
      // A bounded sample of the first frames' times establishes positive VFR
      // evidence without scanning an entire multi-hour source during import.
      try {
        const ts = await sampleTimes(input);
        const gaps = ts
          .slice(1)
          .map((v, i) => v - ts[i])
          .filter((v) => v > 0)
          .sort((a, b) => a - b);
        if (gaps.length > 2) {
          const median = gaps[Math.floor(gaps.length / 2)];
          job.meta.vfr ||= gaps.some(
            (g) => Math.abs(g - median) > Math.max(0.002, median * 0.1),
          );
        }
      } catch (e) {
        job.log = "帧时间戳抽样未完成：" + e.message;
      }
      job.meta.size = stat.size;
      job.status = "ready";
    } catch (e) {
      job.status = "invalid";
      job.error = "素材探测失败：" + e.message;
    }
    emitProgress();
  }
  // A PNG sequence has no frame rate of its own: the user sets it (default
  // SEQUENCE_FPS), and length and timing follow from it.
  async function sequenceMeta(job) {
    const q = job.sequence;
    const r = await run(
      state.engineInfo.ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        ...core.inputArgs(job),
      ],
      { timeout: 30000 },
    );
    return withSequenceRate(core.metadata(JSON.parse(r.stdout)), q);
  }
  function withSequenceRate(meta, q) {
    return {
      ...meta,
      fps: q.fps,
      fpsText: q.fpsText,
      duration: q.count / q.fps,
      // Unknown (undefined) while the frames are still being added up.
      size: q.size,
      sizing: q.size === undefined,
      // Bits per second over the whole sequence, as for a video file.
      videoBitRate:
        q.size === undefined
          ? undefined
          : Math.round((q.size * 8 * q.fps) / q.count),
      vfr: false,
      sequence: { count: q.count, start: q.start },
    };
  }
  function requireJob(id) {
    const j = state.jobs.find((j) => j.id === id);
    if (!j) throw Error("未找到此任务");
    return j;
  }
  // The settings a job encodes with: its own when "单独设置" is on for it
  // (job.ownSettings), otherwise the page's.
  function settingsFor(job) {
    return job.ownSettings
      ? { ...state.settings, ...job.ownSettings }
      : state.settings;
  }
  function preview(job, s = settingsFor(job)) {
    const errors = core.validate(s, job.meta);
    if (
      (s.vsr || s.vfg) &&
      (!state.enhancements.verified ||
        state.enhancements.signature !== enhancementSignature(s))
    )
      errors.push("RTX 设置尚未通过本机验证，请在“超分补帧”页验证所选设置");
    if (!job.meta) errors.push("素材信息尚未读取成功");
    if (!state.engineInfo.ffmpeg) errors.push("未找到 FFmpeg");
    // Mask only encodes with FFmpeg's lossless x264 / VP9, not the chosen encoder.
    const maskOnly = s.alphaMode === "mask";
    if (
      !maskOnly &&
      s.encoder.startsWith("nvencc:") &&
      !state.engineInfo.nvencc
    )
      errors.push("未找到 NVEncC");
    if (
      !maskOnly &&
      !state.detecting &&
      !state.engines.some((e) => e.id === s.encoder)
    )
      errors.push("编码器当前不可用，请重新检测或选择其他编码器");
    const available = state.engines.find((e) => e.id === s.encoder);
    if (!maskOnly && available && !available.depths.includes(s.bitDepth))
      errors.push("此编码器未通过所选位深的实测");
    if (
      s.encoder === "nvencc:hevc" &&
      s.alphaMode === "preserve" &&
      !available?.alpha
    )
      errors.push(
        "本机 NVEncC HEVC Alpha 试编码未通过；请检查显卡支持和驱动，或选择 ProRes 4444 / VP9",
      );
    let paths = { output: "" },
      commands = [];
    try {
      paths = core.outputPaths(
        nameSource(job),
        s,
        state.jobs.indexOf(job) + 1,
        fs.existsSync,
      );
      if (job.meta && errors.length === 0)
        commands = core.singlePass(
          core.buildCommands(job, s, state.engineInfo, paths),
        );
    } catch (e) {
      errors.push(e.message);
    }
    const target = (() => {
      try {
        return core.parseFps(s.fps)?.value;
      } catch {
        return null;
      }
    })();
    const meta = job.meta;
    const summary = !meta
      ? ""
      : maskOnly
        ? `${meta.width} × ${meta.height} · ${meta.fpsText || "未知"}${target ? " → " + s.fps : ""} FPS / 分离 Alpha · 仅黑白遮罩 · ${s.container === "webm" ? "VP9" : "H.264"} 无损 · 无音频 · ${s.container.toUpperCase()}`
        : `${meta.width} × ${meta.height} · ${meta.fpsText || "未知"}${target ? " → " + s.fps : ""} FPS / ${core.ENGINES.find((e) => e.id === s.encoder)?.label || s.encoder} · ${s.bitDepth}-bit · ${s.audio === "none" ? "无音频" : s.audio.toUpperCase()} · ${s.container.toUpperCase()}${target > meta.fps ? "；通过重复帧提高帧率，不生成新的运动细节" : ""}${s.encoder.startsWith("nvencc:") ? "；NVEncC 预处理需要额外临时磁盘空间" : ""}`;
    return {
      ...paths,
      dimensions: meta ? core.dimensions(s, meta) : null,
      summary,
      command: core.commandText(commands, { prepare: true }),
      errors: [...new Set(errors)],
    };
  }
  function append(job, text) {
    // The last 200 KB in memory (the whole log goes to disk): cut back only
    // past 256 KB, so a long encode does not copy 200 KB on every line.
    job.log = (job.log || "") + text;
    if (job.log.length > 256000) job.log = job.log.slice(-200000);
    const pieces = ctx.pendingLogs.get(job.id) || [];
    pieces.push(text);
    ctx.pendingLogs.set(job.id, pieces);
  }
  // gpuMask: the Alpha mask may go to NVENC (see core.maskOnNvenc); a run
  // where that fails is done again once with the mask on the CPU.
  async function encode(job, gpuMask = true) {
    const s = job.settings;
    const maskOnly =
      job.status === "partial" && job.output && fs.existsSync(job.output);
    job.status = "encoding";
    job.error = undefined;
    job.progress = 0;
    job.startedAt = Date.now();
    job.stage = maskOnly ? "重试 Alpha 遮罩" : "准备";
    emit();
    let tempDir,
      gpuMaskUsed = false,
      again = false;
    try {
      const errors = core.validate(s, job.meta);
      if (
        (s.vsr || s.vfg) &&
        (!state.enhancements.verified ||
          state.enhancements.signature !== enhancementSignature(s))
      )
        errors.push("RTX 设置未通过本机验证");
      // Selected but not applicable here (too small an enlargement, mask only):
      // say so instead of silently scaling another way.
      const skipped = core.artcnnSkipped(s, job.meta);
      if (skipped) append(job, "ArtCNN：" + skipped + "\n");
      if (core.usesArtcnn(s, job.meta) && !state.engineInfo.libplacebo)
        errors.push(
          "本机无法运行 ArtCNN 放大（FFmpeg 需要支持 Vulkan 的显卡和驱动），请改用 Lanczos",
        );
      if (errors.length) throw Error(errors.join("；"));
      const engine = state.engines.find((e) => e.id === s.encoder);
      if (
        s.alphaMode !== "mask" &&
        (!engine || !engine.depths.includes(s.bitDepth))
      )
        throw Error("所选编码器或位深未通过本机试编码，请调整参数");
      if (
        s.encoder === "nvencc:hevc" &&
        s.alphaMode === "preserve" &&
        !engine?.alpha
      )
        throw Error("本机未通过 HEVC Alpha 试编码，已停止以避免丢失透明通道");
      let paths = maskOnly
        ? { output: job.output, maskOutput: job.maskOutput }
        : core.outputPaths(
            nameSource(job),
            s,
            state.jobs.indexOf(job) + 1,
            fs.existsSync,
          );
      const dir = path.dirname(paths.output);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      tempDir = fs.mkdtempSync(path.join(dir, ".mmd-"));
      const temps = {
        output: path.join(tempDir, "video." + s.container),
        maskOutput: s.alphaMask
          ? path.join(tempDir, "mask." + s.container)
          : undefined,
      };
      let commands = core.buildCommands(
        job,
        s,
        gpuMask
          ? state.engineInfo
          : { ...state.engineInfo, nvencLossless: false },
        temps,
      );
      gpuMaskUsed = gpuMask && JSON.stringify(commands).includes('"lossless"');
      // Colour and mask in one pass; redoing just the mask keeps its own run.
      commands = maskOnly
        ? commands.filter((c) => c.mask)
        : core.singlePass(commands);
      job.output = maskOnly ? job.output : undefined;
      job.maskOutput = paths.maskOutput;
      for (let i = 0; i < commands.length; i++) {
        if (ctx.stopped) throw Error("已取消");
        const c = commands[i];
        job.stage = c.stage;
        append(job, "\n" + core.commandText([c]) + "\n");
        emit();
        let progressBuffer = "";
        await (c.pipeFrom ? run.piped : (c, o) => run(c.exe, c.args, o))(c, {
          encoding: true,
          onData: (t, stream) => {
            append(job, t);
            progressBuffer = (progressBuffer + t).slice(-8192);
            const matches = [...progressBuffer.matchAll(/out_time_us=(\d+)/g)];
            if (matches.length && job.meta.duration) {
              const seconds = Number(matches.at(-1)[1]) / 1000000;
              job.progress = Math.min(
                99,
                Math.max(
                  job.progress,
                  (100 * (i + Math.min(1, seconds / job.meta.duration))) /
                    commands.length,
                ),
              );
            } else if (c.exe === state.engineInfo.nvencc) {
              const m = t.match(/(\d+(?:\.\d+)?)%/);
              if (m)
                job.progress = Math.min(
                  99,
                  (100 * (i + Number(m[1]) / 100)) / commands.length,
                );
            }
            job.elapsed = (Date.now() - job.startedAt) / 1000;
            emitProgress();
          },
        });
        if (c.output === temps.output) {
          try {
            await ctx.commit(temps.output, paths.output);
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            paths = core.outputPaths(
              nameSource(job),
              s,
              state.jobs.indexOf(job) + 1,
              fs.existsSync,
            );
            await ctx.commit(temps.output, paths.output);
            job.maskOutput = paths.maskOutput;
          }
          job.output = paths.output;
        }
        if (c.mask) {
          await ctx.commit(temps.maskOutput, paths.maskOutput);
          job.maskOutput = paths.maskOutput;
        }
      }
      job.status = "done";
      job.progress = 100;
      job.stage = "完成";
    } catch (e) {
      append(job, "\n" + e.message + "\n");
      // The GPU mask failed (an encoder session limit, an older GPU…) before
      // anything was kept: once more with the mask on the CPU.
      if (gpuMaskUsed && !ctx.stopped && !job.output) {
        append(job, "\n显卡无损遮罩未能完成，改用 CPU（x264）重新压制。\n");
        again = true;
        return;
      }
      job.status =
        job.output && fs.existsSync(job.output)
          ? "partial"
          : ctx.stopped
            ? "cancelled"
            : "failed";
      job.error = ctx.stopped ? "任务已取消" : e.message;
      job.stage =
        job.status === "partial" ? "主视频已完成，遮罩未完成" : "已停止";
    } finally {
      if (tempDir)
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
          append(job, "临时文件清理失败：" + e.message);
        }
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      emit();
      if (again) await encode(job, false);
    }
  }
  async function queue(jobs) {
    if (ctx.tools.state.busy || state.enhancements.busy)
      throw Error("工具管理或 RTX 验证中，请稍后处理队列");
    if (state.running) throw Error("队列正在运行");
    if (ctx.trimExporting()) throw Error("无损剪辑正在导出，请等它结束");
    // Validate the frozen per-job settings first; a bad alpha source must not
    // prevent valid items from continuing, or be mislabeled as an engine fault.
    jobs = jobs.filter((j) => {
      j.settings = clone(j._retrySettings || settingsFor(j));
      const errors = core.validate(j.settings, j.meta);
      if (!errors.length) return true;
      j.status = "invalid";
      j.error = errors.join("；");
      return false;
    });
    if (!jobs.length) {
      state.notice = "没有可编码的待处理任务";
      emit();
      return;
    }
    state.running = true;
    ctx.stopped = false;
    emit();
    (async () => {
      await ctx.detectPromise;
      state.engineInfo.soxr = await hasSoxr();
      // Take jobs in the queue's current order so drag-sorting during a run applies.
      const pending = new Set(jobs);
      while (pending.size) {
        const job =
          state.jobs.find((j) => pending.has(j)) ||
          pending.values().next().value;
        pending.delete(job);
        // Removed from the queue while waiting: withdrawn, not run.
        if (!state.jobs.includes(job)) continue;
        if (ctx.stopped) {
          if (job.status !== "partial") job.status = "cancelled";
          continue;
        }
        await encode(job);
      }
    })()
      .catch((e) => (state.notice = e.message))
      .finally(() => {
        state.running = false;
        ctx.flushEvidence();
        emit();
      });
  }
  // Actions that change the queue; the service sends the new state after each.
  const actions = {
    remove(payload) {
      const job = requireJob(payload.id);
      if (job.status === "encoding" || (state.running && job.settings))
        throw Error("已提交任务不能在运行中移除");
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
    },
    async setAudio(payload) {
      // Replace one video's audio with another file (empty path: use the
      // video's own audio again), as on the media page's merge.
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (state.running && job.settings))
        throw Error("已提交任务不能更换音频");
      const file = payload?.path || "";
      if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw Error("请选择有效的音频文件");
      delete job.audioMeta;
      delete job.audioDuration;
      delete job.audioOffset; // another audio: its alignment no longer holds
      if (!file) {
        delete job.audioPath;
        return;
      }
      await locate();
      const info = await probeMedia(file);
      if (!info.audio) throw Error("这个文件没有音轨");
      job.audioPath = file;
      job.audioMeta = info.audio;
      job.audioDuration = info.audioDuration;
    },
    // 音频对齐 of a replacement audio with the video's own sound (seconds,
    // > 0 its start is cut, < 0 silence first); null clears it.
    setAudioOffset(payload) {
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (state.running && job.settings))
        throw Error("已提交任务不能更改对齐");
      const offset = payload?.offset;
      if (offset === null || offset === undefined) {
        delete job.audioOffset;
        return;
      }
      if (!job.audioPath) throw Error("请先替换音频");
      if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600)
        throw Error("对齐数据无效");
      job.audioOffset = offset;
    },
    requeue(payload) {
      // Put a finished or cancelled item back in the queue; the next start
      // freezes the current settings, and existing outputs get a numbered name.
      if (state.running) throw Error("请等待当前队列结束后再重新导出");
      const job = requireJob(payload.id);
      if (!["done", "cancelled"].includes(job.status))
        throw Error("只有已完成或已取消的任务可以重新导出");
      if (!job.meta) throw Error("素材探测失败，请重新添加");
      for (const key of [
        "settings",
        "output",
        "maskOutput",
        "error",
        "stage",
        "elapsed",
        "startedAt",
      ])
        delete job[key];
      job.status = "ready";
      job.progress = 0;
    },
    clearCompleted() {
      state.jobs = state.jobs.filter(
        (j) => !["done", "cancelled"].includes(j.status),
      );
    },
    async start() {
      if (state.enhancements.busy) throw Error("RTX 验证中，请稍后开始编码");
      if (ctx.tools.state.busy) throw Error("工具安装中，请稍后开始编码");
      await locate();
      if (state.detecting) await ctx.detectPromise;
      await queue(
        state.jobs.filter(
          (j) => j.status === "ready" || (j.status === "invalid" && j.meta),
        ),
      );
    },
    cancel() {
      ctx.stopped = true;
      ctx.killActive();
    },
    async retry(payload) {
      if (state.running) throw Error("请等待当前队列停止");
      const j = requireJob(payload.id);
      if (!["failed", "partial", "cancelled", "invalid"].includes(j.status))
        throw Error("此任务不需要重试");
      if (!j.meta) throw Error("素材探测失败，请重新添加");
      let s = clone(j.settings || settingsFor(j));
      if (payload.software) {
        if (s.vsr || s.vfg)
          throw Error(
            "RTX VSR / VFG 不能软件回退；请修复本机 RTX 功能，或在“超分补帧”里关闭后重试",
          );
        if (s.alphaMode === "preserve" && s.encoder === "nvencc:hevc")
          throw Error(
            "HEVC Alpha 无软件回退；请修复 NVEncC，或明确改选 ProRes 4444 / VP9 后重试",
          );
        const e = core.ENGINES.find((e) => e.id === s.encoder);
        s.encoder =
          {
            h264: "libx264",
            hevc: "libx265",
            av1: "libsvtav1",
            vp9: "libvpx-vp9",
            prores: "prores_ks",
          }[e?.codec] || "libx264";
        s.quality = 18;
        s.preset = s.encoder === "libsvtav1" ? "6" : "medium";
        s.rateControl = "quality";
        s.lookahead = 0;
        s.lookaheadLevel = 0;
        state.notice = "软件重试使用 CRF 18；CQ 与 CRF 数值不等效";
      } else if (j.status !== "partial") s = clone(settingsFor(j));
      const errors = core.validate(s, j.meta);
      if (errors.length) throw Error(errors.join("；"));
      j._retrySettings = s;
      await queue([j]);
      delete j._retrySettings;
    },
    // "单独设置" for one video: own: true starts from the page's settings,
    // own: false drops them (changes made there are not kept); patch edits
    // the video's own settings.
    setJobSettings(payload) {
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (state.running && job.settings))
        throw Error("已提交任务不能更改设置");
      if (payload.own === false) delete job.ownSettings;
      else if (payload.own === true) job.ownSettings = clone(state.settings);
      if (payload.patch) {
        if (!job.ownSettings) throw Error("这个视频没有开启单独设置");
        job.ownSettings = { ...job.ownSettings, ...ctx.schema(payload.patch) };
      }
    },
    reorderJobs(payload) {
      state.jobs = ctx.reorder(state.jobs, payload.ids);
    },
    setSequenceFps(payload) {
      const job = requireJob(payload?.id);
      if (!job.sequence) throw Error("这个素材不是图片序列");
      if (!SEQUENCE_RATES.includes(payload.fps)) throw Error("帧率无效");
      if (
        ![
          "ready",
          "invalid",
          "done",
          "failed",
          "cancelled",
          "partial",
        ].includes(job.status)
      )
        throw Error("正在处理的素材不能改帧率");
      Object.assign(job.sequence, sequenceRate(payload.fps));
      if (job.meta) job.meta = withSequenceRate(job.meta, job.sequence);
    },
  };
  // Questions answered without changing anything (add sends updates itself
  // while it reads each file and returns the state when done).
  const queries = {
    add(payload) {
      if (state.enhancements.busy) throw Error("RTX 验证中，请稍后添加素材");
      if (ctx.tools.state.busy) throw Error("工具安装中，请稍后添加素材");
      return add(payload.paths);
    },
    preview: (payload) => preview(requireJob(payload.id)),
    logs: (payload) =>
      payload.id
        ? requireJob(payload.id).log || "暂无日志"
        : state.detectionLog,
  };
  return { actions, queries, requireJob };
}
module.exports = { createEncodeQueue };
