"use strict";
const { DEFAULTS } = require("./definitions.cjs");
function schema(p, full = false) {
  if (!p || typeof p !== "object" || Array.isArray(p))
    throw Error("设置必须是对象");
  if (full && Object.keys(DEFAULTS).some((k) => !(k in p)))
    throw Error("预设缺少必要字段");
  for (const [k, v] of Object.entries(p)) {
    if (
      !(k in DEFAULTS) ||
      typeof v !== typeof DEFAULTS[k] ||
      (typeof v === "number" && !Number.isFinite(v))
    )
      throw Error("无效设置字段：" + k);
    if (typeof v === "string" && v.length > 4096)
      throw Error("设置文本过长：" + k);
  }
  return p;
}

module.exports = { schema };
