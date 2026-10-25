"use strict";
const fs = require("node:fs");
// Reads actual source/output metadata. Queue membership and process resources
// remain with their existing owners; no settings or application State enters.
function createFileDetails({
  isToolsBusy,
  requireMediaJob,
  requireJob,
  locate,
  ffprobe,
  run,
  inputArgs,
}) {
  return async function readDetails(payload) {
    if (isToolsBusy()) throw Error("工具安装中，请稍后查看详情");
    // payload.media: a job from the audio / video tools queue
    const job = payload.media
      ? requireMediaJob(payload.id)
      : requireJob(payload.id);
    await locate();
    const result = {};
    for (const [key, file] of payload.media
      ? [
          ["before", job.path],
          ...(job.audioPath ? [["audio", job.audioPath]] : []),
          ["after", job.output],
        ]
      : [
          ["before", job.path],
          ["after", job.output],
          ["mask", job.maskOutput],
        ]) {
      if (!file || !fs.existsSync(file)) {
        result[key] = {
          message: key === "before" ? "源文件不存在" : "尚未生成文件",
        };
        continue;
      }
      try {
        const r = await run(
          ffprobe(),
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            // A PNG sequence is read as the video it becomes.
            ...(key === "before" && !payload.media && job.sequence
              ? inputArgs(job)
              : [file]),
          ],
          { timeout: 30000 },
        );
        result[key] = {
          path: key === "before" && job.sequence ? job.sequence.pattern : file,
          ...JSON.parse(r.stdout),
        };
      } catch (e) {
        result[key] = {
          path: file,
          message: "无法读取实际文件：" + e.message,
        };
      }
    }
    return result;
  };
}
module.exports = { createFileDetails };
