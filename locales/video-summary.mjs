// Video preview records contain technical values, not language-dependent
// fragments. Both the diagnostic fallback and the renderer use this projection.
export function formatVideoSummary(runtime, value) {
  if (!value || !["VIDEO_PREVIEW", "VIDEO_MASK_PREVIEW"].includes(value.code))
    return null;
  const p = value.params;
  const codec =
    p.maskEncoder === "hevc_nvenc"
      ? "HEVC"
      : p.container === "webm"
        ? "VP9"
        : "H.264";
  const maskFacts =
    !p.maskFormat || p.maskFormat === "lossless"
      ? runtime.t("output.maskFacts", { codec })
      : p.maskEncoder
        ? runtime.t("mask.encodingFacts", {
            codec,
            mode: p.maskEncoder.endsWith("_nvenc") ? "CQ" : "CRF",
            quality: runtime.number(p.maskQuality),
          })
        : runtime.t(
            p.maskFormat === "gpu-lossy" ? "mask.gpuLossy" : "mask.x264Lossy",
          );
  const fps = p.sourceFps || runtime.t("presentation.unknown");
  let text = runtime.t(`message.${value.code}`, {
    width: runtime.number(p.width, { useGrouping: false }),
    height: runtime.number(p.height, { useGrouping: false }),
    fps: p.targetFps
      ? runtime.t("video.previewFPS", { source: fps, target: p.targetFps })
      : fps,
    maskFacts,
    encoder: p.engineKey ? runtime.t(p.engineKey, p.engineParams) : p.encoder,
    bitDepth: runtime.number(p.bitDepth, { useGrouping: false }),
    audio:
      p.audio === "none" ? runtime.t("output.noAudio") : p.audio.toUpperCase(),
    container: p.container.toUpperCase(),
  });
  if (p.repeatFrames)
    text = runtime.t("video.previewWithRepeat", { summary: text });
  return text;
}
