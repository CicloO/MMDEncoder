"use strict";
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const { signature: enhancementSignature } = require("./enhancements.cjs");
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
        (!verification().verified ||
          verification().signature !== enhancementSignature(s))
      )
        errors.push("RTX 设置未通过本机验证");
      // Selected but not applicable here (too small an enlargement, mask only):
      // say so instead of silently scaling another way.
      const skipped = core.artcnnSkipped(s, job.meta);
      if (skipped) append(job, "ArtCNN：" + skipped + "\n");
      if (core.usesArtcnn(s, job.meta) && !engineInfo().libplacebo)
        errors.push(
          "本机无法运行 ArtCNN 放大（FFmpeg 需要支持 Vulkan 的显卡和驱动），请改用 Lanczos",
        );
      if (errors.length) throw Error(errors.join("；"));
      const engine = engines().find((e) => e.id === s.encoder);
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
        gpuMask ? engineInfo() : { ...engineInfo(), nvencLossless: false },
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
        if (isStopped()) throw Error("已取消");
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
        }
      }
      job.status = "done";
      job.progress = 100;
      job.stage = "完成";
    } catch (e) {
      append(job, "\n" + e.message + "\n");
      // The GPU mask failed (an encoder session limit, an older GPU…) before
      // anything was kept: once more with the mask on the CPU.
      if (gpuMaskUsed && !isStopped() && !job.output) {
        append(job, "\n显卡无损遮罩未能完成，改用 CPU（x264）重新压制。\n");
        again = true;
        return;
      }
      job.status =
        job.output && fs.existsSync(job.output)
          ? "partial"
          : isStopped()
            ? "cancelled"
            : "failed";
      job.error = isStopped() ? "任务已取消" : e.message;
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

  return encode;
}
module.exports = { createEncoder };
