import { localeRuntime } from "./i18n";
import type { TrimClip } from "./types";
import { effectiveAudioOffset } from "../backend/audio-timing.mjs";

// Frame <-> time on a clip's rational frame rate.
export const seconds = (c: TrimClip, frame: number) =>
  c.fps ? (frame * c.fps.den) / c.fps.num : 0;

// The waveform uses the whole source. Apply the first exported clip's
// start once, after its independent actual-frame audio shift.
export const replacementOffset = (
  clip: TrimClip,
  waveOffset: number,
  shiftFrames: number,
) =>
  seconds(clip, clip.from ?? 0) +
  effectiveAudioOffset(
    waveOffset,
    shiftFrames,
    clip.fps && `${clip.fps.num}/${clip.fps.den}`,
  );
export function clock(sec: number) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  const n = (v: number, width: number) =>
    localeRuntime
      .number(v === 0 ? 0 : v, { useGrouping: false, maximumFractionDigits: 0 })
      .padStart(width, "0");
  return `${n(h, 2)}:${n(m, 2)}:${n(s, 2)}.${n(ms % 1000, 3)}`;
}
// "1234" is a frame number (or an MMD frame on the 30 fps timeline when
// mmd is on); "1:02.5" / "00:01:02.500" is a time. Returns a video frame.
export function parsePosition(text: string, c: TrimClip, mmd: boolean) {
  const t = text.trim();
  if (!t || !c.fps) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return mmd
      ? Math.round(((n - (c.mmdStart ?? 0)) * c.fps.num) / (c.fps.den * 30))
      : n;
  }
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p)) || parts.length > 3) return null;
  const sec = parts.reduce((a, p) => a * 60 + p, 0);
  return Math.round((sec * c.fps.num) / c.fps.den);
}
// The MMD frame a video frame shows: the clip's MMD start plus 30 fps time.
export const mmdFrame = (c: TrimClip, frame: number) =>
  (c.mmdStart ?? 0) +
  (c.fps ? Math.round((frame * c.fps.den * 30) / c.fps.num) : frame);
