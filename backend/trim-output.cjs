"use strict";
const path = require("node:path");
const { containerFor } = require("./trim.cjs");

// Naming only: the queue chooses the first ready clip and supplies its
// filesystem collision check. No queue, application state or output writes.
function trimOutputPath(first, o, exists) {
  let dir = path.dirname(first.path);
  if (o.location === "encoded") dir = path.join(dir, "Encoded");
  if (o.location === "custom") {
    if (typeof o.outputDir !== "string" || !path.isAbsolute(o.outputDir))
      throw Error("请选择有效的自定义输出目录");
    dir = o.outputDir;
  }
  let ext = containerFor(first.codec);
  if (o.audio?.mode !== "none" && o.audio?.codec === "pcm" && ext === "mp4")
    ext = "mkv";
  const base = path.parse(first.path).name + "_剪辑";
  for (let n = 1; n < 100000; n++) {
    const out = path.join(dir, base + (n === 1 ? "" : ` (${n})`) + "." + ext);
    if (!exists(out)) return out;
  }
  throw Error("无法分配不重名的输出文件");
}
module.exports = { trimOutputPath };
