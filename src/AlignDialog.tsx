import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  FolderOpen,
  Minus,
  Pause,
  Play,
  Plus,
  Wand2,
} from "lucide-react";
import { Button, Modal, Select } from "./components";

// Sound of a file as the backend sends it (alignPreview): mono 16-bit.
type Track = { rate: number; duration: number; pcm: Int16Array };
// Min / max of every BLOCK samples, so a long view draws without reading
// every sample.
const BLOCK = 64;
type Envelope = { min: Int16Array; max: Int16Array };
function envelope(pcm: Int16Array): Envelope {
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
// Nudge steps (seconds): an MMD frame, 10 ms, 1 ms, one sample at 48 kHz.
const STEPS = [
  { value: String(1 / 30), label: "1 帧（1/30 秒）" },
  { value: "0.01", label: "10 毫秒" },
  { value: "0.001", label: "1 毫秒" },
  { value: String(1 / 48000), label: "1 个采样" },
];
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const seconds = (t: number) =>
  `${t < 0 ? "-" : ""}${Math.floor(Math.abs(t) / 60)}:${(Math.abs(t) % 60).toFixed(3).padStart(6, "0")}`;

// Draws one track over the view [start, start + span] of the reference's
// time; the target's sound at reference time t is its own time t + shift.
function draw(
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

// 音频对齐: line a file's audio (the target) up with a reference, for
// extracting it cut or padded to match (see media.command, alignFilter).
// The result: the reference used, the offset (target time = reference time
// + offset) and, where offered (withTrim), whether to end with the reference.
export type Alignment = { reference: string; offset: number; trim: boolean };
export function AlignDialog({
  open,
  targetPath,
  fixedReference,
  initial,
  withTrim = false,
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
  description: string;
  call: (action: string, payload?: unknown) => Promise<any>;
  onApply: (a: Alignment) => Promise<void>;
  // Offered when there is an alignment to remove.
  onClear?: () => Promise<void>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<Track | null>(null),
    [reference, setReference] = useState<Track | null>(null),
    [refPath, setRefPath] = useState(""),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<{
      confidence: number;
      reliable: boolean;
    } | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [trim, setTrim] = useState(true),
    [view, setView] = useState({ start: 0, span: 10 }),
    [playhead, setPlayhead] = useState(0),
    [playing, setPlaying] = useState(false),
    [listen, setListen] = useState("both"),
    [split, setSplit] = useState(false),
    [step, setStep] = useState(STEPS[0].value),
    [dropping, setDropping] = useState(false);
  const refCanvas = useRef<HTMLCanvasElement>(null),
    tgtCanvas = useRef<HTMLCanvasElement>(null),
    audio = useRef<{
      ctx: AudioContext;
      nodes: AudioScheduledSourceNode[];
      when: number;
      from: number;
      frame: number;
    } | null>(null);
  const refEnv = useMemo(
    () => (reference ? envelope(reference.pcm) : null),
    [reference],
  );
  const tgtEnv = useMemo(
    () => (target ? envelope(target.pcm) : null),
    [target],
  );
  const length = Math.max(
    reference?.duration || 0,
    target ? target.duration - offset : 0,
    1,
  );
  // Both recordings from their starts, with a little room so the start
  // lines are not on the edge.
  function fit(shift = offset, refDuration = reference?.duration || 0) {
    const lo = Math.min(0, -shift);
    const hi = Math.max(
      refDuration,
      target ? target.duration - shift : 0,
      lo + 1,
    );
    const pad = (hi - lo) * 0.02;
    setView({ start: lo - pad, span: hi - lo + 2 * pad });
  }

  async function load(path: string) {
    const t = (await call("alignPreview", { path })) as Track;
    // The structured clone may arrive as a plain array buffer view.
    return { ...t, pcm: new Int16Array(t.pcm) };
  }
  async function run(ref = refPath, refDuration = reference?.duration || 0) {
    if (!targetPath || !ref) return;
    setBusy("正在自动对齐…");
    setError("");
    try {
      const r = await call("alignRun", { reference: ref, target: targetPath });
      setOffset(r.offset);
      fit(r.offset, refDuration);
      setResult({ confidence: r.confidence, reliable: r.reliable });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function pickReference() {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await takeReference(file);
  }
  async function takeReference(file: string) {
    stop();
    setBusy("正在读取参考音频…");
    setError("");
    try {
      const r = await load(file);
      setReference(r);
      setRefPath(file);
      fit(offset, r.duration);
      setBusy("");
      await run(file, r.duration);
    } catch (e) {
      setError((e as Error).message);
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
    setError("");
    setPlayhead(0);
    setBusy("正在读取音频…");
    (async () => {
      try {
        const t = await load(targetPath);
        if (cancelled) return;
        setTarget(t);
        let span = t.duration;
        if (ref) {
          const r = await load(ref);
          if (cancelled) return;
          setReference(r);
          span = r.duration;
        }
        const lo = Math.min(0, -(initial?.offset || 0));
        const pad = (span - lo) * 0.02;
        setView({ start: lo - pad, span: Math.max(1, span - lo + 2 * pad) });
        if (ref && initial?.offset === undefined) {
          setBusy("");
          await run(ref, span);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPath, fixedReference]);
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
        offset,
        playhead,
        [
          { t: 0, color: "--wave-zero" },
          { t: -offset, color: "--wave-start" },
        ],
      );
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  });

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
  function play(from = playhead, shift = offset) {
    stop();
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
      setPlayhead(t);
      if (t > length) return stop();
      // Keep the playhead in view.
      setView((v) =>
        t > v.start + v.span ? { ...v, start: t - v.span * 0.1 } : v,
      );
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
  // A change while playing is heard at once.
  function setShift(next: number) {
    setOffset(next);
    if (playing) play(playhead, next);
  }
  function nudge(dir: number, big = false) {
    setShift(offset + dir * Number(step) * (big ? 10 : 1));
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
    lo: Math.min(0, -offset, view.start),
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
      start: Math.max(Math.min(0, -offset) - span * 0.1, start),
      span,
    });
  }
  async function apply() {
    if (!refPath) return;
    stop();
    setBusy("正在保存…");
    try {
      await onApply({ reference: refPath, offset, trim: withTrim && trim });
      onClose();
    } catch (e) {
      setError((e as Error).message);
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
      setError((e as Error).message);
    }
  }

  const where =
    Math.abs(offset) < 1 / 96000
      ? "目标与参考同时开始"
      : offset > 0
        ? `目标开头多出 ${offset.toFixed(4)} 秒，导出时截掉`
        : `目标晚 ${(-offset).toFixed(4)} 秒开始，导出时在前面补静音`;
  return (
    <Modal
      open={open}
      onClose={() => {
        stop();
        onClose();
      }}
      wide
      title="音频对齐"
      description={description}
      error={error}
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
          <span className="align-label">参考</span>
          <span className="path-text" title={refPath}>
            {refPath
              ? baseName(refPath) + (fixedReference ? "（视频自带的声音）" : "")
              : "尚未添加：选择或拖入音频 / 视频"}
          </span>
          {!fixedReference && (
            <Button onClick={pickReference} disabled={!!busy}>
              <FolderOpen size={15} />
              {refPath ? "更换参考" : "添加参考音频"}
            </Button>
          )}
          <Button onClick={() => run()} disabled={!refPath || !!busy}>
            <Wand2 size={15} />
            自动对齐
          </Button>
        </div>
        <p className="align-status" role="status">
          {busy ||
            (refPath ? (
              <>
                {where}
                {result &&
                  (result.reliable ? (
                    <span className="align-ok">
                      {" "}
                      · 匹配可信（{result.confidence.toFixed(1)}）
                    </span>
                  ) : (
                    <span className="align-warn">
                      {" "}
                      · 可信度低（{result.confidence.toFixed(2)}
                      ），两段可能不是同一版本，请试听确认
                    </span>
                  ))}
              </>
            ) : (
              "添加参考音频后会自动对齐，也可以拖动下方的目标波形手动对齐。"
            ))}
        </p>
        <div className="align-waves">
          <span className="align-label">参考</span>
          <canvas
            ref={refCanvas}
            className="align-wave reference"
            aria-label="参考音频波形：左键拖动平移，右键拖动移动播放位置，滚轮缩放"
            onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e))}
            {...pointerHandlers("reference")}
          />
          <span className="align-label">目标</span>
          <canvas
            ref={tgtCanvas}
            className="align-wave target"
            tabIndex={0}
            aria-label="目标音频波形：左键拖动或用左右方向键调整对齐（按住 Shift 步长乘 10），右键拖动移动播放位置"
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
            <span>
              虚线：起点（灰为参考 0 秒，蓝为目标开头）· 左键点击：播放位置 ·
              左键拖动目标：对齐 · 右键拖动：平移 · 滚轮：缩放
            </span>
            <span>{seconds(view.start + view.span)}</span>
          </div>
          <span className="align-label">视图</span>
          <div className="align-seek">
            <div
              ref={zoomBar}
              className="align-zoom"
              role="scrollbar"
              aria-orientation="horizontal"
              aria-label="视图范围：拖动中间平移，拖动两端缩放；方向键平移"
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
                  width:
                    share(view.start + view.span) - share(view.start) + "%",
                }}
              >
                <span data-edge="left" className="align-zoom-edge left" />
                <span data-edge="right" className="align-zoom-edge right" />
              </div>
              <div
                className="align-zoom-head"
                style={{
                  left:
                    share(Math.min(Math.max(playhead, whole.lo), whole.hi)) +
                    "%",
                }}
              />
            </div>
            <span title="播放位置">{seconds(playhead)}</span>
          </div>
        </div>
        <div className="align-controls">
          <div className="align-group">
            <Button
              variant="primary"
              onClick={() => (playing ? stop() : play())}
              disabled={!target}
              aria-label={playing ? "暂停" : "播放"}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
              {playing ? "暂停" : "播放"}
            </Button>
            <div className="segmented" role="radiogroup" aria-label="试听">
              {[
                ["reference", "参考"],
                ["target", "目标"],
                ["both", "叠听"],
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
              左右分声道（左参考、右目标）
            </label>
          </div>
          <div className="align-group">
            <Button aria-label="缩小" title="缩小" onClick={() => zoom(1.5)}>
              <Minus size={15} />
            </Button>
            <Button
              aria-label="放大"
              title="放大"
              onClick={() => zoom(1 / 1.5)}
            >
              <Plus size={15} />
            </Button>
            <Button onClick={() => fit()}>
              <AudioLines size={15} />
              全部
            </Button>
            <Select
              id="align-step"
              label="微调步长"
              value={step}
              options={STEPS}
              onChange={setStep}
            />
            <Button
              aria-label="目标左移"
              title="目标左移（←，按住 Shift 乘 10）"
              onClick={() => nudge(1)}
            >
              ←
            </Button>
            <Button
              aria-label="目标右移"
              title="目标右移（→，按住 Shift 乘 10）"
              onClick={() => nudge(-1)}
            >
              →
            </Button>
          </div>
          {withTrim && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={trim}
                disabled={!refPath}
                onChange={(e) => setTrim(e.target.checked)}
              />
              导出时截到参考的长度（不够时补静音）
            </label>
          )}
        </div>
        <div className="modal-actions">
          {onClear && (
            <Button onClick={clear} disabled={!!busy}>
              清除对齐
            </Button>
          )}
          <Button
            onClick={() => {
              stop();
              onClose();
            }}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={apply}
            disabled={!refPath || !target || !!busy}
          >
            应用
          </Button>
        </div>
      </div>
    </Modal>
  );
}
