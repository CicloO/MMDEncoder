"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { appError } = require("./errors.cjs");
const { frameOffset } = require("./audio-alignment.cjs");
// Queue membership and shared running state retain their existing owners.
function createVideoAudioActions({
  requireJob,
  isRunning,
  locate,
  probeMedia,
}) {
  const replacements = new WeakMap();
  return {
    async setAudio(payload) {
      // Replace one video's audio with another file (empty path: use the
      // video's own audio again), as on the media page's merge.
      const job = requireJob(payload?.id);
      if (job.status === "encoding" || (isRunning() && job.settings))
        throw appError("JOB_AUDIO_BUSY");
      const file = payload?.path || "";
      if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw appError("AUDIO_FILE_INVALID");
      const request = {};
      replacements.set(job, request);
      delete job.audioMeta;
      delete job.audioDuration;
      delete job.audioOffset; // another audio: its alignment no longer holds
      delete job.audioShiftFrames;
      if (!file) {
        delete job.audioPath;
        return;
      }
      await locate();
      const info = await probeMedia(file);
      if (replacements.get(job) !== request) return;
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
      if (
        payload?.expectedAudioPath !== undefined &&
        payload.expectedAudioPath !== job.audioPath
      )
        throw appError("ALIGN_CANCELLED");
      const offset = payload?.offset;
      if (offset === null || offset === undefined) {
        delete job.audioOffset;
        delete job.audioShiftFrames;
        return;
      }
      if (!job.audioPath) throw appError("AUDIO_REPLACEMENT_REQUIRED");
      if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600)
        throw appError("AUDIO_ALIGNMENT_INVALID");
      const frames =
        payload.shiftFrames === undefined
          ? job.audioShiftFrames || 0
          : payload.shiftFrames;
      frameOffset(
        offset,
        frames,
        job.sequence?.fpsText ||
          job.sequence?.fps ||
          job.meta?.fpsText ||
          job.meta?.fps,
      );
      job.audioOffset = offset;
      if (frames) job.audioShiftFrames = frames;
      else delete job.audioShiftFrames;
    },
  };
}
module.exports = { createVideoAudioActions };
