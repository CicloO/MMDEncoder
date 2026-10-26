import { t as text } from "./i18n";
export const OPTIONS_KEY = "mmd-trim-options";
export type Options = {
  audioMode: string;
  audioCodec: string;
  kbps: number;
  audioFile: string;
  offset: string;
  // Seconds of fade in at the start and out at the end of the whole result.
  fade: number;
  mmdFrames: boolean;
  location: string;
  outputDir: string;
};
export const DEFAULT_OPTIONS: Options = {
  audioMode: "reencode",
  audioCodec: "aac",
  kbps: 320,
  audioFile: "",
  offset: "0",
  fade: 0,
  mmdFrames: false,
  location: "source",
  outputDir: "",
};
export const AUDIO_MODES = (): Record<string, string> => ({
  reencode: text("trim.audioMode.reencode"),
  replace: text("trim.audioMode.replace"),
  none: text("trim.audioMode.none"),
});
export const AUDIO_CODECS = (): Record<string, string> => ({
  aac: text("trim.codec.aac"),
  flac: text("trim.codec.flac"),
  pcm: text("trim.codec.pcm"),
});
export const LOCATIONS = (): Record<string, string> => ({
  source: text("trim.location.source"),
  encoded: text("trim.location.encoded"),
  custom: text("trim.location.custom"),
});
// Choices are remembered between sessions, but not a replacement audio
// file or its offset: they belong to the clips of that session.
export function loadOptions(): Options {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
    delete saved.audioFile;
    delete saved.offset;
    if (saved.audioMode === "replace") delete saved.audioMode;
    return { ...DEFAULT_OPTIONS, ...saved };
  } catch {
    return DEFAULT_OPTIONS;
  }
}
