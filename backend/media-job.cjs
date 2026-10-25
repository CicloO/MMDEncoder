"use strict";
const { appError, serializeError, sourceText } = require("./errors.cjs");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const media = require("./media.cjs");
const { mediaLocation } = require("./media-location.cjs");
// One job owns its output transaction and log; the service owns processes,
// shared stop state and resource detection. No queue/application State.
function createMediaJob({
  engineInfo,
  probeMedia,
  hasSoxr,
  run,
  commit,
  isStopped,
  dataDir,
  emit,
  emitProgress,
}) {
  async function runMediaJob(job, o) {
    job.status = "running";
    job.error = undefined;
    job.errorData = undefined;
    job.output = undefined;
    job.log = "";
    job.startedAt = Date.now();
    emit();
    let temp;
    try {
      if (o.operation === "merge" && !job.audioPath)
        throw appError("MEDIA_MERGE_AUDIO_MISSING");
      if (
        o.hiRes &&
        o.operation !== "video" &&
        !["wav", "flac"].includes(o.audioFormat)
      )
        throw appError("MEDIA_HIRES_FORMAT");
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
        hiResNote = sourceText("media.hiresLog", {
          from: plan.from,
          to: plan.to,
          reason: plan.reason,
          resampling:
            plan.action === "resample"
              ? sourceText(p.soxr ? "media.hiresSoxr" : "media.hiresBuiltin")
              : "",
        });
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
                  ? audioSource.audioCodec || sourceText("presentation.unknown")
                  : p.audioFormat);
          note = sourceText("media.containerLog", {
            video: source.videoCodec || sourceText("presentation.unknown"),
            audio,
          });
        }
        p.container = container;
      }
      p.output = media.suggestOutput(p, mediaLocation(o), fs.existsSync);
      if (!p.output) throw appError("MEDIA_OUTPUT_NAME");
      media.command(p, engineInfo(), p.output);
      fs.mkdirSync(path.dirname(p.output), { recursive: true });
      temp = fs.mkdtempSync(path.join(path.dirname(p.output), ".mmd-media-"));
      const target = path.join(temp, "output" + path.extname(p.output));
      const cmd = media.command(p, engineInfo(), target);
      job.log = note + core.commandText([cmd]) + "\n";
      await run(cmd.exe, cmd.args, {
        encoding: true,
        onData: (t) => {
          job.log = (job.log + t).slice(-200000);
          emitProgress();
        },
      });
      if (isStopped()) throw appError("MEDIA_CANCELLED");
      await commit(target, p.output);
      job.output = p.output;
      job.status = "done";
    } catch (e) {
      job.status = isStopped() ? "cancelled" : "failed";
      job.errorData = serializeError(e);
      job.error = job.errorData.message;
      job.log += "\n" + e.message;
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      try {
        fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
        fs.writeFileSync(
          path.join(dataDir, "logs", "media-" + job.id + ".log"),
          job.log,
        );
      } catch (e) {
        const logError = serializeError(
          appError("MEDIA_LOG_SAVE_FAILED", { detail: e.message }),
        );
        job.errorData = job.errorData
          ? {
              ...job.errorData,
              issues: [...(job.errorData.issues || []), logError],
            }
          : logError;
        job.error = (job.error ? job.error + "；" : "") + logError.message;
      }
      emit();
    }
  }
  return runMediaJob;
}
module.exports = { createMediaJob };
