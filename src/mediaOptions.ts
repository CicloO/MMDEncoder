export const AUDIO_EXT = /\.(wav|flac|mp3|aac|m4a|opus|ogg|mka)$/i;
export const OPERATIONS: Record<string, string> = {
  audio: "提取音频",
  video: "提取无音频视频",
  merge: "视频与独立音频合并",
};
export const FORMATS: Record<string, string> = {
  wav: "WAV · PCM 16-bit 无损",
  flac: "FLAC · 无损",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  copy: "直接复制原音频 · 不重新编码",
};
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
export const LOCATIONS: Record<string, string> = {
  source: "与源文件同目录",
  encoded: "源目录下的 Encoded 子文件夹",
  custom: "自定义文件夹",
};
export const STATUS: Record<string, string> = {
  ready: "等待处理",
  running: "处理中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
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
  // Merging: line the added audio up with the video's sound once chosen.
  autoAlign: boolean;
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
  autoAlign: true,
  location: "source",
  outputDir: "",
};
export function loadOptions(): Options {
  try {
    return {
      ...DEFAULT_OPTIONS,
      ...JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}"),
    };
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
  const depth = a.float ? "浮点" : a.bits ? a.bits + "-bit" : "位深未知";
  return `${a.sampleRate / 1000} kHz / ${depth} → ${rate / 1000} kHz / 24-bit`;
}
