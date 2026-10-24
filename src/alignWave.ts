// The align dialog's waveforms: a track's sound and how it is drawn.
// Sound of a file as the backend sends it (alignPreview): mono 16-bit.
export type Track = { rate: number; duration: number; pcm: Int16Array };
// Min / max of every BLOCK samples, so a long view draws without reading
// every sample.
export const BLOCK = 64;
export type Envelope = { min: Int16Array; max: Int16Array };
export function envelope(pcm: Int16Array): Envelope {
  const n = Math.ceil(pcm.length / BLOCK);
  const min = new Int16Array(n),
    max = new Int16Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 32767,
      hi = -32768;
    const end = Math.min(pcm.length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) {
      const v = pcm[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}
// Draws one track over the view [start, start + span] of the reference's
// time; the target's sound at reference time t is its own time t + shift.
export function draw(
  canvas: HTMLCanvasElement | null,
  track: Track | null,
  env: Envelope | null,
  start: number,
  span: number,
  shift: number,
  playhead: number,
  // Where each recording starts (reference time): dashed lines.
  starts: { t: number; color: string }[],
) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)),
    h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext("2d")!;
  const css = getComputedStyle(canvas);
  g.clearRect(0, 0, w, h);
  g.fillStyle = css.getPropertyValue("--wave-bg") || "transparent";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = css.getPropertyValue("--wave-axis");
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  if (track && env) {
    g.fillStyle = css.getPropertyValue("--wave-fill");
    const perPx = (span * track.rate) / w;
    for (let x = 0; x < w; x++) {
      const t = start + (x / w) * span + shift;
      const a = Math.floor(t * track.rate),
        b = Math.floor(a + Math.max(1, perPx));
      if (b <= 0 || a >= track.pcm.length) continue;
      let lo = 32767,
        hi = -32768;
      if (b - a >= 2 * BLOCK) {
        for (
          let k = Math.max(0, Math.floor(a / BLOCK));
          k < Math.min(env.min.length, Math.ceil(b / BLOCK));
          k++
        ) {
          if (env.min[k] < lo) lo = env.min[k];
          if (env.max[k] > hi) hi = env.max[k];
        }
      } else
        for (let i = Math.max(0, a); i < Math.min(track.pcm.length, b); i++) {
          const v = track.pcm[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi < lo) continue;
      const y0 = h / 2 - (hi / 32768) * (h / 2),
        y1 = h / 2 - (lo / 32768) * (h / 2);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  g.save();
  g.setLineDash([4 * dpr, 4 * dpr]);
  g.lineWidth = Math.max(1, dpr);
  for (const s of starts) {
    const x = Math.round(((s.t - start) / span) * w) + 0.5;
    if (x < 0 || x > w) continue;
    g.strokeStyle = css.getPropertyValue(s.color);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  g.restore();
  const px = ((playhead - start) / span) * w;
  if (px >= 0 && px <= w) {
    g.fillStyle = css.getPropertyValue("--wave-head");
    g.fillRect(Math.round(px), 0, Math.max(1, Math.round(dpr)), h);
  }
}
