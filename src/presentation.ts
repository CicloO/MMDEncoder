import type { Engine, Preset, Settings, Job } from "./types";
import { localeRuntime, t, summaryMessage } from "./i18n";
import type { MessageKey } from "./i18n";
import { presetDisplayName } from "../locales/preset-names.mjs";
export const videoName = (job: Pick<Job, "name" | "nameData">) =>
  job.nameData ? summaryMessage(job.nameData) : job.name;
export function formatFPS(value?: number | string) {
  if (value === undefined || value === null || value === "")
    return t("presentation.unknown");
  const p = String(value).split("/").map(Number);
  const n = p.length === 2 ? p[0] / p[1] : p[0];
  return Number.isFinite(n) && n > 0
    ? localeRuntime.number(Number(Number(n.toFixed(3)).toFixed(2)), {
        useGrouping: false,
        minimumFractionDigits: Number(n.toFixed(2)) % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      })
    : t("presentation.unknown");
}
export function formatDuration(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return t("presentation.unknown");
  const s = Math.floor(n);
  const [hours, minutes, seconds] = [
    Math.floor(s / 3600),
    Math.floor(s / 60) % 60,
    s % 60,
  ].map((v) =>
    localeRuntime.number(v, { minimumIntegerDigits: 2, useGrouping: false }),
  );
  return t("presentation.clock", { hours, minutes, seconds });
}
export function formatSize(n?: number) {
  if (n === undefined || !Number.isFinite(n) || n < 0)
    return t("presentation.unknown");
  const i =
    n > 0
      ? Math.min(3, Math.max(0, Math.floor(Math.log(n) / Math.log(1024))))
      : 0;
  return localeRuntime.unit(
    n / 1024 ** i,
    ["byte", "kilobyte", "megabyte", "gigabyte"][i],
    {
      minimumFractionDigits: i ? 2 : 0,
      maximumFractionDigits: i ? 2 : 0,
    },
  );
}
export function compatibilityErrors(s: {
  container: string;
  encoder: string;
  audio: string;
  bitDepth: number;
}) {
  const errors: string[] = [];
  if (s.container === "webm") {
    if (!/vp9|av1/.test(s.encoder)) errors.push(t("error.COMPAT_WEBM_VIDEO"));
    if (!["libopus", "none"].includes(s.audio))
      errors.push(t("error.COMPAT_WEBM_AUDIO"));
  }
  if (s.container === "mp4" && ["flac", "pcm_s16le"].includes(s.audio))
    errors.push(t("error.COMPAT_MP4_AUDIO"));
  if (s.encoder === "prores_ks" && !["mov", "mkv"].includes(s.container))
    errors.push(t("error.COMPAT_PRORES_CONTAINER"));
  return errors;
}
const statusKeys: Record<string, MessageKey> = {
  probing: "presentation.status.probing",
  ready: "presentation.status.ready",
  invalid: "presentation.status.invalid",
  encoding: "presentation.status.encoding",
  done: "presentation.status.done",
  partial: "presentation.status.partial",
  failed: "presentation.status.failed",
  cancelled: "presentation.status.cancelled",
};
export const statusLabel = (status: string) =>
  statusKeys[status] ? t(statusKeys[status]) : status;
// Audio fade-in / fade-out lengths, the same on every page (seconds).
export const fadeOptions = () =>
  [0, 0.5, 1, 2].map((seconds) => ({
    value: String(seconds),
    label:
      seconds === 0
        ? t("presentation.fadeOff")
        : t("presentation.fadeSeconds", {
            seconds: localeRuntime.number(seconds),
          }),
  }));
export const fadeHint = () => t("presentation.fadeHint");
export const audioLabels = (): Record<string, string> =>
  Object.fromEntries(
    ["aac", "flac", "pcm_s16le", "libopus", "none"].map((id) => [
      id,
      t(`presentation.audio.${id}` as MessageKey),
    ]),
  );
export function engineLabel(engine: Engine) {
  return engine.labelKey &&
    engine.labelParams &&
    localeRuntime.has(engine.labelKey)
    ? localeRuntime.t(engine.labelKey, engine.labelParams)
    : engine.label;
}
export const presetLabel = (p: Preset, peers: Preset[] = []) =>
  presetDisplayName(localeRuntime, p, peers);

// What a set of settings makes, in a few words (queue tags, preset choices).
export function targetLabel(s: Settings, engines: Engine[]) {
  if (s.alphaMode === "mask")
    return t("presentation.targetMask", {
      container: s.container.toUpperCase(),
    });
  const engine = engines.find((e) => e.id === s.encoder);
  return t("presentation.target", {
    encoder: engine ? engineLabel(engine) : s.encoder,
    bitDepth: localeRuntime.number(s.bitDepth),
    container: s.container.toUpperCase(),
  });
}
