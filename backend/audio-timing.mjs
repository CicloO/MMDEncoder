// Pure timing shared by commands and the alignment UI. No display strings,
// process state or rounding of the reference frame-rate fraction.
export function parseFrameRate(value) {
  const parts = String(value ?? "")
    .trim()
    .split("/");
  if (parts.length > 2) return null;
  const numerator = Number(parts[0]);
  const denominator = parts.length === 2 ? Number(parts[1]) : 1;
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  )
    return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0
    ? { numerator, denominator, fps }
    : null;
}

export function effectiveAudioOffset(offset = 0, shiftFrames = 0, fpsText) {
  if (!Number.isFinite(offset) || !Number.isSafeInteger(shiftFrames))
    return NaN;
  if (!shiftFrames) return offset;
  const rate = parseFrameRate(fpsText);
  return rate
    ? offset - (shiftFrames * rate.denominator) / rate.numerator
    : NaN;
}

export function referenceTiming(data) {
  const video = data.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const fpsText = video
    ? [video.avg_frame_rate, video.r_frame_rate].find((value) =>
        parseFrameRate(value),
      ) || ""
    : "30/1";
  return {
    fpsText,
    fallback: !video,
    hasVideo: !!video,
    hasAudio: !!audio,
    duration:
      Number((video || audio)?.duration) || Number(data.format?.duration) || 0,
  };
}
