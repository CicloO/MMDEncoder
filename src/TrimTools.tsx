import { useEffect, useState } from "react";
import { useDragSort } from "./components";
import { autoAlign } from "./autoAlign";
import {
  t as text,
  summaryMessage,
  errorMessage,
  type ErrorData,
} from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import { AlignDialog } from "./AlignDialog";
import { TrimQueue } from "./TrimQueue";
import { TrimEditor } from "./TrimEditor";
import { TrimSettings } from "./TrimSettings";
import { TrimFooter } from "./TrimFooter";
import { useTrimPreview } from "./useTrimPreview";
import { OPTIONS_KEY, loadOptions, type Options } from "./trimOptions";
import { seconds, parsePosition, mmdFrame } from "./trimCoordinates";
import type { State } from "./types";

export function TrimTools({
  trim: t,
  call,
  dropped,
  onDropHandled,
}: {
  trim: State["trim"];
  call: (action: string, payload?: unknown) => Promise<any>;
  dropped?: { paths: string[]; seq: number };
  onDropHandled?: () => void;
}) {
  const clips = t.clips;
  const [o, setOptions] = useState<Options>(loadOptions),
    [selectedId, setSelectedId] = useState(""),
    [error, setError] = useState<string | ErrorData>(""),
    [cursor, setCursor] = useState<Record<string, number>>({}),
    [inText, setInText] = useState(""),
    [outText, setOutText] = useState("");
  const selected = clips.find((c) => c.id === selectedId) || clips[0];
  const ready = selected?.status === "ready" ? selected : undefined;
  const frame = ready
    ? Math.min(cursor[ready.id] ?? ready.from ?? 0, (ready.frames || 1) - 1)
    : 0;
  const set = <K extends keyof Options>(k: K, v: Options[K]) => {
    const next = { ...o, [k]: v };
    setOptions(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {}
  };
  async function run(action: string, payload?: unknown) {
    setError("");
    try {
      return await call(action, payload);
    } catch (e) {
      setError(serializeError(e));
    }
  }
  const sortClip = useDragSort(
    clips.map((c) => c.id),
    (ids) => void call("trimReorder", { ids }).catch(() => {}),
    !t.running,
  );
  useEffect(() => {
    if (!dropped) return;
    onDropHandled?.();
    if (!t.running) void run("trimAdd", { paths: dropped.paths });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped?.seq]);

  const image = useTrimPreview(ready?.id, frame, (id, frame) =>
    call("trimFrame", { id, frame }),
  );
  // Range fields follow the clip's snapped range.
  useEffect(() => {
    if (!ready) return;
    const show = (f: number) => String(o.mmdFrames ? mmdFrame(ready, f) : f);
    setInText(show(ready.from ?? 0));
    setOutText(ready.to === ready.frames ? "end" : show(ready.to ?? 0));
  }, [ready?.id, ready?.from, ready?.to, o.mmdFrames]);

  const cuts = ready && ready.cuts !== "all" ? (ready.cuts as number[]) : null;
  // Without smart cut (or where it can't be used) a cut can only start at
  // these frames, so the slider snaps to them.
  const snapping = !!cuts && (!t.smart || !!ready?.smartBlocker);
  const nearestCut = (f: number) =>
    cuts!.reduce((best, c) =>
      Math.abs(c - f) < Math.abs(best - f) ? c : best,
    );
  const move = (to: number) =>
    ready &&
    setCursor({
      ...cursor,
      [ready.id]: Math.max(0, Math.min((ready.frames || 1) - 1, to)),
    });
  const jump = (dir: 1 | -1) => {
    if (!ready) return;
    if (!cuts) return move(frame + dir);
    const next =
      dir > 0
        ? cuts.find((c) => c > frame)
        : [...cuts].reverse().find((c) => c < frame);
    if (next !== undefined) move(next);
  };
  const setRange = (from: number | string, to: number | string) =>
    ready && run("trimSet", { id: ready.id, from, to });
  function applyText(which: "in" | "out") {
    if (!ready) return;
    const text = which === "in" ? inText : outText;
    if (which === "out" && /^(end|结尾)$/i.test(text.trim()))
      return setRange(ready.from ?? 0, "end");
    const f = parsePosition(text, ready, o.mmdFrames);
    if (f === null)
      return setError("请输入帧号或时间（如 1234 或 00:00:41.133）");
    if (which === "in")
      setRange(f, ready.to === ready.frames ? "end" : (ready.to ?? 0));
    else setRange(ready.from ?? 0, f);
    move(f);
  }
  // ←/→ one frame, ↑/↓ previous / next cut point (Shift+←/→ too); also on
  // the slider itself, whose own arrow-key steps are replaced by these.
  function onKey(e: React.KeyboardEvent) {
    const el = e.target as HTMLInputElement;
    if (!ready || (el.tagName === "INPUT" && el.type !== "range")) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowUp") jump(-1);
      else if (e.key === "ArrowDown") jump(1);
      else {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.shiftKey) jump(dir);
        else move(frame + dir);
      }
    } else if (el.type === "range") {
      return;
    } else if (e.key.toLowerCase() === "i") {
      setRange(frame, ready.to === ready.frames ? "end" : (ready.to ?? 0));
    } else if (e.key.toLowerCase() === "o") {
      setRange(ready.from ?? 0, frame);
    }
  }

  const exportable = clips.filter((c) => c.status === "ready" && !c.empty);
  // 音频对齐 for the replacement audio: where the first clip's start falls
  // in the audio, from the clip's own sound (one clip, or clips in order
  // from one take, line up throughout).
  const [aligning, setAligning] = useState(false);
  // The first clip's start in its own file (seconds): 起点偏移 counts the
  // audio from there, the alignment from the file's start.
  const clipStart = () => {
    const first = exportable[0];
    return first?.fps ? (first.from ?? 0) / (first.fps.num / first.fps.den) : 0;
  };
  const setOffsetSeconds = (at: number) =>
    set("offset", o.mmdFrames ? String(Math.round(at * 30)) : at.toFixed(3));
  const [alignOpen, setAlignOpen] = useState(false);
  async function fillOffset() {
    const first = exportable[0];
    if (!first || !o.audioFile || !first.fps) return;
    setAligning(true);
    setError("");
    const note = await autoAlign(first.path, o.audioFile, async (offset) =>
      setOffsetSeconds(offset + clipStart()),
    );
    setAligning(false);
    if (note)
      setError(
        note.code === "AUTO_ALIGN_LOW_CONFIDENCE"
          ? text("message.AUTO_ALIGN_LOW_CONFIDENCE_TRIM")
          : summaryMessage(note),
      );
  }
  const totalFrames = exportable.reduce(
    (a, c) => a + ((c.to ?? 0) - (c.from ?? 0)),
    0,
  );
  const totalSeconds = exportable.reduce(
    (a, c) => a + seconds(c, (c.to ?? 0) - (c.from ?? 0)),
    0,
  );
  const canExport =
    !t.running &&
    exportable.length > 0 &&
    !clips.some((c) => c.status === "indexing") &&
    (o.audioMode !== "replace" || !!o.audioFile) &&
    (o.location !== "custom" || !!o.outputDir);
  const offsetSeconds = () => {
    const n = Number(o.offset) || 0;
    return o.mmdFrames ? n / 30 : n;
  };

  // Position on the slider: frame 0 at the thumb's leftmost centre, the
  // last frame at its rightmost (the marks layer is inset by half a thumb).
  const pct = (f: number) => {
    const last = (ready?.frames || 1) - 1;
    return last > 0
      ? `${(100 * Math.min(Math.max(f, 0), last)) / last}%`
      : "0%";
  };

  async function pickFiles() {
    const files = await run("pickMedia", { multiple: true });
    if (Array.isArray(files)) await run("trimAdd", { paths: files });
  }
  async function pickAudio() {
    const file = await run("pickMedia", {});
    if (typeof file === "string") set("audioFile", file);
  }
  async function pickFolder() {
    const dir = await run("pickDirectory", { title: "选择输出文件夹" });
    if (dir) set("outputDir", dir);
  }
  function exportTrim() {
    return run("trimExport", {
      audio: {
        mode: o.audioMode,
        codec: o.audioCodec,
        kbps: o.kbps,
        file: o.audioFile,
        offset: offsetSeconds(),
        fade: o.fade ?? 0,
      },
      location: o.location,
      outputDir: o.outputDir,
    });
  }

  return (
    <>
      <div className="page-scroll">
        <main className="workspace">
          <section className="queue-column" aria-label="片段">
            <TrimQueue
              clips={clips}
              selectedId={selected?.id}
              running={t.running}
              sortClip={sortClip}
              onSelect={setSelectedId}
              onDuplicate={(id) => run("trimDuplicate", { id })}
              onRemove={(id) => run("trimRemove", { id })}
              onAdd={pickFiles}
              onClear={() => run("trimClear")}
            />
            {ready && (
              <TrimEditor
                ready={ready}
                frame={frame}
                image={image}
                running={t.running}
                smart={t.smart}
                mmdFrames={o.mmdFrames}
                cuts={cuts}
                inText={inText}
                outText={outText}
                onKey={onKey}
                onReveal={() => run("reveal", { path: ready.path })}
                onMmdStart={(mmdStart) =>
                  run("trimSet", { id: ready.id, mmdStart })
                }
                onSeek={(value) => move(snapping ? nearestCut(value) : value)}
                move={move}
                jump={jump}
                setRange={setRange}
                setInText={setInText}
                setOutText={setOutText}
                applyText={applyText}
                pct={pct}
              />
            )}
          </section>
          <TrimSettings
            o={o}
            running={t.running}
            smart={t.smart}
            error={errorMessage(error || t.errorData || t.error)}
            aligning={aligning}
            hasExportable={!!exportable.length}
            set={set}
            onSmart={(smart) => run("trimSmart", { smart })}
            onPickAudio={pickAudio}
            onAlign={() => setAlignOpen(true)}
            fillOffset={fillOffset}
            onPickFolder={pickFolder}
          />
        </main>
      </div>
      <TrimFooter
        clipCount={exportable.length}
        totalFrames={totalFrames}
        totalSeconds={totalSeconds}
        audioMode={o.audioMode}
        audioCodec={o.audioCodec}
        location={o.location}
        running={t.running}
        stage={t.stage}
        progress={t.progress}
        output={t.output}
        canExport={canExport}
        onReveal={() => run("reveal", { path: t.output })}
        onCancel={() => run("trimCancel")}
        onExport={exportTrim}
      />
      <AlignDialog
        open={alignOpen && !!o.audioFile && !!exportable.length}
        call={call}
        onClose={() => setAlignOpen(false)}
        targetPath={o.audioFile}
        fixedReference={exportable[0]?.path}
        initial={
          Number(o.offset)
            ? { offset: offsetSeconds() - clipStart() }
            : undefined
        }
        description={`把替换音频对齐到“${exportable[0]?.name || ""}”自带的声音；应用后填入起点偏移（按第一个片段的起点换算）。`}
        onApply={async (a) => setOffsetSeconds(a.offset + clipStart())}
        onClear={Number(o.offset) ? async () => set("offset", "0") : undefined}
      />
    </>
  );
}
