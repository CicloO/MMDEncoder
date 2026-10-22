require("./isolate.cjs");
const path = require("node:path");
const { createTools } = require("../backend/tools.cjs");
const managed = process.env.MMD_TEST_TOOLS_ROOT
  ? createTools({ root: process.env.MMD_TEST_TOOLS_ROOT }).paths()
  : {};
const engineDir =
  process.env.MMD_TEST_ENGINE_DIR ||
  (managed.ffmpeg && path.dirname(managed.ffmpeg)) ||
  "C:/ffmpeg/bin";
// Run one built command, feeding a piped one from its writer (small test clips).
function runCommand(c) {
  const { execFileSync } = require("node:child_process");
  const opts = { stdio: "pipe", maxBuffer: 1 << 30 };
  if (!c.pipeFrom) return execFileSync(c.exe, c.args, opts);
  const input = execFileSync(c.pipeFrom.exe, c.pipeFrom.args, opts);
  return execFileSync(c.exe, c.args, { ...opts, input });
}
module.exports = {
  runCommand,
  engineDir,
  ff: managed.ffmpeg || path.join(engineDir, "ffmpeg.exe"),
  fp: managed.ffprobe || path.join(engineDir, "ffprobe.exe"),
  nv: managed.nvencc || path.join(engineDir, "NVEncC.exe"),
};
