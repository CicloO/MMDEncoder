import { useRef, useState } from "react";
import type { Track } from "./alignWave";

// What play() needs from the dialog.
type PlayOptions = {
  from: number;
  shift: number;
  reference: Track | null;
  target: Track | null;
  listen: string;
  split: boolean;
  length: number;
};
// The align dialog's playback: both tracks through Web Audio, the target
// shifted; onTime(t) follows the playhead (reference time).
export function useAlignPlayer(onTime: (t: number) => void) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<{
    ctx: AudioContext;
    nodes: AudioScheduledSourceNode[];
    when: number;
    from: number;
    frame: number;
  } | null>(null);
  function stop() {
    const a = audio.current;
    if (!a) return;
    cancelAnimationFrame(a.frame);
    for (const n of a.nodes)
      try {
        n.stop();
      } catch {
        /* not started */
      }
    a.nodes = [];
    setPlaying(false);
  }
  function buffer(ctx: AudioContext, t: Track) {
    const b = ctx.createBuffer(1, t.pcm.length, t.rate);
    const d = b.getChannelData(0);
    for (let i = 0; i < t.pcm.length; i++) d[i] = t.pcm[i] / 32768;
    return b;
  }
  const buffers = useRef(new Map<Track, AudioBuffer>());
  function play({
    from,
    shift,
    reference,
    target,
    listen,
    split,
    length,
  }: PlayOptions) {
    stop();
    // Sound of tracks no longer shown (a reference replaced) is let go.
    for (const t of buffers.current.keys())
      if (t !== reference && t !== target) buffers.current.delete(t);
    const ctx = audio.current?.ctx || new AudioContext();
    const when = ctx.currentTime + 0.05;
    const nodes: AudioScheduledSourceNode[] = [];
    const start = (t: Track | null, at: number, pan: number) => {
      if (!t) return;
      let b = buffers.current.get(t);
      if (!b) buffers.current.set(t, (b = buffer(ctx, t)));
      if (at >= t.duration) return;
      const src = ctx.createBufferSource();
      src.buffer = b;
      const panner = ctx.createStereoPanner();
      panner.pan.value = split ? pan : 0;
      src.connect(panner).connect(ctx.destination);
      // Before the track begins (target padded): start it that much later.
      if (at < 0) src.start(when - at, 0);
      else src.start(when, at);
      nodes.push(src);
    };
    if (listen !== "target") start(reference, from, -1);
    if (listen !== "reference") start(target, from + shift, 1);
    const tick = () => {
      const a = audio.current!;
      const t = a.from + (ctx.currentTime - a.when);
      onTime(t);
      if (t > length) return stop();
      a.frame = requestAnimationFrame(tick);
    };
    audio.current = {
      ctx,
      nodes,
      when,
      from,
      frame: requestAnimationFrame(tick),
    };
    setPlaying(true);
  }
  // The dialog closed: stop, and free the decoded sound (two 20-minute
  // tracks are about 230 MB as audio buffers) and the audio device.
  function release() {
    stop();
    buffers.current.clear();
    void audio.current?.ctx.close().catch(() => {});
    audio.current = null;
  }
  return { playing, play, stop, release };
}
