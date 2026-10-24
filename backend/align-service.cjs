"use strict";
// Audio alignment for the windows (音频对齐): the waveform preview of a file
// and the automatic alignment of two (align.cjs).
const path = require("node:path");
const { spawn } = require("node:child_process");
const align = require("./align.cjs");

// engineInfo(): the tool paths; locate(): finds the tools first.
function createAlignService({ engineInfo, locate }) {
  const state = {
    get engineInfo() {
      return engineInfo();
    },
  };
  const queries = {
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
  return { actions: {}, queries };
}
module.exports = { createAlignService };
