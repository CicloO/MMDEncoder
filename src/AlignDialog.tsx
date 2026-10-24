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
import type { MediaJob } from "./types";

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
  const px = ((playhead - start) / span) * w;
  if (px >= 0 && px <= w) {
    g.fillStyle = css.getPropertyValue("--wave-head");
    g.fillRect(Math.round(px), 0, Math.max(1, Math.round(dpr)), h);
  }
}

// 音频对齐: line a file's audio (the target) up with a reference, for
// extracting it cut or padded to match (see media.command, alignFilter).
export function AlignDialog({
  open,
  job,
  call,
  onClose,
}: {
  open: boolean;
  job?: MediaJob;
  call: (action: string, payload?: unknown) => Promise<any>;
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
    [step, setStep] = useState(STEPS[0].value);
  const refCanvas = useRef<HTMLCanvasElement>(null),
    tgtCanvas = useRef<HTMLCanvasElement>(null),
    audio = useRef<{
      ctx: AudioContext;
      nodes: AudioScheduledSourceNode[];
      when: number;
      from: number;
      frame: number;
    } | null>(null),
    drag = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
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

  async function load(path: string) {
    const t = (await call("alignPreview", { path })) as Track;
    // The structured clone may arrive as a plain array buffer view.
    return { ...t, pcm: new Int16Array(t.pcm) };
  }
  async function run(ref = refPath) {
    if (!job || !ref) return;
    setBusy("正在自动对齐…");
    setError("");
    try {
      const r = await call("alignRun", { reference: ref, target: job.path });
      setOffset(r.offset);
      setResult({ confidence: r.confidence, reliable: r.reliable });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function pickReference() {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file !== "string") return;
    stop();
    setBusy("正在读取参考音频…");
    setError("");
    try {
      const r = await load(file);
      setReference(r);
      setRefPath(file);
      setView({ start: 0, span: Math.max(1, r.duration) });
      setBusy("");
      await run(file);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }
  // Open: the target's sound, and an earlier alignment of this file.
  useEffect(() => {
    if (!open || !job) return;
    let cancelled = false;
    setTarget(null);
    setReference(null);
    setRefPath(job.align?.reference || "");
    setOffset(job.align?.offset || 0);
    setTrim(job.align ? !!job.align.length : true);
    setResult(null);
    setError("");
    setPlayhead(0);
    setBusy("正在读取音频…");
    (async () => {
      try {
        const t = await load(job.path);
        if (cancelled) return;
        setTarget(t);
        let span = t.duration;
        if (job.align?.reference) {
          const r = await load(job.align.reference);
          if (cancelled) return;
          setReference(r);
          span = r.duration;
        }
        setView({ start: 0, span: Math.max(1, span) });
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
  }, [open, job?.id]);
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
      );
      draw(
        tgtCanvas.current,
        target,
        tgtEnv,
        view.start,
        view.span,
        offset,
        playhead,
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
  function seek(t: number) {
    setPlayhead(t);
    if (playing) play(t);
  }
  function zoom(factor: number, around = view.start + view.span / 2) {
    const span = Math.min(Math.max(0.01, view.span * factor), length * 1.2);
    const start = around - ((around - view.start) * span) / view.span;
    setView({ start: Math.max(-span * 0.1, start), span });
  }
  async function apply() {
    if (!job) return;
    setBusy("正在保存…");
    try {
      await call("mediaSetAlign", {
        id: job.id,
        align: refPath ? { reference: refPath, offset, trim } : null,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function clear() {
    if (!job) return;
    try {
      await call("mediaSetAlign", { id: job.id, align: null });
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
      description={`把“${job?.name || ""}”的音频起点对齐到参考音频；提取音频时按这里的结果截取或补静音。`}
      error={error}
    >
      <div className="align-dialog">
        <div className="align-ref">
          <span className="align-label">参考</span>
          <span className="path-text" title={refPath}>
            {refPath ? baseName(refPath) : "尚未添加（可选音频或视频）"}
          </span>
          <Button onClick={pickReference} disabled={!!busy}>
            <FolderOpen size={15} />
            {refPath ? "更换参考" : "添加参考音频"}
          </Button>
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
            aria-label="参考音频波形，点击设置播放位置"
            onClick={(e) => seek(timeAt(e))}
            onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e))}
          />
          <span className="align-label">目标</span>
          <canvas
            ref={tgtCanvas}
            className="align-wave target"
            tabIndex={0}
            aria-label="目标音频波形：拖动或用左右方向键调整对齐，按住 Shift 步长乘 10"
            onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e))}
            onMouseDown={(e) =>
              (drag.current = { x: e.clientX, offset, moved: false })
            }
            onMouseMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              if (Math.abs(dx) > 2) d.moved = true;
              if (d.moved)
                setOffset(
                  d.offset -
                    (dx / e.currentTarget.getBoundingClientRect().width) *
                      view.span,
                );
            }}
            onMouseUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (!d?.moved) seek(timeAt(e));
              else if (playing) play(playhead);
            }}
            onMouseLeave={() => (drag.current = null)}
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
            <span>播放位置 {seconds(playhead)}</span>
            <span>{seconds(view.start + view.span)}</span>
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
            <Button
              onClick={() => setView({ start: 0, span: Math.max(1, length) })}
            >
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
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={trim}
              disabled={!refPath}
              onChange={(e) => setTrim(e.target.checked)}
            />
            导出时截到参考的长度（不够时补静音）
          </label>
        </div>
        <div className="modal-actions">
          {job?.align && (
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
