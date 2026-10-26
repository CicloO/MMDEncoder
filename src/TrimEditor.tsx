import { useEffect, useRef, useState } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
} from "lucide-react";
import { Button, Field } from "./components";
import { clock, seconds, mmdFrame } from "./trimCoordinates";
import type { TrimClip } from "./types";
import { t as text, localeRuntime, errorMessage } from "./i18n";

// JPEGs are used while native preview loads, or as its format fallback.
function useTrimPreview(
  id: string | undefined,
  frame: number,
  readFrame: (id: string, frame: number) => Promise<string>,
  enabled: boolean,
) {
  const [image, setImage] = useState({ id: "", src: "" });
  const request = useRef(0);
  useEffect(() => {
    const n = ++request.current;
    if (!id || !enabled) return;
    const timer = setTimeout(() => {
      readFrame(id, frame)
        .then((src) => n === request.current && src && setImage({ id, src }))
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, frame, enabled]);
  return image.id === id ? image.src : "";
}

export function TrimEditor({
  ready,
  frame,
  readFrame,
  running,
  smart,
  mmdFrames,
  cuts,
  inText,
  outText,
  onKey,
  onReveal,
  onMmdStart,
  onSeek,
  move,
  jump,
  setRange,
  setInText,
  setOutText,
  applyText,
  pct,
}: {
  ready: TrimClip;
  frame: number;
  readFrame: (id: string, frame: number) => Promise<string>;
  running: boolean;
  smart: boolean;
  mmdFrames: boolean;
  cuts: number[] | null;
  inText: string;
  outText: string;
  onKey: (event: React.KeyboardEvent) => void;
  onReveal: () => unknown;
  onMmdStart: (value: number) => unknown;
  onSeek: (frame: number) => void;
  move: (frame: number) => unknown;
  jump: (direction: 1 | -1) => void;
  setRange: (from: number | string, to: number | string) => unknown;
  setInText: (value: string) => void;
  setOutText: (value: string) => void;
  applyText: (which: "in" | "out") => unknown;
  pct: (frame: number) => string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  type Phase = "loading" | "ready" | "playing" | "unavailable";
  const [playback, setPlayback] = useState<{ id: string; phase: Phase }>({
    id: "",
    phase: "loading",
  });
  const phase = ready.videoStartTime
    ? "unavailable"
    : playback.id === ready.id
      ? playback.phase
      : "loading";
  const native = phase === "ready" || phase === "playing";
  const playing = phase === "playing";
  const loadVideo = phase !== "unavailable";
  const image = useTrimPreview(ready.id, frame, readFrame, !native);
  const latest = useRef({ ready, frame, move });
  latest.current = { ready, frame, move };
  const setPhase = (next: Phase) => setPlayback({ id: ready.id, phase: next });

  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [ready.id, loadVideo]);
  useEffect(() => {
    const element = video.current;
    if (!element || !native || playing) return;
    const time = seconds(ready, frame);
    if (Math.abs(element.currentTime - time) > 0.000001)
      element.currentTime = time;
  }, [ready.id, frame, native, playing]);
  useEffect(() => {
    if (running) video.current?.pause();
  }, [running]);
  useEffect(() => {
    const element = video.current;
    if (!playing || !element) return;
    let timer = 0;
    const tick = () => {
      if (element.paused) return;
      const current = latest.current;
      const clip = current.ready;
      const end = clip.to ?? clip.frames ?? 1;
      const at = Math.floor(
        element.currentTime * (clip.fps!.num / clip.fps!.den) + 0.0001,
      );
      if (at >= end || element.ended) {
        element.pause();
        element.currentTime = seconds(clip, end - 1);
        current.move(end - 1);
        setPhase("ready");
        return;
      }
      const next = Math.min((clip.frames || 1) - 1, Math.max(0, at));
      if (next !== current.frame) current.move(next);
      timer = requestAnimationFrame(tick);
    };
    timer = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(timer);
    // The callback consumes current coordinates without restarting playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ready.id]);
  function edit(action: () => unknown) {
    video.current?.pause();
    action();
  }
  async function togglePlayback() {
    const element = video.current;
    if (!element || !native) return;
    if (playing) return element.pause();
    const start =
      frame >= (ready.to ?? ready.frames ?? 1) ? (ready.from ?? 0) : frame;
    element.currentTime = seconds(ready, start);
    move(start);
    try {
      await element.play();
    } catch {
      if (video.current === element) setPhase("unavailable");
    }
  }
  const n = (v: number | undefined) => localeRuntime.number(v ?? 0);
  return (
    <section
      className="detail-card trim-editor"
      aria-label={text("trim.editor")}
      tabIndex={0}
      onKeyDown={(event) => {
        const target = event.target as HTMLInputElement;
        if (
          !(target.tagName === "INPUT" && target.type !== "range") &&
          [
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
            "i",
            "o",
          ].includes(event.key.toLowerCase())
        )
          video.current?.pause();
        onKey(event);
      }}
    >
      <div className="detail-title">
        <span className="eyebrow">{text("trim.edit")}</span>
        <div className="detail-actions">
          <Button variant="ghost" onClick={onReveal}>
            <FolderOpen size={14} />
            {text("trim.reveal")}
          </Button>
        </div>
      </div>
      <h3 title={ready.path}>{ready.name}</h3>
      <div className="trim-preview">
        {loadVideo && (
          <video
            key={ready.id}
            ref={video}
            src={`mmd-preview://clip/${encodeURIComponent(ready.id)}`}
            preload="metadata"
            playsInline
            hidden={!native}
            aria-label={text("trim.videoPreview")}
            onLoadedData={() => setPhase("ready")}
            onPlay={() => setPhase("playing")}
            onPause={() =>
              setPlayback((current) =>
                current.id === ready.id && current.phase === "playing"
                  ? { ...current, phase: "ready" }
                  : current,
              )
            }
            onEnded={() => {
              const end = Math.max(0, (ready.to ?? ready.frames ?? 1) - 1);
              move(end);
              if (video.current)
                video.current.currentTime = seconds(ready, end);
              setPhase("ready");
            }}
            onError={() => setPhase("unavailable")}
          />
        )}
        {!native &&
          (image ? (
            <img
              src={image}
              alt={text("trim.framePosition", { frame: n(frame) })}
            />
          ) : (
            <LoaderCircle size={22} className="spin" />
          ))}
      </div>
      {phase === "unavailable" && (
        <p className="hint" role="status">
          {text(
            ready.videoStartTime
              ? "trim.previewTimingUnavailable"
              : "trim.previewUnavailable",
          )}
        </p>
      )}
      {mmdFrames && (
        <div className="file-pick mmd-start">
          <span>{text("trim.mmdOriginPrefix")}</span>
          <input
            aria-label={text("trim.mmdOriginLabel")}
            inputMode="numeric"
            key={ready.id + ":" + ready.mmdStart}
            defaultValue={String(ready.mmdStart ?? 0)}
            disabled={running}
            onBlur={(e) =>
              Number(e.target.value) !== (ready.mmdStart ?? 0) &&
              onMmdStart(Number(e.target.value))
            }
            onKeyDown={(e) =>
              e.key === "Enter" && (e.target as HTMLInputElement).blur()
            }
          />
          <span className="hint">
            {text("trim.frameUnit")}
            {ready.mmdStartFrom === "tag"
              ? text("trim.originTag")
              : ready.mmdStartFrom === "name"
                ? text("trim.originName")
                : ready.mmdStartFrom === "manual"
                  ? text("trim.originManual")
                  : text("trim.originUnknown")}
          </span>
        </div>
      )}
      <div className="trim-position">
        <strong>
          {text(mmdFrames ? "trim.framePositionMmd" : "trim.framePosition", {
            frame: n(frame),
            mmd: n(mmdFrame(ready, frame)),
          })}
        </strong>
        <span>{clock(seconds(ready, frame))}</span>
        {(ready.cuts === "all" || cuts?.includes(frame)) && (
          <span className="cut-badge">{text("trim.cuttable")}</span>
        )}
      </div>
      <div className="trim-track">
        <div className="trim-marks" aria-hidden="true">
          <div className="trim-rail" />
          <div
            className="trim-range"
            style={{
              left: pct(ready.from ?? 0),
              right: `calc(100% - ${pct((ready.to ?? 1) - 1)})`,
            }}
          />
          {cuts &&
            cuts.length <= 400 &&
            cuts.map((c) => (
              <i key={c} className="trim-tick" style={{ left: pct(c) }} />
            ))}
        </div>
        <input
          type="range"
          aria-label={text("trim.currentFrame")}
          aria-valuetext={text("trim.framePosition", { frame: n(frame) })}
          min={0}
          max={(ready.frames || 1) - 1}
          value={frame}
          onChange={(e) => {
            // Pointer drags and clicks (keys are handled by onKey).
            const v = Number(e.target.value);
            edit(() => onSeek(v));
          }}
        />
      </div>
      <div className="trim-buttons">
        <Button
          disabled={!native || running || !!ready.empty}
          aria-pressed={playing}
          onClick={togglePlayback}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {text(playing ? "trim.pause" : "trim.play")}
        </Button>
        <Button
          variant="ghost icon"
          aria-label={text("trim.previousCut")}
          title={text("trim.previousCutHint")}
          onClick={() => edit(() => jump(-1))}
        >
          <ChevronFirst size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label={text("trim.previousFrame")}
          title={text("trim.previousFrameHint")}
          onClick={() => edit(() => move(frame - 1))}
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label={text("trim.nextFrame")}
          title={text("trim.nextFrameHint")}
          onClick={() => edit(() => move(frame + 1))}
        >
          <ChevronRight size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label={text("trim.nextCut")}
          title={text("trim.nextCutHint")}
          onClick={() => edit(() => jump(1))}
        >
          <ChevronLast size={16} />
        </Button>
        <Button
          disabled={running}
          title="I"
          onClick={() =>
            edit(() =>
              setRange(
                frame,
                ready.to === ready.frames ? "end" : (ready.to ?? 0),
              ),
            )
          }
        >
          {text("trim.setIn")}
        </Button>
        <Button
          disabled={running}
          title="O"
          onClick={() => edit(() => setRange(ready.from ?? 0, frame))}
        >
          {text("trim.setOut")}
        </Button>
      </div>
      <div className="form-row">
        <Field
          id="trim-in"
          label={mmdFrames ? text("trim.inMmd") : text("trim.inFrame")}
        >
          <input
            id="trim-in"
            value={inText}
            disabled={running}
            onChange={(e) => setInText(e.target.value)}
            onBlur={() => edit(() => applyText("in"))}
            onKeyDown={(e) => e.key === "Enter" && edit(() => applyText("in"))}
          />
        </Field>
        <Field id="trim-out" label={text("trim.out")}>
          <input
            id="trim-out"
            value={outText}
            disabled={running}
            onChange={(e) => setOutText(e.target.value)}
            onBlur={() => edit(() => applyText("out"))}
            onKeyDown={(e) => e.key === "Enter" && edit(() => applyText("out"))}
          />
        </Field>
      </div>
      <p className="hint">
        {text("trim.actualRange", {
          from: n(ready.from),
          to: ready.to === ready.frames ? text("trim.end") : n(ready.to),
          count: (ready.to ?? 0) - (ready.from ?? 0),
          value: n((ready.to ?? 0) - (ready.from ?? 0)),
          time: clock(seconds(ready, (ready.to ?? 0) - (ready.from ?? 0))),
        })}
        {ready.requested &&
          (ready.requested.from !== ready.from ||
            (ready.requested.to !== ready.to && ready.to !== ready.frames)) &&
          text("trim.snappedRange", {
            from: n(ready.requested.from),
            to: n(ready.requested.to),
          })}
        {text("trim.sentenceEnd")}
        {ready.cuts === "all"
          ? text("trim.allFramesHint")
          : text(
              cuts && cuts.length > 1 ? "trim.cutSpacing" : "trim.cutStartOnly",
              {
                count: cuts?.length || 0,
                value: n(cuts?.length),
                interval: n(
                  Math.round((ready.frames || 0) / (cuts?.length || 1)),
                ),
              },
            )}
        {smart &&
          ready.cuts !== "all" &&
          (ready.smartBlocker
            ? text("trim.smartBlocked", {
                reason: errorMessage(ready.smartBlocker),
              })
            : (() => {
                const list = (ready.cuts as number[]) || [];
                const from = ready.from ?? 0,
                  to = ready.to ?? 0;
                const a = list.find((x) => x >= from) ?? (ready.frames || 0);
                const b =
                  to === ready.frames
                    ? to
                    : ([...list].reverse().find((x) => x <= to) ?? 0);
                if (a >= b)
                  return text("trim.smartAll", {
                    from: n(from),
                    to: n(to - 1),
                  });
                const parts = [
                  from < a
                    ? text("trim.smartRange", { from: n(from), to: n(a - 1) })
                    : "",
                  b < to
                    ? text("trim.smartRange", { from: n(b), to: n(to - 1) })
                    : "",
                ].filter(Boolean);
                return parts.length
                  ? text("trim.smartEdges", {
                      ranges: parts.join(text("trim.rangeSeparator")),
                    })
                  : text("trim.smartCopy");
              })())}
        {ready.refused?.length
          ? text("trim.refused", {
              reasons: ready.refused
                .map(errorMessage)
                .join(text("trim.listSeparator")),
            })
          : ""}
      </p>
    </section>
  );
}
