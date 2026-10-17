const path = require("node:path");
const { createTools } = require("../backend/tools.cjs");
const managed = process.env.MMD_TEST_TOOLS_ROOT
  ? createTools({ root: process.env.MMD_TEST_TOOLS_ROOT }).paths()
  : {};
const engineDir =
  process.env.MMD_TEST_ENGINE_DIR ||
  (managed.ffmpeg && path.dirname(managed.ffmpeg)) ||
  "C:/ffmpeg/bin";
module.exports = {
  engineDir,
  ff: managed.ffmpeg || path.join(engineDir, "ffmpeg.exe"),
  fp: managed.ffprobe || path.join(engineDir, "ffprobe.exe"),
  nv: managed.nvencc || path.join(engineDir, "NVEncC.exe"),
};
