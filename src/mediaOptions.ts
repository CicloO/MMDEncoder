import { localeRuntime, t } from "./i18n";
export const AUDIO_EXT = /\.(wav|flac|mp3|aac|m4a|opus|ogg|mka)$/i;
export const OPERATIONS = (): Record<string, string> => ({
  audio: t("media.operation.audio"),
  video: t("media.operation.video"),
  merge: t("media.operation.merge"),
});
export const FORMATS = (): Record<string, string> => ({
  wav: t("media.format.wav"),
  flac: t("media.format.flac"),
  aac: t("media.format.aac"),
  mp3: t("media.format.mp3"),
  opus: t("media.format.opus"),
  copy: t("media.format.copy"),
});
export const LOSSY = ["aac", "mp3", "opus"];
// 0 follows the source audio bitrate (lossless sources use 320 kbps).
export const BITRATES = [0, 96, 128, 160, 192, 256, 320, 384, 512];
export const MAX_BITRATE: Record<string, number> = {
  aac: 512,
  mp3: 320,
  opus: 512,
};
export const CONTAINERS: Record<string, string> = {
  mp4: "MP4",
  mkv: "MKV",
};
export const LOCATIONS = (): Record<string, string> => ({
  source: t("media.location.source"),
  encoded: t("media.location.encoded"),
  custom: t("media.location.custom"),
});
export const STATUS = (): Record<string, string> => ({
  ready: t("media.status.ready"),
  running: t("media.status.running"),
  done: t("media.status.done"),
  failed: t("media.status.failed"),
  cancelled: t("media.status.cancelled"),
});
export const OPTIONS_KEY = "mmd-media-options";
export type Options = {
  operation: string;
  audioFormat: string;
  audioBitrate: number;
  container: string;
  // 24-bit, and twice the sample rate below 48 kHz (WAV / FLAC only).
  hiRes: boolean;
  // Seconds of fade in / out (0 = off); not with a copied audio track.
  audioFade: number;
  location: string;
  outputDir: string;
};
export const DEFAULT_OPTIONS: Options = {
  operation: "audio",
  audioFormat: "wav",
  audioBitrate: 0,
  container: "mp4",
  hiRes: false,
  audioFade: 0,
  location: "source",
  outputDir: "",
};
export function loadOptions(): Options {
  try {
    const stored = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
    delete stored.autoAlign;
    const options = {
      ...DEFAULT_OPTIONS,
      ...stored,
    };
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      /* Read options still apply when storage cannot be written. */
    }
    return options;
  } catch {
    return DEFAULT_OPTIONS;
  }
}
export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// Hi-Res result for a source, as backend/media.cjs hiResPlan decides it.
export const HIRES_FORMATS = ["wav", "flac"];
export function hiResText(a?: {
  sampleRate: number;
  bits?: number;
  float?: boolean;
}) {
  if (!a?.sampleRate) return "";
  const rate = a.sampleRate < 48000 ? a.sampleRate * 2 : a.sampleRate;
  const depth = a.float
    ? t("media.hiresFloat")
    : a.bits
      ? a.bits + "-bit"
      : t("media.hiresUnknownDepth");
  return t("media.hiresConversion", {
    from: t("media.hiresFrom", {
      rate: localeRuntime.number(a.sampleRate / 1000, { useGrouping: false }),
      depth,
    }),
    to: t("media.hiresTo", {
      rate: localeRuntime.number(rate / 1000, { useGrouping: false }),
    }),
  });
}
