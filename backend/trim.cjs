"use strict";
// Public trimming API; process, cache, index, range and transaction owners
// live in their own modules. Callers keep the existing interface.
const { run, rational, compatibility } = require("./trim-probe.cjs");
const { release, clearCache } = require("./trim-source.cjs");
const {
  INTRA,
  seekTime,
  snap,
  segment,
  timing,
  pieces,
  containerFor,
} = require("./trim-range.cjs");
const { index } = require("./trim-index.cjs");
const { cut } = require("./trim-cut.cjs");
const { frameJpeg } = require("./trim-frame.cjs");
module.exports = {
  INTRA,
  index,
  snap,
  segment,
  compatibility,
  containerFor,
  timing,
  pieces,
  cut,
  frameJpeg,
  release,
  clearCache,
  seekTime,
  rational,
  run,
};
