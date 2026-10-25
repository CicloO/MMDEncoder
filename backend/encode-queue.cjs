"use strict";
const {
  appError,
  validationIssue,
  validationError,
  serializeError,
  summary,
  sourceText,
} = require("./errors.cjs");
const { formatVideoSummary } = require("../locales/video-summary.mjs");
// Video page queue (视频压制): adding sources (files and PNG sequences),
// the per-job preview, and encoding the queue with settings frozen per job.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const { signature: enhancementSignature } = require("./enhancements.cjs");
const sequence = require("./sequence.cjs");
const { createEncoder } = require("./encode-job.cjs");
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

// The service owns shared resources and queue state. Read them through narrow
// accessors so other queues and detection remain visible without sharing State.
function createEncodeQueue({
  getJobs,
  setJobs,
  getSettings,
  engineInfo,
  engines,
  verification,
  isDetecting,
  isRunning,
  setRunning,
  onNotice,
  isStopped,
  setStopped,
  waitDetection,
  toolsBusy,
  trimExporting,
  getDetectionLog,
  getUiState,
  appendEvidence,
  run,
  locate,
  probeMedia,
  hasSoxr,
  emit,
  emitProgress,
  commit,
  flushEvidence,
  killActive,
  probeLimit,
  schema,
  reorder,
}) {
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
            engineInfo().ffprobe,
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
      throw appError("VIDEO_FILES_LIMIT");
    await locate();
    const folders = new Map(); // picked PNGs of one folder: read it once
    // A video can be queued more than once (e.g. two different settings);
    // only several pictures of one sequence picked together count once.
    const sequences = new Set();
    const added = [];
    for (const input of paths) {
      if (typeof input !== "string" || !path.isAbsolute(input))
        throw appError("SOURCE_PATH_REQUIRED");
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
        onNotice(summary("VIDEO_NO_SEQUENCE", { name: path.basename(input) }));
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
        name: seq
          ? summary("PNG_SEQUENCE_NAME", { name: seq.name }).message
          : path.basename(input),
        ...(seq
          ? { nameData: summary("PNG_SEQUENCE_NAME", { name: seq.name }) }
          : {}),
        status: "probing",
        progress: 0,
        ...(seq ? { sequence: { ...seq, ...sequenceRate(SEQUENCE_FPS) } } : {}),
      };
      getJobs().push(job);
      added.push({ job, input, seq });
    }
    // All files are in the queue (in order) before any is read; then a few
    // are read at a time. A file removed meanwhile is not read. Finished
    // reads reach the window at most every 200 ms (emitProgress), not once
    // per file; the response carries the final state.
    emit();
    await Promise.all(
      added.map((a) =>
        probeLimit(() => (getJobs().includes(a.job) ? probeJob(a) : undefined)),
      ),
    );
    return getUiState();
  }
  async function probeJob({ job, input, seq }) {
    const resolved = job.path;
    try {
      if (!engineInfo().ffprobe) throw appError("FFPROBE_REQUIRED");
      if (/\.png$/i.test(resolved) && !seq) throw appError("PNG_SINGLE");
      if (seq?.missing !== null && seq?.missing !== undefined)
        throw appError("PNG_GAP", {
          missing: seq.missing,
          start: seq.start,
          total: seq.total,
        });
      if (seq) {
        job.meta = await sequenceMeta(job);
        job.status = "ready";
        emitProgress();
        // Usable now; the total size (one stat per frame) follows, outside
        // the import limit so other files are not held up.
        void sequence
          .size(seq, () => getJobs().includes(job))
          .then((total) => {
            if (total === undefined || !job.sequence || !job.meta) return;
            job.sequence.size = total;
            job.meta = withSequenceRate(job.meta, job.sequence);
            emitProgress();
          });
        return;
      }
      const stat = fs.statSync(input);
      if (!stat.isFile()) throw appError("INPUT_FILE_REQUIRED");
      const r = await run(
        engineInfo().ffprobe,
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
        job.log = summary("VIDEO_TIMESTAMP_FAILED", {
          detail: e.message,
        }).message;
      }
      job.meta.size = stat.size;
      job.status = "ready";
    } catch (e) {
      job.status = "invalid";
      job.errorData = {
        ...serializeError(appError("VIDEO_PROBE_FAILED")),
        issues: [serializeError(e)],
      };
      job.error = job.errorData.message + "：" + e.message;
    }
    emitProgress();
  }
  // A PNG sequence has no frame rate of its own: the user sets it (default
  // SEQUENCE_FPS), and length and timing follow from it.
  async function sequenceMeta(job) {
    const q = job.sequence;
    const r = await run(
      engineInfo().ffprobe,
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
    const j = getJobs().find((j) => j.id === id);
    if (!j) throw appError("JOB_NOT_FOUND");
    return j;
  }
  // The settings a job encodes with: its own when "单独设置" is on for it
  // (job.ownSettings), otherwise the page's.
  function settingsFor(job) {
    return job.ownSettings
      ? { ...getSettings(), ...job.ownSettings }
      : getSettings();
  }
  function preview(job, s = settingsFor(job)) {
    const issues = core.validateIssues(s, job.meta);
    if (
      (s.vsr || s.vfg) &&
      (!verification().verified ||
        verification().signature !== enhancementSignature(s))
    )
      issues.push(validationIssue("VIDEO_RTX_NOT_VERIFIED"));
    if (!job.meta) issues.push(validationIssue("SOURCE_META_REQUIRED"));
    if (!engineInfo().ffmpeg) issues.push(validationIssue("FFMPEG_REQUIRED"));
    // Mask only encodes with FFmpeg's lossless x264 / VP9, not the chosen encoder.
    const maskOnly = s.alphaMode === "mask";
    if (!maskOnly && s.encoder.startsWith("nvencc:") && !engineInfo().nvencc)
      issues.push(validationIssue("NVENCC_REQUIRED"));
    if (
      !maskOnly &&
      !isDetecting() &&
      !engines().some((e) => e.id === s.encoder)
    )
      issues.push(validationIssue("ENCODER_UNAVAILABLE"));
    const available = engines().find((e) => e.id === s.encoder);
    if (!maskOnly && available && !available.depths.includes(s.bitDepth))
      issues.push(validationIssue("ENCODER_DEPTH_UNVERIFIED"));
    if (
      s.encoder === "nvencc:hevc" &&
      s.alphaMode === "preserve" &&
      !available?.alpha
    )
      issues.push(validationIssue("HEVC_ALPHA_UNVERIFIED"));
    let paths = { output: "" },
      commands = [];
    try {
      paths = core.outputPaths(
        nameSource(job),
        s,
        getJobs().indexOf(job) + 1,
        fs.existsSync,
      );
      if (job.meta && issues.length === 0)
        commands = core.singlePass(
          core.buildCommands(job, s, engineInfo(), paths),
        );
    } catch (e) {
      issues.push(serializeError(e));
    }
    const target = (() => {
      try {
        return core.parseFps(s.fps)?.value;
      } catch {
        return null;
      }
    })();
    const meta = job.meta;
    const engine = core.ENGINES.find((e) => e.id === s.encoder);
    const summaryData = meta
      ? {
          code: maskOnly ? "VIDEO_MASK_PREVIEW" : "VIDEO_PREVIEW",
          params: {
            width: meta.width,
            height: meta.height,
            sourceFps: meta.fpsText || "",
            targetFps: target ? s.fps : "",
            encoder: s.encoder,
            engineKey: engine?.labelKey || "",
            engineParams: engine?.labelParams || {},
            bitDepth: s.bitDepth,
            audio: s.audio,
            container: s.container,
            repeatFrames: !maskOnly && target > meta.fps,
            nvencc: !maskOnly && s.encoder.startsWith("nvencc:"),
          },
          message: "",
        }
      : undefined;
    if (summaryData)
      summaryData.message = formatVideoSummary(
        { t: sourceText, number: String },
        summaryData,
      );
    return {
      ...paths,
      dimensions: meta ? core.dimensions(s, meta) : null,
      summary: summaryData?.message || "",
      summaryData,
      command: core.commandText(commands, { prepare: true }),
      errors: [...new Set(issues.map((issue) => issue.message))],
      issues,
    };
  }
  const encode = createEncoder({
    engineInfo,
    engines,
    verification,
    isStopped,
    jobIndex: (job) => getJobs().indexOf(job) + 1,
    nameSource,
    appendEvidence,
    run,
    commit,
    emit,
    emitProgress,
  });
  async function queue(jobs) {
    if (toolsBusy() || verification().busy) throw appError("VIDEO_TOOLS_BUSY");
    if (isRunning()) throw appError("QUEUE_RUNNING");
    if (trimExporting()) throw appError("TRIM_EXPORT_BUSY");
    // Validate the frozen per-job settings first; a bad alpha source must not
    // prevent valid items from continuing, or be mislabeled as an engine fault.
    jobs = jobs.filter((j) => {
      j.settings = clone(j._retrySettings || settingsFor(j));
      const issues = core.validateIssues(j.settings, j.meta);
      if (!issues.length) return true;
      j.status = "invalid";
      j.errorData = serializeError(validationError(issues));
      j.error = j.errorData.message;
      return false;
    });
    if (!jobs.length) {
      onNotice(summary("VIDEO_EMPTY_QUEUE"));
      emit();
      return;
    }
    setRunning(true);
    setStopped(false);
    emit();
    (async () => {
      await waitDetection();
      engineInfo().soxr = await hasSoxr();
      // Take jobs in the queue's current order so drag-sorting during a run applies.
      const pending = new Set(jobs);
      while (pending.size) {
        const job =
          getJobs().find((j) => pending.has(j)) ||
          pending.values().next().value;
        pending.delete(job);
        // Removed from the queue while waiting: withdrawn, not run.
        if (!getJobs().includes(job)) continue;
        if (isStopped()) {
          if (job.status !== "partial") job.status = "cancelled";
          continue;
        }
        await encode(job);
      }
    })()
      .catch((e) =>
        onNotice(summary("VIDEO_QUEUE_FAILED", { detail: e.message })),
      )
      .finally(() => {
        setRunning(false);
        flushEvidence();
        emit();
      });
  }
  // Actions that change the queue; the service sends the new state after each.
  const actions = {
    remove(payload) {
      const job = requireJob(payload.id);
      if (job.status === "encoding" || (isRunning() && job.settings))
        throw appError("JOB_REMOVE_BUSY");
      setJobs(getJobs().filter((j) => j.id !== job.id));
    },
    async setAudio(payload) {
      // Replace one video's audio with another file (empty path: use the
      // video's own audio again), as on the media page's merge.
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (isRunning() && job.settings))
        throw appError("JOB_AUDIO_BUSY");
      const file = payload?.path || "";
      if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw appError("AUDIO_FILE_INVALID");
      delete job.audioMeta;
      delete job.audioDuration;
      delete job.audioOffset; // another audio: its alignment no longer holds
      if (!file) {
        delete job.audioPath;
        return;
      }
      await locate();
      const info = await probeMedia(file);
      if (!info.audio) throw appError("AUDIO_TRACK_REQUIRED");
      job.audioPath = file;
      job.audioMeta = info.audio;
      job.audioDuration = info.audioDuration;
    },
    // 音频对齐 of a replacement audio with the video's own sound (seconds,
    // > 0 its start is cut, < 0 silence first); null clears it.
    setAudioOffset(payload) {
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (isRunning() && job.settings))
        throw appError("JOB_ALIGNMENT_BUSY");
      const offset = payload?.offset;
      if (offset === null || offset === undefined) {
        delete job.audioOffset;
        return;
      }
      if (!job.audioPath) throw appError("AUDIO_REPLACEMENT_REQUIRED");
      if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600)
        throw appError("AUDIO_ALIGNMENT_INVALID");
      job.audioOffset = offset;
    },
    requeue(payload) {
      // Put a finished or cancelled item back in the queue; the next start
      // freezes the current settings, and existing outputs get a numbered name.
      if (isRunning()) throw appError("REQUEUE_BUSY");
      const job = requireJob(payload.id);
      if (!["done", "cancelled"].includes(job.status))
        throw appError("REQUEUE_STATUS_INVALID");
      if (!job.meta) throw appError("SOURCE_READD_REQUIRED");
      for (const key of [
        "settings",
        "output",
        "maskOutput",
        "_maskReady",
        "error",
        "errorData",
        "softwareRetry",
        "stage",
        "elapsed",
        "startedAt",
      ])
        delete job[key];
      job.status = "ready";
      job.progress = 0;
    },
    clearCompleted() {
      setJobs(
        getJobs().filter((j) => !["done", "cancelled"].includes(j.status)),
      );
    },
    async start() {
      if (verification().busy) throw appError("RTX_ENCODING_BUSY");
      if (toolsBusy()) throw appError("TOOLS_ENCODING_BUSY");
      await locate();
      if (isDetecting()) await waitDetection();
      await queue(
        getJobs().filter(
          (j) => j.status === "ready" || (j.status === "invalid" && j.meta),
        ),
      );
    },
    cancel() {
      setStopped(true);
      killActive();
    },
    async retry(payload) {
      if (isRunning()) throw appError("RETRY_BUSY");
      const j = requireJob(payload.id);
      if (!["failed", "partial", "cancelled", "invalid"].includes(j.status))
        throw appError("RETRY_UNNEEDED");
      if (!j.meta) throw appError("SOURCE_READD_REQUIRED");
      let s = clone(j.settings || settingsFor(j));
      if (payload.software) {
        if (s.vsr || s.vfg) throw appError("RTX_SOFTWARE_UNSUPPORTED");
        if (s.alphaMode === "preserve" && s.encoder === "nvencc:hevc")
          throw appError("HEVC_ALPHA_SOFTWARE_UNSUPPORTED");
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
        onNotice(summary("VIDEO_SOFTWARE_RETRY"));
      } else if (j.status !== "partial") s = clone(settingsFor(j));
      const issues = core.validateIssues(s, j.meta);
      if (issues.length) throw validationError(issues);
      j._retrySettings = s;
      await queue([j]);
      delete j._retrySettings;
    },
    // "单独设置" for one video: own: true starts from the page's settings,
    // own: false drops them (changes made there are not kept); patch edits
    // the video's own settings.
    setJobSettings(payload) {
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (isRunning() && job.settings))
        throw appError("JOB_SETTINGS_BUSY");
      if (payload.own === false) delete job.ownSettings;
      else if (payload.own === true) job.ownSettings = clone(getSettings());
      if (payload.patch) {
        if (!job.ownSettings) throw appError("JOB_SETTINGS_REQUIRED");
        job.ownSettings = { ...job.ownSettings, ...schema(payload.patch) };
      }
    },
    reorderJobs(payload) {
      setJobs(reorder(getJobs(), payload.ids));
    },
    setSequenceFps(payload) {
      const job = requireJob(payload?.id);
      if (!job.sequence) throw appError("PNG_SEQUENCE_REQUIRED");
      if (!SEQUENCE_RATES.includes(payload.fps))
        throw appError("SEQUENCE_FPS_INVALID");
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
        throw appError("SEQUENCE_FPS_BUSY");
      Object.assign(job.sequence, sequenceRate(payload.fps));
      if (job.meta) job.meta = withSequenceRate(job.meta, job.sequence);
    },
  };
  // Questions answered without changing anything (add sends updates itself
  // while it reads each file and returns the state when done).
  const queries = {
    add(payload) {
      if (verification().busy) throw appError("RTX_IMPORT_BUSY");
      if (toolsBusy()) throw appError("TOOLS_IMPORT_BUSY");
      return add(payload.paths);
    },
    preview: (payload) => preview(requireJob(payload.id)),
    logs: (payload) =>
      payload.id
        ? requireJob(payload.id).log || summary("VIDEO_NO_LOG").message
        : getDetectionLog(),
  };
  return { actions, queries, requireJob };
}
module.exports = { createEncodeQueue };
