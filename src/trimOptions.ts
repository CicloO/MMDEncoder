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
export const AUDIO_MODES: Record<string, string> = {
  reencode: "保留原音频（重新编码，精确到采样点）",
  replace: "替换为外部音频",
  none: "无音频",
};
export const AUDIO_CODECS: Record<string, string> = {
  aac: "AAC",
  flac: "FLAC · 无损",
  pcm: "PCM 16-bit · 无损（MOV / MKV）",
};
export const LOCATIONS: Record<string, string> = {
  source: "与第一个片段同目录",
  encoded: "其目录下的 Encoded 子文件夹",
  custom: "自定义文件夹",
};
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
