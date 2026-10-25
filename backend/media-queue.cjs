"use strict";
const {
  appError,
  serializeError,
  sourceText,
  summary,
} = require("./errors.cjs");
// Media page queue (音视频提取与合并): each file is processed on its own with
// the options chosen when the queue starts; the output name is generated per
// file and never reused.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const media = require("./media.cjs");
const { mediaLocation } = require("./media-location.cjs");
const { createMediaJob } = require("./media-job.cjs");

// The service owns shared resources and stop/busy state. The queue owns its
// list and batch scheduling through explicit capabilities.
function createMediaQueue({
  getJobs,
  setJobs,
  engineInfo,
  isRunning,
  setRunning,
  isStopped,
  setStopped,
  onNotice,
  emit,
  emitProgress,
  run,
  locate,
  probeMedia,
  hasSoxr,
  commit,
  dataDir,
  isBusy,
  probeLimit,
  reorder,
}) {
  function requireMediaJob(id) {
    const job = getJobs().find((j) => j.id === id);
    if (!job) throw appError("MEDIA_JOB_MISSING");
    return job;
  }
  // File parameters for the media queue, read like the video queue's. Audio-only
  // files get an audio summary; a failed read leaves the file usable.
  const mediaProbes = new Set();
  async function probeMediaJob(job) {
    try {
      await locate();
      if (!engineInfo().ffprobe) return;
      const r = await run(
        engineInfo().ffprobe,
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
        if (!a) throw appError("MEDIA_NO_STREAMS");
        job.meta = {
          audioOnly: true,
          codec: a.codec_name || sourceText("presentation.unknown"),
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
      job.metaErrorData = serializeError(
        appError("MEDIA_META_FAILED", {
          detail: e.message,
          error: serializeError(e),
        }),
      );
      job.metaError = job.metaErrorData.message;
    }
    emit();
  }
  const runMediaJob = createMediaJob({
    engineInfo,
    probeMedia,
    hasSoxr,
    run,
    commit,
    isStopped,
    dataDir,
    emit,
    emitProgress,
  });
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
          getJobs().some(
            (j) =>
              j.status === "ready" &&
              j.path.toLowerCase() === file.toLowerCase(),
          )
        )
          continue;
        getJobs().push({
          id: crypto.randomUUID(),
          path: file,
          name: path.basename(file),
          size: stat.size,
          status: "ready",
        });
        // A few at a time (shared with the video queue); a file removed
        // before its turn is not read.
        const job = getJobs().at(-1);
        const probe = probeLimit(() =>
          getJobs().includes(job) ? probeMediaJob(job) : undefined,
        );
        mediaProbes.add(probe);
        void probe.finally(() => mediaProbes.delete(probe));
      }
    },
    async mediaSetAudio(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw appError("MEDIA_AUDIO_BUSY");
      const file = payload?.path || "";
      if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw appError("MEDIA_AUDIO_INPUT");
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
      if (job.status === "running") throw appError("MEDIA_REMOVE_BUSY");
      setJobs(getJobs().filter((j) => j !== job));
    },
    mediaClearCompleted() {
      setJobs(
        getJobs().filter((j) => !["done", "cancelled"].includes(j.status)),
      );
    },
    mediaRequeue(payload) {
      if (isRunning()) throw appError("MEDIA_REQUEUE_BUSY");
      const job = requireMediaJob(payload?.id);
      if (!["done", "cancelled", "failed"].includes(job.status))
        throw appError("MEDIA_REQUEUE_STATE");
      for (const key of [
        "output",
        "error",
        "errorData",
        "log",
        "elapsed",
        "startedAt",
      ])
        delete job[key];
      job.status = "ready";
    },
    async mediaStart(payload) {
      // File-info reads started by mediaAdd are short; let them finish
      // instead of reporting them as a busy task.
      await Promise.all([...mediaProbes]);
      if (isBusy()) throw appError("MEDIA_BUSY");
      const options = payload || {};
      if (!["audio", "video", "merge"].includes(options.operation))
        throw appError("MEDIA_OPERATION");
      if (
        options.location === "custom" &&
        !(
          typeof options.outputDir === "string" &&
          path.isAbsolute(options.outputDir)
        )
      )
        throw appError("MEDIA_OUTPUT_DIR");
      await locate();
      if (!engineInfo().ffmpeg || !engineInfo().ffprobe)
        throw appError("MEDIA_TOOLS_REQUIRED");
      const jobs = getJobs().filter((j) => j.status === "ready");
      if (!jobs.length) throw appError("MEDIA_QUEUE_EMPTY");
      setRunning(true);
      setStopped(false);
      emit();
      (async () => {
        const pending = new Set(jobs);
        while (pending.size) {
          const job =
            getJobs().find((j) => pending.has(j)) ||
            pending.values().next().value;
          pending.delete(job);
          // Removed from the queue while waiting: withdrawn, not run.
          if (!getJobs().includes(job)) continue;
          if (isStopped()) {
            job.status = "cancelled";
            continue;
          }
          await runMediaJob(job, options);
        }
      })()
        .catch((e) =>
          onNotice(
            summary("MEDIA_BATCH_FAILED", {
              detail: e.message,
              error: serializeError(e),
            }),
          ),
        )
        .finally(() => {
          setRunning(false);
          emit();
        });
    },
    mediaReorder(payload) {
      setJobs(reorder(getJobs(), payload.ids));
    },
    // 音频对齐 of a merge's added audio with the video's own sound (seconds,
    // > 0 its start is cut, < 0 silence first); null clears it.
    mediaSetAudioOffset(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw appError("MEDIA_ALIGN_BUSY");
      const offset = payload?.offset;
      if (offset === null || offset === undefined) {
        delete job.audioOffset;
        return;
      }
      if (!job.audioPath) throw appError("MEDIA_AUDIO_REQUIRED");
      if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600)
        throw appError("MEDIA_ALIGN_INVALID");
      job.audioOffset = offset;
    },
    // The 音频对齐 dialog's result for one file: extracting its audio then
    // cuts (offset > 0) or pads (offset < 0) its start to line up with the
    // reference, and with trim ends where the reference does. null clears it.
    async mediaSetAlign(payload) {
      const job = requireMediaJob(payload?.id);
      if (job.status === "running") throw appError("MEDIA_ALIGN_BUSY");
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
        throw appError("MEDIA_ALIGN_INVALID");
      let length = 0;
      if (a.trim) {
        await locate();
        length = (await probeMedia(a.reference)).audioDuration || 0;
        if (!length) throw appError("MEDIA_REFERENCE_LENGTH");
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
  };
  return { actions, queries, requireMediaJob };
}
module.exports = { createMediaQueue };
