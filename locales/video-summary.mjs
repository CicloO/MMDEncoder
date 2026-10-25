// Video preview records contain technical values, not language-dependent
// fragments. Both the diagnostic fallback and the renderer use this projection.
export function formatVideoSummary(runtime, value) {
  if (!value || !["VIDEO_PREVIEW", "VIDEO_MASK_PREVIEW"].includes(value.code))
    return null;
  const p = value.params;
  const fps = p.sourceFps || runtime.t("presentation.unknown");
  let text = runtime.t(`message.${value.code}`, {
    width: runtime.number(p.width, { useGrouping: false }),
    height: runtime.number(p.height, { useGrouping: false }),
    fps: p.targetFps
      ? runtime.t("video.previewFPS", { source: fps, target: p.targetFps })
      : fps,
    codec: p.container === "webm" ? "VP9" : "H.264",
    encoder: p.engineKey ? runtime.t(p.engineKey, p.engineParams) : p.encoder,
    bitDepth: runtime.number(p.bitDepth, { useGrouping: false }),
    audio:
      p.audio === "none" ? runtime.t("output.noAudio") : p.audio.toUpperCase(),
    container: p.container.toUpperCase(),
  });
  if (p.repeatFrames)
    text = runtime.t("video.previewWithRepeat", { summary: text });
  if (p.nvencc) text = runtime.t("video.previewWithNvencc", { summary: text });
  return text;
}
