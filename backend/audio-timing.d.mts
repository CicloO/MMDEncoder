export type ReferenceTiming = {
  fpsText: string;
  fallback: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  duration: number;
};
export function parseFrameRate(
  value: unknown,
): { numerator: number; denominator: number; fps: number } | null;
export function effectiveAudioOffset(
  offset: number,
  shiftFrames: number,
  fpsText: unknown,
): number;
export function referenceTiming(data: {
  streams?: any[];
  format?: any;
}): ReferenceTiming;
