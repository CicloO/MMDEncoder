export function formatFPS(value?: number | string) {
  if (value === undefined || value === null || value === "") return "未知";
  const p = String(value).split("/").map(Number);
  const n = p.length === 2 ? p[0] / p[1] : p[0];
  return Number.isFinite(n) && n > 0
    ? String(Number(n.toFixed(3)).toFixed(2)).replace(/\.00$/, "")
    : "未知";
}
export function formatDuration(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return "未知";
  const s = Math.floor(n);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
export function formatSize(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return "未知";
  if (n === 0) return "0 B";
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${["B", "KB", "MB", "GB"][i]}`;
}
export function compatibilityErrors(s: {
  container: string;
  encoder: string;
  audio: string;
  bitDepth: number;
}) {
  const errors: string[] = [];
  if (s.container === "webm") {
    if (!/vp9|av1/.test(s.encoder))
      errors.push("WebM 需要 VP9 或 AV1 视频编码。");
    if (!["libopus", "none"].includes(s.audio))
      errors.push("WebM 音频请选择 Opus 或不保留音频。");
  }
  if (s.container === "mp4" && ["flac", "pcm_s16le"].includes(s.audio))
    errors.push("兼容性优先：此音频请选择 MKV / MOV，或改为 AAC。");
  if (s.encoder === "prores_ks" && !["mov", "mkv"].includes(s.container))
    errors.push("ProRes 请选择 MOV 或 MKV。");
  return errors;
}
export const statusLabels: Record<string, string> = {
  probing: "读取中",
  ready: "等待压制",
  invalid: "需调整",
  encoding: "压制中",
  done: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};
// Audio fade-in / fade-out lengths, the same on every page (seconds).
export const fadeOptions = [
  { value: "0", label: "关闭" },
  { value: "0.5", label: "0.5 秒" },
  { value: "1", label: "1 秒" },
  { value: "2", label: "2 秒" },
];
export const fadeHint =
  "开头淡入、结尾淡出，从歌曲中间开始或结束的片段不会突然出声或戛然而止。";
export const audioLabels: Record<string, string> = {
  aac: "AAC",
  flac: "FLAC",
  pcm_s16le: "WAV / PCM 16-bit",
  libopus: "Opus",
  none: "不保留音频",
};
