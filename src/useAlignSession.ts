import { useEffect, useState } from "react";
import type { Track } from "./alignWave";
import { ask, isCancelled } from "./alignRequests";

export type Alignment = { reference: string; offset: number; trim: boolean };
export type AlignBusy = "" | "loading" | "reference" | "aligning" | "saving";
// The dialog's requests: one of each at a time; a newer one, or closing,
// stops the older (align-service.cjs), which then fails with "已取消".
const SLOTS = {
  target: "align:target",
  reference: "align:reference",
  run: "align:run",
};

// Owns decoded tracks, alignment values and request lifecycle. The dialog
// supplies playback cleanup and view callbacks; no canvas or page state enters.
export function useAlignSession({
  open,
  targetPath,
  fixedReference,
  initial,
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
    [trim, setTrim] = useState(true);

  async function load(path: string, slot: string) {
    const t = (await ask("alignPreview", { path, slot })) as Track;
    // Used as it arrives; copied only if it came as another kind of view.
    return t.pcm instanceof Int16Array
      ? t
      : { ...t, pcm: new Int16Array(t.pcm) };
  }
  async function run(ref = refPath, refDuration = reference?.duration || 0) {
    if (!targetPath || !ref) return;
    setBusy("aligning");
    setError(null);
    try {
      const r = await ask("alignRun", {
        reference: ref,
        target: targetPath,
        slot: SLOTS.run,
      });
      setOffset(r.offset);
      fit(r.offset, refDuration);
      setResult({ confidence: r.confidence, reliable: r.reliable });
    } catch (e) {
      if (!isCancelled(e)) setError(e);
    } finally {
      setBusy("");
    }
  }
  async function takeReference(file: string) {
    stop();
    setBusy("reference");
    setError(null);
    try {
      const r = await load(file, SLOTS.reference);
      setReference(r);
      setRefPath(file);
      fit(offset, r.duration);
      setBusy("");
      await run(file, r.duration);
    } catch (e) {
      if (!isCancelled(e)) setError(e);
      setBusy("");
    }
  }
  // Open: the target's sound, the reference's, and an earlier alignment; a
  // given reference not yet aligned is aligned at once.
  useEffect(() => {
    if (!open || !targetPath) return;
    let cancelled = false;
    const ref = fixedReference || initial?.reference || "";
    setTarget(null);
    setReference(null);
    setRefPath(ref);
    setOffset(initial?.offset || 0);
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
        if (ref) {
          const r = await load(ref, SLOTS.reference);
          if (cancelled) return;
          setReference(r);
          span = r.duration;
        }
        const lo = Math.min(0, -(initial?.offset || 0));
        const pad = (span - lo) * 0.02;
        showRange({ start: lo - pad, span: Math.max(1, span - lo + 2 * pad) });
        if (ref && initial?.offset === undefined) {
          setBusy("");
          await run(ref, span);
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
      release();
      void ask("alignCancel", { slots: Object.values(SLOTS) }).catch(() => {});
      setTarget(null);
      setReference(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPath, fixedReference]);

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
    run,
    takeReference,
  };
}
