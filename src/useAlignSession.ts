import { useEffect, useRef, useState } from "react";
import type { Track } from "./alignWave";
import { ask, isCancelled } from "./alignRequests";
import {
  effectiveAudioOffset,
  type ReferenceTiming,
} from "../backend/audio-timing.mjs";

export type Alignment = {
  reference: string;
  offset: number;
  trim: boolean;
  shiftFrames?: number;
};
export type AlignBusy = "" | "loading" | "reference" | "aligning" | "saving";
// The dialog's requests: one of each at a time; a newer one, or closing,
// stops the older (align-service.cjs), which then fails with "已取消".
const SLOTS = {
  target: "align:target",
  reference: "align:reference",
  run: "align:run",
  info: "align:info",
};

// Owns decoded tracks, alignment values and request lifecycle. The dialog
// supplies playback cleanup and view callbacks; no canvas or page state enters.
export function useAlignSession({
  open,
  targetPath,
  fixedReference,
  initial,
  frameShift = false,
  autoAlign = true,
  fixedTiming,
  stop,
  release,
  fit,
  resetPlayhead,
  showRange,
}: {
  open: boolean;
  targetPath?: string;
  fixedReference?: string;
  initial?: Partial<Alignment>;
  frameShift?: boolean;
  autoAlign?: boolean;
  fixedTiming?: ReferenceTiming;
  stop: () => void;
  release: () => void;
  fit: (shift: number, refDuration: number) => void;
  resetPlayhead: () => void;
  showRange: (range: { start: number; span: number }) => void;
}) {
  const [target, setTarget] = useState<Track | null>(null),
    [reference, setReference] = useState<Track | null>(null),
    [refPath, setRefPath] = useState(""),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<{
      confidence: number;
      reliable: boolean;
    } | null>(null),
    [busy, setBusy] = useState<AlignBusy>(""),
    [error, setError] = useState<unknown>(null),
    [trim, setTrim] = useState(true),
    [frameInput, setFrameInput] = useState("0"),
    [referenceInfo, setReferenceInfo] = useState<ReferenceTiming | null>(null);
  const generation = useRef(0);

  async function load(path: string, slot: string) {
    const t = (await ask("alignPreview", { path, slot })) as Track;
    // Used as it arrives; copied only if it came as another kind of view.
    return t.pcm instanceof Int16Array
      ? t
      : { ...t, pcm: new Int16Array(t.pcm) };
  }
  async function run(
    ref = refPath,
    refDuration = reference?.duration || referenceInfo?.duration || 0,
    timing = referenceInfo,
    frames = Number(frameInput),
  ) {
    if (!targetPath || !ref) return;
    if (frameShift && timing && !timing.hasAudio) return;
    const request = generation.current;
    setBusy("aligning");
    setError(null);
    try {
      const r = await ask("alignRun", {
        reference: ref,
        target: targetPath,
        slot: SLOTS.run,
      });
      if (request !== generation.current) return;
      setOffset(r.offset);
      const effective = frameShift
        ? effectiveAudioOffset(r.offset, frames, timing?.fpsText)
        : r.offset;
      fit(Number.isFinite(effective) ? effective : r.offset, refDuration);
      setResult({ confidence: r.confidence, reliable: r.reliable });
    } catch (e) {
      if (request === generation.current && !isCancelled(e)) setError(e);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }
  async function takeReference(file: string) {
    stop();
    setBusy("reference");
    setError(null);
    const request = generation.current;
    try {
      const timing = frameShift
        ? ((await ask("alignReferenceInfo", {
            path: file,
            slot: SLOTS.info,
          })) as ReferenceTiming)
        : null;
      if (request !== generation.current) return;
      const r =
        !timing || timing.hasAudio ? await load(file, SLOTS.reference) : null;
      if (request !== generation.current) return;
      setReferenceInfo(timing);
      setReference(r);
      setRefPath(file);
      if (frameShift) {
        setOffset(0);
        setFrameInput("0");
        setResult(null);
      }
      fit(frameShift ? 0 : offset, timing?.duration || r?.duration || 0);
      setBusy("");
      if (autoAlign)
        await run(
          file,
          timing?.duration || r?.duration || 0,
          timing,
          frameShift ? 0 : Number(frameInput),
        );
    } catch (e) {
      if (request === generation.current) {
        if (!isCancelled(e)) setError(e);
        setBusy("");
      }
    }
  }
  // Restore tracks and the saved offset. A fixed video reference never starts
  // matching merely because the window opened; explicit matching stays available.
  useEffect(() => {
    if (!open || !targetPath) return;
    const request = ++generation.current;
    let cancelled = false;
    const ref = fixedReference || initial?.reference || "";
    setTarget(null);
    setReference(null);
    setRefPath(ref);
    setOffset(initial?.offset || 0);
    setFrameInput(String(initial?.shiftFrames || 0));
    setReferenceInfo(null);
    setTrim(initial?.trim ?? true);
    setResult(null);
    setError(null);
    resetPlayhead();
    setBusy("loading");
    (async () => {
      try {
        const t = await load(targetPath, SLOTS.target);
        if (cancelled) return;
        setTarget(t);
        let span = t.duration;
        let timing: ReferenceTiming | null = null;
        if (ref) {
          if (frameShift)
            timing =
              fixedTiming ||
              ((await ask("alignReferenceInfo", {
                path: ref,
                slot: SLOTS.info,
              })) as ReferenceTiming);
          if (cancelled) return;
          setReferenceInfo(timing);
          const r =
            !timing || timing.hasAudio
              ? await load(ref, SLOTS.reference)
              : null;
          if (cancelled) return;
          setReference(r);
          span = timing?.duration || r?.duration || t.duration;
        }
        const effective = frameShift
          ? effectiveAudioOffset(
              initial?.offset || 0,
              initial?.shiftFrames || 0,
              timing?.fpsText,
            )
          : initial?.offset || 0;
        const lo = Math.min(0, -(Number.isFinite(effective) ? effective : 0));
        const pad = (span - lo) * 0.02;
        showRange({ start: lo - pad, span: Math.max(1, span - lo + 2 * pad) });
        if (
          ref &&
          !fixedReference &&
          autoAlign &&
          initial?.offset === undefined
        ) {
          setBusy("");
          await run(ref, span, timing, initial?.shiftFrames || 0);
        }
      } catch (e) {
        if (!cancelled && !isCancelled(e)) setError(e);
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    // Closed (or opened on another file): stop what is still being read or
    // aligned, and let go of the sound.
    return () => {
      cancelled = true;
      if (generation.current === request) generation.current++;
      release();
      void ask("alignCancel", { slots: Object.values(SLOTS) }).catch(() => {});
      setTarget(null);
      setReference(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPath, fixedReference, frameShift, fixedTiming?.fpsText]);

  return {
    target,
    reference,
    refPath,
    offset,
    setOffset,
    result,
    busy,
    setBusy,
    error,
    setError,
    trim,
    setTrim,
    frameInput,
    setFrameInput,
    referenceInfo,
    run,
    takeReference,
  };
}
