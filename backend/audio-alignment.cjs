"use strict";
const { effectiveAudioOffset } = require("./audio-timing.mjs");
const { appError } = require("./errors.cjs");

function frameOffset(offset, shiftFrames, fpsText) {
  if (!Number.isSafeInteger(shiftFrames))
    throw appError("ALIGN_SHIFT_FRAMES_INVALID");
  const effective = effectiveAudioOffset(offset, shiftFrames, fpsText);
  if (!Number.isFinite(effective))
    throw appError("ALIGN_FRAME_RATE_INVALID", {
      frameRate: String(fpsText || ""),
    });
  if (Math.abs(effective) > 24 * 3600)
    throw appError("ALIGN_SHIFT_RANGE_INVALID");
  return effective;
}
module.exports = { frameOffset };
