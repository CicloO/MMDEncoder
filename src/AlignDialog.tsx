import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, FolderOpen, Minus, Pause, Play, Plus } from "lucide-react";
import { Button, Modal } from "./components";
import { AlignmentIcon } from "./AlignmentIcon";
import {
  effectiveAudioOffset,
  parseFrameRate,
  type ReferenceTiming,
} from "../backend/audio-timing.mjs";
import { formatFPS } from "./presentation";
import { draw, envelope } from "./alignWave";
import { useAlignPlayer } from "./useAlignPlayer";
import {
  useAlignSession,
  type Alignment,
  type AlignBusy,
} from "./useAlignSession";
import { t, localeRuntime, errorMessage, type MessageKey } from "./i18n";
export type { Alignment } from "./useAlignSession";

// Nudge steps (seconds): an MMD frame, 10 ms, 1 ms, one sample at 48 kHz.
const steps = (frameSeconds: number, actual: boolean) => [
  {
    value: "frame",
    label: actual
      ? t("align.stepReferenceFrame", {
          seconds: localeRuntime.number(frameSeconds, {
            maximumFractionDigits: 6,
          }),
        })
      : t("align.stepFrame"),
  },
  { value: "0.01", label: t("align.step10ms") },
  { value: "0.001", label: t("align.step1ms") },
  { value: String(1 / 48000), label: t("align.stepSample") },
];
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const decimal = (value: number, digits: number) =>
  localeRuntime.number(value, {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const seconds = (value: number) =>
  t("align.clock", {
    sign: value < 0 ? "-" : "",
    minutes: localeRuntime.number(Math.floor(Math.abs(value) / 60), {
      useGrouping: false,
    }),
    seconds: localeRuntime.number(Math.abs(value) % 60, {
      useGrouping: false,
      minimumIntegerDigits: 2,
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    }),
  });
const busyKeys: Record<Exclude<AlignBusy, "">, MessageKey> = {
  loading: "align.loading",
  reference: "align.readingReference",
  aligning: "align.aligning",
  saving: "align.saving",
};

// 音频对齐: line a file's audio (the target) up with a reference, for
// extracting it cut or padded to match (see media.command, alignFilter).
// The result: the reference used, the offset (target time = reference time
// + offset) and, where offered (withTrim), whether to end with the reference.
export function AlignDialog({
  open,
  targetPath,
  fixedReference,
  initial,
  withTrim = false,
  frameShift = false,
  fixedTiming,
  description,
  call,
  onApply,
  onClear,
  onClose,
}: {
  open: boolean;
  targetPath?: string;
  // The reference when the page decides it (a video's own sound); without
  // it the user adds one.
  fixedReference?: string;
  initial?: Partial<Alignment>;
  withTrim?: boolean;
  frameShift?: boolean;
  fixedTiming?: ReferenceTiming;
  description: string;
  call: (action: string, payload?: unknown) => Promise<any>;
  onApply: (a: Alignment) => Promise<void>;
  // Offered when there is an alignment to remove.
  onClear?: () => Promise<void>;
  onClose: () => void;
}) {
  const [view, setView] = useState({ start: 0, span: 10 }),
    [playhead, setPlayhead] = useState(0),
    [listen, setListen] = useState("both"),
    [split, setSplit] = useState(false),
    [step, setStep] = useState("frame"),
    [dropping, setDropping] = useState(false);
  const refCanvas = useRef<HTMLCanvasElement>(null),
    tgtCanvas = useRef<HTMLCanvasElement>(null);
  const {
    playing,
    play: playFrom,
    stop,
    release,
  } = useAlignPlayer((t) => {
    setPlayhead(t);
    if (t > length) return; // playback ends there
    // Keep the playhead in view.
    setView((v) =>
      t > v.start + v.span ? { ...v, start: t - v.span * 0.1 } : v,
    );
  });
  const {
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
    frameInput,
    setFrameInput,
    referenceInfo,
  } = useAlignSession({
    open,
    targetPath,
    fixedReference,
    initial,
    frameShift,
    fixedTiming,
    stop,
    release,
    fit,
    resetPlayhead: () => setPlayhead(0),
    showRange: setView,
  });
  const frames = Number(frameInput);
  const validFrames = frameInput.trim() !== "" && Number.isSafeInteger(frames);
  const computedShift = frameShift
    ? effectiveAudioOffset(offset, frames, referenceInfo?.fpsText)
    : offset;
  const shift = Number.isFinite(computedShift) ? computedShift : offset;
  const validShift =
    !frameShift ||
    (!!referenceInfo &&
      validFrames &&
      Number.isFinite(computedShift) &&
      Math.abs(computedShift) <= 24 * 3600);
  const frameSeconds = 1 / (parseFrameRate(referenceInfo?.fpsText)?.fps || 30);
  // From the playhead (or `from`), the target shifted by `shift`.
  const play = (from = playhead, atShift = shift) =>
    playFrom({
      from,
      shift: atShift,
      reference,
      target,
      listen,
      split,
      length,
    });
  const refEnv = useMemo(
    () => (reference ? envelope(reference.pcm) : null),
    [reference],
  );
  const tgtEnv = useMemo(
    () => (target ? envelope(target.pcm) : null),
    [target],
  );
  const length = Math.max(
    reference?.duration || referenceInfo?.duration || 0,
    target ? target.duration - shift : 0,
    1,
  );
  // Both recordings from their starts, with a little room so the start
  // lines are not on the edge.
  function fit(
    atShift = shift,
    refDuration = reference?.duration || referenceInfo?.duration || 0,
  ) {
    const lo = Math.min(0, -atShift);
    const hi = Math.max(
      refDuration,
      target ? target.duration - atShift : 0,
      lo + 1,
    );
    const pad = (hi - lo) * 0.02;
    setView({ start: lo - pad, span: hi - lo + 2 * pad });
  }

  async function pickReference() {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await takeReference(file);
  }
  // Redraw on any change; the canvases follow their box on resize.
  useEffect(() => {
    const paint = () => {
      draw(
        refCanvas.current,
        reference,
        refEnv,
        view.start,
        view.span,
        0,
        playhead,
        [{ t: 0, color: "--wave-zero" }],
      );
      draw(
        tgtCanvas.current,
        target,
        tgtEnv,
        view.start,
        view.span,
        shift,
        playhead,
        [
          { t: 0, color: "--wave-zero" },
          { t: -shift, color: "--wave-start" },
        ],
      );
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  });

  // A change while playing is heard at once.
  function setShift(next: number) {
    setOffset(next);
    if (playing)
      play(
        playhead,
        frameShift
          ? effectiveAudioOffset(next, frames, referenceInfo?.fpsText)
          : next,
      );
  }
  function nudge(dir: number, big = false) {
    setShift(
      offset +
        dir * (step === "frame" ? frameSeconds : Number(step)) * (big ? 10 : 1),
    );
  }
  const timeAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return view.start + ((e.clientX - r.left) / r.width) * view.span;
  };
  const pointer = useRef<{
    button: number;
    x: number;
    offset: number;
    start: number;
    moved: boolean;
  } | null>(null);
  function pointerHandlers(kind: "reference" | "target") {
    return {
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pointer.current = {
          button: e.button,
          x: e.clientX,
          offset,
          start: view.start,
          moved: false,
        };
      },
      onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
        const p = pointer.current;
        if (!p) return;
        const dx = e.clientX - p.x;
        if (Math.abs(dx) > 2) p.moved = true;
        if (!p.moved) return;
        const dt =
          (dx / e.currentTarget.getBoundingClientRect().width) * view.span;
        if (p.button === 0 && kind === "target") setOffset(p.offset - dt);
        else setView((v) => ({ ...v, start: p.start - dt }));
      },
      onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
        const p = pointer.current;
        pointer.current = null;
        if (!p) return;
        if (!p.moved && p.button === 0) seek(timeAt(e));
        // A moved target is heard at once from where it now is.
        else if (playing && p.button === 0 && kind === "target") play(playhead);
      },
    };
  }
  // The zoom bar (as in a video editor): the whole of both recordings, the
  // part shown as a window on it. Drag the window to move it, its edges to
  // zoom; a press beside it centres it there.
  const whole = {
    lo: Math.min(0, -shift, view.start),
    hi: Math.max(length, view.start + view.span),
  };
  const share = (x: number) => ((x - whole.lo) / (whole.hi - whole.lo)) * 100;
  const zoomBar = useRef<HTMLDivElement>(null);
  const zoomDrag = useRef<{
    edge: string;
    x: number;
    start: number;
    span: number;
  } | null>(null);
  function zoomDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at =
      whole.lo + ((e.clientX - r.left) / r.width) * (whole.hi - whole.lo);
    const edge = (e.target as HTMLElement).dataset.edge || "move";
    let start = view.start;
    if (edge === "move" && (at < view.start || at > view.start + view.span)) {
      start = at - view.span / 2;
      setView((v) => ({ ...v, start }));
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    zoomDrag.current = { edge, x: e.clientX, start, span: view.span };
  }
  function zoomMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = zoomDrag.current;
    if (!d) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dt = ((e.clientX - d.x) / r.width) * (whole.hi - whole.lo);
    const min = 0.01;
    if (d.edge === "left") {
      const start = Math.min(d.start + dt, d.start + d.span - min);
      setView({ start, span: d.span - (start - d.start) });
    } else if (d.edge === "right")
      setView({ start: d.start, span: Math.max(min, d.span + dt) });
    else setView({ start: d.start + dt, span: d.span });
  }
  function seek(t: number) {
    setPlayhead(t);
    if (playing) play(t);
  }
  function zoom(factor: number, around = view.start + view.span / 2) {
    const span = Math.min(Math.max(0.01, view.span * factor), length * 1.2);
    const start = around - ((around - view.start) * span) / view.span;
    setView({
      start: Math.max(Math.min(0, -shift) - span * 0.1, start),
      span,
    });
  }
  async function apply() {
    if (!refPath) return;
    stop();
    setBusy("saving");
    try {
      await onApply({
        reference: refPath,
        offset,
        trim: withTrim && trim,
        ...(frameShift ? { shiftFrames: frames } : {}),
      });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy("");
    }
  }
  async function clear() {
    if (!onClear) return;
    stop();
    try {
      await onClear();
      onClose();
    } catch (e) {
      setError(e);
    }
  }

  const where =
    Math.abs(shift) < 1 / 96000
      ? t("align.simultaneous")
      : shift > 0
        ? t("align.trimHead", { seconds: decimal(shift, 4) })
        : t("align.padHead", { seconds: decimal(-shift, 4) });
  return (
    <Modal
      open={open}
      onClose={() => {
        stop();
        onClose();
      }}
      wide
      title={t("align.title")}
      description={description}
      error={error ? errorMessage(error) : ""}
    >
      <div
        className={`align-dialog${dropping ? " dropping" : ""}`}
        // Kept here: the page behind would take the file into its queue.
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!fixedReference) setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDropping(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          if (fixedReference || busy) return;
          const [file] = window.encoder.getPaths(
            Array.from(e.dataTransfer.files),
          );
          if (file) void takeReference(file);
        }}
      >
        <div className="align-ref">
          <span className="align-label">{t("align.reference")}</span>
          <span className="path-text" title={refPath}>
            {refPath
              ? fixedReference
                ? t("align.videoReference", { name: baseName(refPath) })
                : baseName(refPath)
              : t("align.emptyReference")}
          </span>
          {!fixedReference && (
            <Button onClick={pickReference} disabled={!!busy}>
              <FolderOpen size={15} />
              {refPath ? t("align.changeReference") : t("align.addReference")}
            </Button>
          )}
          <Button
            onClick={() => run()}
            disabled={
              !refPath ||
              !!busy ||
              !validShift ||
              (frameShift && !referenceInfo?.hasAudio)
            }
          >
            <AlignmentIcon size={15} active={busy === "aligning"} />
            {t("align.auto")}
          </Button>
        </div>
        <p className="align-status" role="status">
          {(busy && t(busyKeys[busy])) ||
            (refPath ? (
              <>
                {where}
                {result &&
                  (result.reliable ? (
                    <span className="align-ok">
                      {t("align.reliable", {
                        confidence: decimal(result.confidence, 1),
                      })}
                    </span>
                  ) : (
                    <span className="align-warn">
                      {t("align.unreliable", {
                        confidence: decimal(result.confidence, 2),
                      })}
                    </span>
                  ))}
              </>
            ) : (
              t("align.emptyHint")
            ))}
        </p>
        {frameShift && referenceInfo && !referenceInfo.hasAudio && (
          <p className="hint">{t("align.noReferenceAudio")}</p>
        )}
        <div className="align-waves">
          <span className="align-label">{t("align.reference")}</span>
          <canvas
            ref={refCanvas}
            className="align-wave reference"
            aria-label={t("align.referenceWave")}
            onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e))}
            {...pointerHandlers("reference")}
          />
          <span className="align-label">{t("align.target")}</span>
          <canvas
            ref={tgtCanvas}
            className="align-wave target"
            tabIndex={0}
            aria-label={t("align.targetWave")}
            onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e))}
            {...pointerHandlers("target")}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                nudge(e.key === "ArrowRight" ? -1 : 1, e.shiftKey);
              } else if (e.key === " ") {
                e.preventDefault();
                if (playing) stop();
                else play();
              }
            }}
          />
          <span />
          <div className="align-ruler">
            <span>{seconds(view.start)}</span>
            <span>{seconds(view.start + view.span)}</span>
          </div>
          <span className="align-label">{t("align.view")}</span>
          {/* Same width as the waveforms: the shown part of the whole. */}
          <div
            ref={zoomBar}
            className="align-zoom"
            role="scrollbar"
            aria-orientation="horizontal"
            aria-label={t("align.viewRange")}
            aria-valuemin={Math.round(whole.lo * 1000)}
            aria-valuemax={Math.round(whole.hi * 1000)}
            aria-valuenow={Math.round(view.start * 1000)}
            tabIndex={0}
            onPointerDown={zoomDown}
            onPointerMove={zoomMove}
            onPointerUp={() => (zoomDrag.current = null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const dir = e.key === "ArrowRight" ? 1 : -1;
                setView((v) => ({
                  ...v,
                  start: v.start + dir * v.span * 0.1,
                }));
              }
            }}
          >
            <div
              className="align-zoom-window"
              style={{
                left: share(view.start) + "%",
                width: share(view.start + view.span) - share(view.start) + "%",
              }}
            >
              <span data-edge="left" className="align-zoom-edge left" />
              <span data-edge="right" className="align-zoom-edge right" />
            </div>
          </div>
        </div>
        <div className="align-controls">
          <div className="align-row">
            <div className="align-group">
              <Button
                variant="primary"
                onClick={() => (playing ? stop() : play())}
                disabled={!target}
                aria-label={playing ? t("align.pause") : t("align.play")}
              >
                {playing ? <Pause size={15} /> : <Play size={15} />}
                {playing ? t("align.pause") : t("align.play")}
              </Button>
              <span className="align-time" title={t("align.playhead")}>
                {seconds(playhead)}
              </span>
            </div>
            <div className="align-group">
              <span className="align-row-label">{t("align.listen")}</span>
              <div
                className="segmented"
                role="radiogroup"
                aria-label={t("align.listen")}
              >
                {[
                  ["reference", t("align.reference")],
                  ["target", t("align.target")],
                  ["both", t("align.both")],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="align-listen"
                      checked={listen === value}
                      disabled={value !== "target" && !reference}
                      onChange={() => {
                        setListen(value);
                        if (playing) setTimeout(() => play(), 0);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={split}
                  onChange={(e) => setSplit(e.target.checked)}
                />
                {t("align.split")}
              </label>
            </div>
          </div>
          <div className="align-row">
            <div className="align-group">
              <span className="align-row-label">{t("align.zoom")}</span>
              <Button
                aria-label={t("align.zoomOut")}
                title={t("align.zoomOut")}
                onClick={() => zoom(1.5)}
              >
                <Minus size={15} />
              </Button>
              <Button
                aria-label={t("align.zoomIn")}
                title={t("align.zoomIn")}
                onClick={() => zoom(1 / 1.5)}
              >
                <Plus size={15} />
              </Button>
              <Button onClick={() => fit()}>
                <AudioLines size={15} />
                {t("align.fit")}
              </Button>
            </div>
            <div className="align-group">
              <label className="align-row-label" htmlFor="align-step">
                {t("align.nudge")}
              </label>
              <select
                id="align-step"
                className="align-step"
                value={step}
                onChange={(e) => setStep(e.target.value)}
              >
                {steps(frameSeconds, frameShift).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button
                aria-label={t("align.left")}
                title={t("align.leftHint")}
                onClick={() => nudge(1)}
              >
                ←
              </Button>
              <Button
                aria-label={t("align.right")}
                title={t("align.rightHint")}
                onClick={() => nudge(-1)}
              >
                →
              </Button>
            </div>
            {frameShift && (
              <div className="align-group">
                <label className="align-row-label" htmlFor="align-audio-shift">
                  {t("align.shiftFrames")}
                </label>
                <input
                  id="align-audio-shift"
                  className="align-shift-input"
                  type="number"
                  step="1"
                  value={frameInput}
                  disabled={!!busy || !referenceInfo}
                  aria-invalid={!validShift && !!referenceInfo}
                  aria-describedby={
                    !validShift && referenceInfo
                      ? "align-audio-shift-hint align-audio-shift-error"
                      : "align-audio-shift-hint"
                  }
                  title={referenceInfo?.fpsText}
                  onChange={(event) => {
                    setFrameInput(event.target.value);
                    if (playing) {
                      const value = effectiveAudioOffset(
                        offset,
                        Number(event.target.value),
                        referenceInfo?.fpsText,
                      );
                      if (Number.isFinite(value)) play(playhead, value);
                      else stop();
                    }
                  }}
                />
              </div>
            )}
          </div>
          {frameShift && (
            <div className="align-shift-feedback">
              <p id="align-audio-shift-hint" className="hint">
                {referenceInfo
                  ? t(
                      referenceInfo.fallback
                        ? "align.shiftAudioFallback"
                        : "align.shiftVideoRate",
                      { fps: formatFPS(referenceInfo.fpsText) },
                    )
                  : t("align.shiftAwaitReference")}
              </p>
              {!validFrames && (
                <p
                  id="align-audio-shift-error"
                  className="inline-error"
                  role="alert"
                >
                  {t("error.ALIGN_SHIFT_FRAMES_INVALID")}
                </p>
              )}
              {validFrames &&
                Number.isFinite(computedShift) &&
                Math.abs(computedShift) > 24 * 3600 && (
                  <p
                    id="align-audio-shift-error"
                    className="inline-error"
                    role="alert"
                  >
                    {t("error.ALIGN_SHIFT_RANGE_INVALID")}
                  </p>
                )}
            </div>
          )}
          {withTrim && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={trim}
                disabled={!refPath}
                onChange={(e) => setTrim(e.target.checked)}
              />
              {t("align.trim")}
            </label>
          )}
          <p className="hint align-hint">{t("align.hint")}</p>
        </div>
        <div className="modal-actions">
          {onClear && (
            <Button onClick={clear} disabled={!!busy}>
              {t("align.clear")}
            </Button>
          )}
          <Button
            onClick={() => {
              stop();
              onClose();
            }}
          >
            {t("align.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={apply}
            disabled={!refPath || !target || !!busy || !validShift}
          >
            {t("align.apply")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
