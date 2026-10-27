"use strict";
const {
  appError,
  validationIssue,
  validationError,
  serializeError,
  diagnosticMessage,
  summary,
  stage,
} = require("./errors.cjs");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const { commandProcesses } = require("./command-processes.cjs");
const { signature: enhancementSignature } = require("./enhancements.cjs");
const { withMaskCapabilities } = require("./mask-settings.cjs");
function createEncoder({
  engineInfo,
  engines,
  verification,
  isStopped,
  jobIndex,
  nameSource,
  appendEvidence,
  run,
  commit,
  emit,
  emitProgress,
}) {
  function append(job, text) {
    // The last 200 KB in memory (the whole log goes to disk): cut back only
    // past 256 KB, so a long encode does not copy 200 KB on every line.
    job.log = (job.log || "") + text;
    if (job.log.length > 256000) job.log = job.log.slice(-200000);
    appendEvidence(job.id, text);
  }
  // A failed GPU mask gets one CPU attempt. A lossy retry after the colour
  // was committed keeps that file and only re-encodes the missing mask.
  async function encode(job, gpuMask = true) {
    const s = job.settings;
    const maskOnly =
      job.status === "partial" && job.output && fs.existsSync(job.output);
    job.status = "encoding";
    job.error = undefined;
    job.errorData = undefined;
    job.softwareRetry = undefined;
    if (gpuMask) delete job.noteData;
    job._maskReady = false;
    job.progress = 0;
    job.startedAt = Date.now();
    job.stage = stage(maskOnly ? "retry_mask" : "preparing");
    emit();
    let tempDir,
      gpuMaskUsed = false,
      again = false,
      failedGpuMask = false;
    try {
      const issues = core.validateIssues(s, job.meta);
      if (
        (s.vsr || s.vfg) &&
        (!verification().verified ||
          verification().signature !== enhancementSignature(s))
      )
        issues.push(validationIssue("RTX_REVALIDATION_REQUIRED"));
      // Selected but not applicable here (too small an enlargement, mask only):
      // say so instead of silently scaling another way.
      const skipped = core.artcnnSkipped(s, job.meta);
      if (skipped)
        append(
          job,
          summary("VIDEO_ARTCNN_SKIPPED", { detail: skipped }).message + "\n",
        );
      if (core.usesArtcnn(s, job.meta) && !engineInfo().libplacebo)
        issues.push(validationIssue("ARTCNN_UNAVAILABLE"));
      if (issues.length) throw validationError(issues);
      const engine = engines().find((e) => e.id === s.encoder);
      if (
        s.alphaMode !== "mask" &&
        (!engine || !engine.depths.includes(s.bitDepth))
      )
        throw appError("ENCODER_TRIAL_REQUIRED");
      if (
        s.encoder === "nvencc:hevc" &&
        s.alphaMode === "preserve" &&
        !engine?.alpha
      )
        throw appError("HEVC_ALPHA_STOPPED");
      let paths = maskOnly
        ? { output: job.output, maskOutput: job.maskOutput }
        : core.outputPaths(nameSource(job), s, jobIndex(job), fs.existsSync);
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
        {
          ...withMaskCapabilities(engineInfo(), engines()),
          allowGpuMask: gpuMask,
        },
        temps,
      );
      gpuMaskUsed = gpuMask && commands.some((c) => c.maskEncoding?.gpu);
      const note = commands.find((c) => c.maskEncoding?.note)?.maskEncoding
        .note;
      if (gpuMask && note) {
        job.noteData = note;
        append(job, note.message + "\n");
      }
      // Colour and mask in one pass; redoing just the mask keeps its own run.
      commands = maskOnly
        ? commands.filter((c) => c.mask)
        : core.singlePass(commands);
      job.output = maskOnly ? job.output : undefined;
      job.maskOutput = paths.maskOutput;
      for (let i = 0; i < commands.length; i++) {
        if (isStopped()) throw appError("VIDEO_CANCELLED");
        const c = commands[i];
        job.stage = c.stage;
        append(job, "\n" + core.commandText([c]) + "\n");
        emit();
        let progressBuffer = "";
        failedGpuMask = !!c.maskEncoding?.gpu;
        await (
          commandProcesses(c).length > 1
            ? run.piped
            : (c, o) => run(c.exe, c.args, o)
        )(c, {
          encoding: true,
          onData: (t, stream) => {
            append(job, t);
            // A three-stage chain reports progress only on the muxer's
            // stdout; upstream diagnostics must not advance its timeline.
            if (c.pipeTo && stream !== "out") return;
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
            } else if (c.exe === engineInfo().nvencc) {
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
        failedGpuMask = false;
        if (c.output === temps.output) {
          try {
            await commit(temps.output, paths.output);
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            paths = core.outputPaths(
              nameSource(job),
              s,
              jobIndex(job),
              fs.existsSync,
            );
            await commit(temps.output, paths.output);
            job.maskOutput = paths.maskOutput;
          }
          job.output = paths.output;
        }
        if (c.mask) {
          await commit(temps.maskOutput, paths.maskOutput);
          job.maskOutput = paths.maskOutput;
          job._maskReady = true;
        }
      }
      job.status = "done";
      job.progress = 100;
      job.stage = stage("done");
    } catch (e) {
      append(job, "\n" + diagnosticMessage(e) + "\n");
      // Retry a lossy GPU mask once. Storage, cancellation, timeout and a
      // downstream colour encoder/muxer failure are not GPU-mask failures.
      const lossy = s.maskFormat === "gpu-lossy";
      const retryLossyMask =
        failedGpuMask &&
        !e.timedOut &&
        !e.cancelled &&
        !["ENOSPC", "EACCES", "EPERM", "ENOENT"].includes(
          e.systemCode || e.code,
        ) &&
        !(e.processIndex > 0);
      if (
        gpuMask &&
        !isStopped() &&
        (lossy ? retryLossyMask : gpuMaskUsed && !job.output)
      ) {
        const note = summary(
          lossy ? "MASK_GPU_RUNTIME_FALLBACK" : "VIDEO_GPU_MASK_RETRY",
        );
        job.noteData = note;
        append(job, "\n" + note.message + "\n");
        if (job.output && fs.existsSync(job.output)) job.status = "partial";
        again = true;
        return;
      }
      job.status =
        job.output && fs.existsSync(job.output)
          ? "partial"
          : isStopped()
            ? "cancelled"
            : "failed";
      let displayError;
      if (isStopped()) displayError = appError("TASK_CANCELLED");
      else if (e.runnerErrorData) {
        displayError = appError("VIDEO_ENGINE_FAILED", { detail: e.message });
        displayError.params = { error: serializeError(e) };
      } else
        displayError =
          e.code && typeof e.code === "string"
            ? e
            : appError("VIDEO_ENGINE_FAILED", { detail: e.message });
      job.errorData = serializeError(displayError);
      job.error = job.errorData.message;
      job.softwareRetry = !["ENOSPC", "EACCES", "EPERM", "ENOENT"].includes(
        e.systemCode || e.code,
      );
      job.stage = stage(job.status === "partial" ? "partial" : "stopped");
    } finally {
      if (tempDir)
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
          append(
            job,
            summary("VIDEO_CLEANUP_FAILED", { detail: e.message }).message,
          );
        }
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      emit();
      if (again) await encode(job, false);
    }
  }

  return encode;
}
module.exports = { createEncoder };
