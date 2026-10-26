import { useEffect, useState } from "react";
import { useDragSort } from "./components";
import { createReplacementFlow, type AudioTarget } from "./audioReplacement";
import { useAlignmentTasks } from "./useAlignmentTasks";
import { AUDIO_EXT } from "./mediaOptions";
import {
  t as textLabel,
  summaryMessage,
  notification,
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
import {
  seconds,
  parsePosition,
  mmdFrame,
  replacementOffset,
} from "./trimCoordinates";
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
    if (!t.running) {
      const files = dropped.paths.filter((path) => !AUDIO_EXT.test(path));
      if (files.length) void run("trimAdd", { paths: files });
      const audioFile = dropped.paths.find((path) => AUDIO_EXT.test(path));
      if (audioFile) chooseAudio(audioFile);
    }
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
    if (
      which === "out" &&
      (/^end$/i.test(text.trim()) || text.trim() === textLabel("trim.end"))
    )
      return setRange(ready.from ?? 0, "end");
    const f = parsePosition(text, ready, o.mmdFrames);
    if (f === null)
      return setError({
        code: "TRIM_POSITION_INVALID",
        params: {},
        message: textLabel("error.TRIM_POSITION_INVALID"),
      });
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
  const first = exportable[0];
  // Replacement audio and both offsets belong to this trim session.
  const [audio, setAudio] = useState({
    file: "",
    reference: "",
    offset: 0,
    shiftFrames: 0,
    selection: 0,
  });
  const [alignOpen, setAlignOpen] = useState(false);
  const alignment = useAlignmentTasks(
    "trim",
    first && audio.file && o.audioMode === "replace"
      ? [{ id: first.path, target: audio.file }]
      : [],
  );
  const aligning = !!first && alignment.active.has(first.path);
  function chooseAudio(file: string) {
    setAlignOpen(false);
    setError("");
    setAudio((current) => ({
      file,
      reference: "",
      offset: 0,
      shiftFrames: 0,
      selection: current.selection + 1,
    }));
    set("audioMode", "replace");
  }
  // Also handles audio chosen before a clip was ready. Changing the clip's
  // in point does not rerun the whole-source match or round its result.
  useEffect(() => {
    if (!first?.fps || !audio.file || o.audioMode !== "replace") return;
    setError("");
    setAlignOpen(false);
    const target: AudioTarget = {
      id: first.path,
      path: first.path,
      hasAudio: true,
      isSequence: false,
    };
    const replace = createReplacementFlow<AudioTarget, void>({
      tasks: alignment,
      replace: async (row) => {
        setAudio((current) =>
          current.reference === row.path
            ? current
            : {
                ...current,
                reference: row.path,
                offset: 0,
                shiftFrames: 0,
              },
        );
        return { result: undefined, target: row };
      },
      applyOffset: async (row, file, offset) =>
        setAudio((current) =>
          current.file === file && current.reference === row.path
            ? { ...current, offset }
            : current,
        ),
      notify: (note) =>
        setError(
          note.code === "AUTO_ALIGN_LOW_CONFIDENCE"
            ? notification("AUTO_ALIGN_LOW_CONFIDENCE_TRIM")
            : note,
        ),
    });
    void replace(target, audio.file);
    return () => {
      void alignment.cancel(target.id);
    };
    // These are the replacement identity; matching never depends on its
    // resulting offset, display units, locale, range or other options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first?.path, audio.selection, o.audioMode]);
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
    (o.audioMode !== "replace" || (!!audio.file && !aligning)) &&
    (o.location !== "custom" || !!o.outputDir);

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
    if (typeof file === "string") chooseAudio(file);
  }
  async function pickFolder() {
    const dir = await run("pickDirectory", {
      title: textLabel("trim.chooseOutputFolder"),
    });
    if (dir) set("outputDir", dir);
  }
  function exportTrim() {
    return run("trimExport", {
      audio: {
        mode: o.audioMode,
        codec: o.audioCodec,
        kbps: o.kbps,
        file: audio.file,
        offset: first
          ? replacementOffset(first, audio.offset, audio.shiftFrames)
          : 0,
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
          <section
            className="queue-column"
            aria-label={textLabel("trim.clips")}
          >
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
            error={
              typeof error === "object" && error.code?.startsWith("AUTO_ALIGN_")
                ? summaryMessage({
                    code: error.code,
                    params: error.params,
                    message: error.message,
                  })
                : errorMessage(error || t.errorData || t.error)
            }
            aligning={aligning}
            audioFile={audio.file}
            hasExportable={!!exportable.length}
            set={set}
            onSmart={(smart) => run("trimSmart", { smart })}
            onPickAudio={pickAudio}
            onAlign={() => {
              if (first) void alignment.cancel(first.path);
              setAlignOpen(true);
            }}
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
        elapsed={t.elapsed}
        canExport={canExport}
        onReveal={() => run("reveal", { path: t.output })}
        onCancel={() => run("trimCancel")}
        onExport={exportTrim}
      />
      <AlignDialog
        open={alignOpen && !!audio.file && !!first}
        call={call}
        onClose={() => setAlignOpen(false)}
        frameShift
        targetPath={audio.file}
        fixedReference={first?.path}
        initial={{ offset: audio.offset, shiftFrames: audio.shiftFrames }}
        description={textLabel("trim.alignDescription", {
          name: first?.name || "",
        })}
        onApply={async (a) =>
          setAudio((current) => ({
            ...current,
            offset: a.offset,
            shiftFrames: a.shiftFrames || 0,
          }))
        }
        onClear={
          audio.offset || audio.shiftFrames
            ? async () =>
                setAudio((current) => ({
                  ...current,
                  offset: 0,
                  shiftFrames: 0,
                }))
            : undefined
        }
      />
    </>
  );
}
