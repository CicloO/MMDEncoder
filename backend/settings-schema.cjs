"use strict";
const { appError } = require("./errors.cjs");
const { DEFAULTS } = require("./definitions.cjs");
function schema(p, full = false) {
  if (!p || typeof p !== "object" || Array.isArray(p))
    throw appError("SETTINGS_OBJECT_REQUIRED");
  if (full && Object.keys(DEFAULTS).some((k) => !(k in p)))
    throw appError("PRESET_FIELDS_MISSING");
  for (const [k, v] of Object.entries(p)) {
    if (
      !(k in DEFAULTS) ||
      typeof v !== typeof DEFAULTS[k] ||
      (typeof v === "number" && !Number.isFinite(v))
    )
      throw appError("SETTINGS_FIELD_INVALID", { field: k });
    if (typeof v === "string" && v.length > 4096)
      throw appError("SETTINGS_TEXT_TOO_LONG", { field: k });
  }
  return p;
}

module.exports = { schema };
