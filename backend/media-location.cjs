"use strict";
// Shared output-location projection; the caller owns options and persistence.
function mediaLocation(o) {
  return {
    outputMode: ["source", "encoded", "custom"].includes(o.location)
      ? o.location
      : "source",
    outputDir: o.outputDir || "",
  };
}
module.exports = { mediaLocation };
