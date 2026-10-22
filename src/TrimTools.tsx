import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileVideo,
  Film,
  FolderOpen,
  LoaderCircle,
  Plus,
  Play,
  Scissors,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { Button, Field, Select, useDragSort } from "./components";
import { fadeOptions } from "./presentation";
import type { State, TrimClip } from "./types";

const OPTIONS_KEY = "mmd-trim-options";
type Options = {
  audioMode: string;
  audioCodec: string;
  kbps: number;
  audioFile: string;
  offset: string;
  // Seconds of fade in at the start and out at the end of the whole result.
  fade: number;
  mmdFrames: boolean;
  location: string;
  outputDir: string;
};
const DEFAULT_OPTIONS: Options = {
  audioMode: "reencode",
  audioCodec: "aac",
  kbps: 320,
  audioFile: "",
  offset: "0",
  fade: 0,
  mmdFrames: false,
  location: "source",
  outputDir: "",
};
const AUDIO_MODES: Record<string, string> = {
  reencode: "保留原音频（重新编码，精确到采样点）",
  replace: "替换为外部音频",
  none: "无音频",
};
const AUDIO_CODECS: Record<string, string> = {
  aac: "AAC",
  flac: "FLAC · 无损",
  pcm: "PCM 16-bit · 无损（MOV / MKV）",
};
const LOCATIONS: Record<string, string> = {
  source: "与第一个片段同目录",
  encoded: "其目录下的 Encoded 子文件夹",
  custom: "自定义文件夹",
};
function loadOptions(): Options {
  try {
    return {
      ...DEFAULT_OPTIONS,
      ...JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}"),
    };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

// Frame <-> time on a clip's rational frame rate.
const seconds = (c: TrimClip, frame: number) =>
  c.fps ? (frame * c.fps.den) / c.fps.num : 0;
function clock(sec: number) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
// "1234" is a frame number (or an MMD frame on the 30 fps timeline when
// mmd is on); "1:02.5" / "00:01:02.500" is a time. Returns a video frame.
function parsePosition(text: string, c: TrimClip, mmd: boolean) {
  const t = text.trim();
  if (!t || !c.fps) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return mmd
      ? Math.round(((n - (c.mmdStart ?? 0)) * c.fps.num) / (c.fps.den * 30))
      : n;
  }
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p)) || parts.length > 3) return null;
  const sec = parts.reduce((a, p) => a * 60 + p, 0);
  return Math.round((sec * c.fps.num) / c.fps.den);
}
// The MMD frame a video frame shows: the clip's MMD start plus 30 fps time.
const mmdFrame = (c: TrimClip, frame: number) =>
  (c.mmdStart ?? 0) +
  (c.fps ? Math.round((frame * c.fps.den * 30) / c.fps.num) : frame);

export function TrimTools({
  state,
  call,
  dropped,
  onDropHandled,
}: {
  state: State;
  call: (action: string, payload?: unknown) => Promise<any>;
  dropped?: { paths: string[]; seq: number };
  onDropHandled?: () => void;
}) {
  const t = state.trim;
  const clips = t.clips;
  const [o, setOptions] = useState<Options>(loadOptions),
    [selectedId, setSelectedId] = useState(""),
    [error, setError] = useState(""),
    [cursor, setCursor] = useState<Record<string, number>>({}),
    [image, setImage] = useState(""),
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
      setError((e as Error).message);
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

  // The picture at the cursor: the newest request wins, older answers are dropped.
  const request = useRef(0);
  useEffect(() => {
    if (!ready) return setImage("");
    const n = ++request.current;
    const timer = setTimeout(() => {
      call("trimFrame", { id: ready.id, frame })
        .then((src) => n === request.current && src && setImage(src))
        .catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.id, frame]);
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

  const row = (c: TrimClip, i: number) => (
    <li
      key={c.id}
      className={`job-row ${c.id === selected?.id ? "selected" : ""}`}
      {...sortClip(c.id)}
    >
      <button
        className="job-select"
        onClick={() => setSelectedId(c.id)}
        aria-pressed={c.id === selected?.id}
      >
        <span className="file-tile">
          <FileVideo size={23} />
          <small>{i + 1}</small>
        </span>
        <span className="job-copy">
          <strong title={c.path}>{c.name}</strong>
          <span className="job-sub">
            {c.status === "ready"
              ? `第 ${c.from}–${c.to === c.frames ? "结尾" : c.to} 帧 · ${(c.to ?? 0) - (c.from ?? 0)} 帧 · ${clock(seconds(c, (c.to ?? 0) - (c.from ?? 0)))}`
              : c.status === "indexing"
                ? "正在读取关键帧…"
                : c.error}
          </span>
          <span
            className={`job-status ${c.status === "invalid" ? "failed" : c.empty ? "failed" : "ready"}`}
          >
            {c.status === "indexing" && (
              <LoaderCircle size={12} className="spin" />
            )}
            {c.status === "ready"
              ? c.empty
                ? "吸附后片段为空"
                : `${c.codec?.toUpperCase()} · ${c.width}×${c.height} · ${c.cuts === "all" ? "逐帧可切" : `${(c.cuts as number[]).length} 个可切位置`}`
              : c.status === "indexing"
                ? "读取中"
                : "不能无损裁切"}
          </span>
        </span>
      </button>
      {c.status === "ready" && (
        <Button
          variant="ghost icon"
          aria-label={`再切一段 ${c.name}`}
          title="再切一段：同一文件的另一段"
          disabled={t.running}
          onClick={() => run("trimDuplicate", { id: c.id })}
        >
          <Copy size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={`移除 ${c.name}`}
        title="从列表移除"
        disabled={t.running}
        onClick={() => run("trimRemove", { id: c.id })}
      >
        <X size={16} />
      </Button>
    </li>
  );

  // Position on the slider: frame 0 at the thumb's leftmost centre, the
  // last frame at its rightmost (the marks layer is inset by half a thumb).
  const pct = (f: number) => {
    const last = (ready?.frames || 1) - 1;
    return last > 0
      ? `${(100 * Math.min(Math.max(f, 0), last)) / last}%`
      : "0%";
  };

  return (
    <>
      <main className="workspace">
        <section className="queue-column" aria-label="片段">
          <div className="section-heading">
            <div>
              <span className="eyebrow">工作区</span>
              <h2>
                片段 <span className="count">{clips.length}</span>
              </h2>
            </div>
            <Button
              variant="primary"
              disabled={t.running}
              onClick={async () => {
                const files = await run("pickMedia", { multiple: true });
                if (Array.isArray(files))
                  await run("trimAdd", { paths: files });
              }}
            >
              <Plus size={17} />
              添加视频
            </Button>
          </div>
          <div className="queue-panel">
            <div className="queue-toolbar">
              <span>
                <Scissors size={15} /> 按顺序首尾相接
              </span>
              <Button
                variant="ghost"
                disabled={!clips.length || t.running}
                onClick={() => run("trimClear")}
              >
                清空
              </Button>
            </div>
            {!clips.length ? (
              <div className="empty-queue">
                <div className="film-emblem">
                  <Film size={42} />
                  <div className="frame-ticks" />
                </div>
                <h3>把要剪的视频放进来</h3>
                <p>
                  视频逐包复制、不重新压制，画质完全不变
                  <br />
                  入点和出点会吸附到能无损切开的位置。
                </p>
                <Button
                  onClick={async () => {
                    const files = await run("pickMedia", { multiple: true });
                    if (Array.isArray(files))
                      await run("trimAdd", { paths: files });
                  }}
                >
                  <FolderOpen size={17} />
                  选择视频
                </Button>
                <small>H.264 · HEVC · ProRes · UtVideo · FFV1</small>
              </div>
            ) : (
              <ol className="job-list">{clips.map(row)}</ol>
            )}
          </div>
          {ready && (
            <section
              className="detail-card trim-editor"
              aria-label="片段编辑"
              tabIndex={0}
              onKeyDown={onKey}
            >
              <div className="detail-title">
                <span className="eyebrow">编辑片段</span>
                <div className="detail-actions">
                  <Button
                    variant="ghost"
                    onClick={() => run("reveal", { path: ready.path })}
                  >
                    <FolderOpen size={14} />
                    打开位置
                  </Button>
                </div>
              </div>
              <h3 title={ready.path}>{ready.name}</h3>
              <div className="trim-preview">
                {image ? (
                  <img src={image} alt={`第 ${frame} 帧`} />
                ) : (
                  <LoaderCircle size={22} className="spin" />
                )}
              </div>
              {o.mmdFrames && (
                <div className="file-pick mmd-start">
                  <span>视频第 0 帧 = MMD 第</span>
                  <input
                    aria-label="视频第 0 帧对应的 MMD 帧"
                    inputMode="numeric"
                    key={ready.id + ":" + ready.mmdStart}
                    defaultValue={String(ready.mmdStart ?? 0)}
                    disabled={t.running}
                    onBlur={(e) =>
                      Number(e.target.value) !== (ready.mmdStart ?? 0) &&
                      run("trimSet", {
                        id: ready.id,
                        mmdStart: Number(e.target.value),
                      })
                    }
                    onKeyDown={(e) =>
                      e.key === "Enter" && (e.target as HTMLInputElement).blur()
                    }
                  />
                  <span className="hint">
                    帧
                    {ready.mmdStartFrom === "tag"
                      ? "（来自 MMDEncoder 导出时记录的信息）"
                      : ready.mmdStartFrom === "name"
                        ? "（来自文件名里的帧范围）"
                        : ready.mmdStartFrom === "manual"
                          ? "（手动填写）"
                          : "（没有识别到，按 0 计算，可以手动填写）"}
                  </span>
                </div>
              )}
              <div className="trim-position">
                <strong>
                  第 {frame} 帧
                  {o.mmdFrames && ` · MMD 第 ${mmdFrame(ready, frame)} 帧`}
                </strong>
                <span>{clock(seconds(ready, frame))}</span>
                {(ready.cuts === "all" || cuts?.includes(frame)) && (
                  <span className="cut-badge">可切</span>
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
                      <i
                        key={c}
                        className="trim-tick"
                        style={{ left: pct(c) }}
                      />
                    ))}
                </div>
                <input
                  type="range"
                  aria-label="当前帧"
                  aria-valuetext={`第 ${frame} 帧`}
                  min={0}
                  max={(ready.frames || 1) - 1}
                  value={frame}
                  onChange={(e) => {
                    // Pointer drags and clicks (keys are handled by onKey).
                    const v = Number(e.target.value);
                    move(snapping ? nearestCut(v) : v);
                  }}
                />
              </div>
              <div className="trim-buttons">
                <Button
                  variant="ghost icon"
                  aria-label="上一个可切位置"
                  title="上一个可切位置（↑）"
                  onClick={() => jump(-1)}
                >
                  <ChevronFirst size={16} />
                </Button>
                <Button
                  variant="ghost icon"
                  aria-label="上一帧"
                  title="上一帧（←）"
                  onClick={() => move(frame - 1)}
                >
                  <ChevronLeft size={16} />
                </Button>
                <Button
                  variant="ghost icon"
                  aria-label="下一帧"
                  title="下一帧（→）"
                  onClick={() => move(frame + 1)}
                >
                  <ChevronRight size={16} />
                </Button>
                <Button
                  variant="ghost icon"
                  aria-label="下一个可切位置"
                  title="下一个可切位置（↓）"
                  onClick={() => jump(1)}
                >
                  <ChevronLast size={16} />
                </Button>
                <Button
                  disabled={t.running}
                  title="I"
                  onClick={() =>
                    setRange(
                      frame,
                      ready.to === ready.frames ? "end" : (ready.to ?? 0),
                    )
                  }
                >
                  设为入点
                </Button>
                <Button
                  disabled={t.running}
                  title="O"
                  onClick={() => setRange(ready.from ?? 0, frame)}
                >
                  设为出点
                </Button>
              </div>
              <div className="form-row">
                <Field
                  id="trim-in"
                  label={
                    o.mmdFrames ? "入点 · MMD 帧号或时间" : "入点 · 帧号或时间"
                  }
                >
                  <input
                    id="trim-in"
                    value={inText}
                    disabled={t.running}
                    onChange={(e) => setInText(e.target.value)}
                    onBlur={() => applyText("in")}
                    onKeyDown={(e) => e.key === "Enter" && applyText("in")}
                  />
                </Field>
                <Field id="trim-out" label="出点（不含这一帧；end 为结尾）">
                  <input
                    id="trim-out"
                    value={outText}
                    disabled={t.running}
                    onChange={(e) => setOutText(e.target.value)}
                    onBlur={() => applyText("out")}
                    onKeyDown={(e) => e.key === "Enter" && applyText("out")}
                  />
                </Field>
              </div>
              <p className="hint">
                实际：第 {ready.from} –{" "}
                {ready.to === ready.frames ? "结尾" : `${ready.to}`} 帧，共{" "}
                {(ready.to ?? 0) - (ready.from ?? 0)} 帧（
                {clock(seconds(ready, (ready.to ?? 0) - (ready.from ?? 0)))}）
                {ready.requested &&
                  (ready.requested.from !== ready.from ||
                    (ready.requested.to !== ready.to &&
                      ready.to !== ready.frames)) &&
                  `。已吸附到最近的可切位置（输入 ${ready.requested.from} – ${ready.requested.to}）`}
                。
                {ready.cuts === "all"
                  ? "这个文件每一帧都可以切。"
                  : `可切位置共 ${cuts?.length} 处${cuts && cuts.length > 1 ? `，约每 ${Math.round((ready.frames || 0) / cuts.length)} 帧一处` : "（只能从开头切）"}。`}
                {t.smart &&
                  ready.cuts !== "all" &&
                  (ready.smartBlocker
                    ? ` 这个文件不能智能剪切：${ready.smartBlocker}，仍吸附到可切位置。`
                    : (() => {
                        const list = (ready.cuts as number[]) || [];
                        const from = ready.from ?? 0,
                          to = ready.to ?? 0;
                        const a =
                          list.find((x) => x >= from) ?? (ready.frames || 0);
                        const b =
                          to === ready.frames
                            ? to
                            : ([...list].reverse().find((x) => x <= to) ?? 0);
                        if (a >= b)
                          return ` 智能剪切：这一段第 ${from}–${to - 1} 帧全部重新编码。`;
                        const parts = [
                          from < a ? `第 ${from}–${a - 1} 帧` : "",
                          b < to ? `第 ${b}–${to - 1} 帧` : "",
                        ].filter(Boolean);
                        return parts.length
                          ? ` 智能剪切：${parts.join("、")}重新编码，其余直接复制。`
                          : " 智能剪切：切点正好在关键帧上，全部直接复制。";
                      })())}
                {ready.refused?.length
                  ? ` 其他关键帧不能切：${ready.refused.join("；")}。`
                  : ""}
              </p>
            </section>
          )}
        </section>
        <aside className="settings-column" aria-label="导出设置">
          <div className="section-heading">
            <div>
              <span className="eyebrow">输出控制</span>
              <h2>导出设置</h2>
            </div>
            <SlidersHorizontal size={20} className="muted" />
          </div>
          <div className="settings-panel">
            <form
              noValidate
              onSubmit={(e) => e.preventDefault()}
              className="settings-body"
            >
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={t.smart}
                  disabled={t.running}
                  onChange={(e) =>
                    run("trimSmart", { smart: e.target.checked })
                  }
                />
                <span>
                  智能剪切
                  <small className="hint hires-hint">
                    按输入的帧精确切开：只有切点到最近关键帧之间的几帧用原片的编码参数重新编码，其余直接复制。需要
                    MMDEncoder 1.5.0 起导出的 H.264 /
                    HEVC（记录了编码参数），本机编码器须与导出时相同；重新编码的帧不是无损的。
                  </small>
                </span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={o.mmdFrames}
                  onChange={(e) => set("mmdFrames", e.target.checked)}
                />
                <span>
                  按 MMD 帧号输入
                  <small className="hint hires-hint">
                    按 MMD 时间轴（30 FPS）换算，并从片段的起始 MMD
                    帧算起：MMDEncoder
                    导出的文件会自动识别（文件信息或文件名里的
                    _0400-0600f），其他文件可以手动填写。
                  </small>
                </span>
              </label>
              <Select
                id="trim-audio"
                label="音频"
                value={o.audioMode}
                disabled={t.running}
                options={Object.entries(AUDIO_MODES).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(v) => set("audioMode", v)}
              />
              {o.audioMode === "replace" && (
                <>
                  <div className="file-pick">
                    <Button
                      disabled={t.running}
                      onClick={async () => {
                        const file = await run("pickMedia", {});
                        if (typeof file === "string") set("audioFile", file);
                      }}
                    >
                      <FolderOpen size={15} />
                      选择音频
                    </Button>
                    <span className="path-text" title={o.audioFile}>
                      {o.audioFile || "尚未选择"}
                    </span>
                  </div>
                  <Field
                    id="trim-offset"
                    label={o.mmdFrames ? "起点偏移 · MMD 帧" : "起点偏移 · 秒"}
                    hint="正数：从音频的这个位置开始用；负数：视频开头先空这么久再接音频。"
                  >
                    <input
                      id="trim-offset"
                      inputMode="decimal"
                      value={o.offset}
                      disabled={t.running}
                      onChange={(e) => set("offset", e.target.value)}
                    />
                  </Field>
                </>
              )}
              {o.audioMode !== "none" && (
                <Select
                  id="trim-audio-codec"
                  label="音频格式"
                  value={o.audioCodec}
                  disabled={t.running}
                  options={Object.entries(AUDIO_CODECS).map(
                    ([value, label]) => ({ value, label }),
                  )}
                  onChange={(v) => set("audioCodec", v)}
                />
              )}
              {o.audioMode !== "none" && (
                <Select
                  id="trim-fade"
                  label="音频淡入淡出"
                  value={String(o.fade ?? 0)}
                  disabled={t.running}
                  options={fadeOptions}
                  hint="只在整段成片的开头淡入、结尾淡出，片段之间的接缝不做淡化。"
                  onChange={(v) => set("fade", Number(v))}
                />
              )}
              {o.audioMode !== "none" && o.audioCodec === "aac" && (
                <Select
                  id="trim-kbps"
                  label="音频码率"
                  value={String(o.kbps)}
                  disabled={t.running}
                  options={[128, 192, 256, 320, 384, 512].map((b) => ({
                    value: String(b),
                    label: `${b} kbps`,
                  }))}
                  onChange={(v) => set("kbps", Number(v))}
                />
              )}
              <Select
                id="trim-location"
                label="输出位置"
                value={o.location}
                disabled={t.running}
                options={Object.entries(LOCATIONS).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(v) => set("location", v)}
              />
              {o.location === "custom" && (
                <div className="file-pick">
                  <Button
                    disabled={t.running}
                    onClick={async () => {
                      const dir = await run("pickDirectory", {
                        title: "选择输出文件夹",
                      });
                      if (dir) set("outputDir", dir);
                    }}
                  >
                    <FolderOpen size={15} />
                    选择文件夹
                  </Button>
                  <span className="path-text" title={o.outputDir}>
                    {o.outputDir || "尚未选择"}
                  </span>
                </div>
              )}
              <p className="hint">
                {t.smart
                  ? "视频除切点附近重新编码的几帧外逐包复制；"
                  : "视频逐包复制，不重新压制；"}
                各段音频按采样点精确截取后首尾相接，不做淡入淡出，音频不够长的地方补静音，总长度与视频一致。不同文件的片段需要编码参数完全一致才能拼接。
              </p>
              {(error || t.error) && (
                <p role="alert" className="inline-error">
                  {error || t.error}
                </p>
              )}
            </form>
          </div>
        </aside>
      </main>
      <footer className="output-strip">
        <div className="output-icon">
          <ArrowDownToLine size={23} />
        </div>
        <div className="output-summary">
          <span className="eyebrow">预计结果</span>
          <strong>
            {exportable.length ? `${exportable.length} 段` : "添加片段"}{" "}
            <ArrowRight size={15} />
            <span>
              {totalFrames} 帧 · {clock(totalSeconds)}
            </span>
          </strong>
          <span className="output-facts">
            视频 → 直接复制
            <i /> 音频 → {AUDIO_MODES[o.audioMode].split("（")[0]}
            {o.audioMode !== "none" &&
              ` · ${AUDIO_CODECS[o.audioCodec].split(" ·")[0]}`}
            <i /> 位置 → {LOCATIONS[o.location]}
          </span>
          <span className="output-path" title={t.output}>
            {t.running
              ? `${t.stage} · ${t.progress}%`
              : t.output
                ? `已保存：${t.output}`
                : t.stage === "已取消"
                  ? "已取消"
                  : "文件名为第一个片段的名字加“_剪辑”，已有文件不覆盖"}
          </span>
        </div>
        <div className="run-actions">
          {t.output && !t.running && (
            <Button
              variant="ghost"
              onClick={() => run("reveal", { path: t.output })}
            >
              <FolderOpen size={15} />
              打开位置
            </Button>
          )}
          {t.running ? (
            <Button variant="stop" onClick={() => run("trimCancel")}>
              <Square size={16} />
              取消导出
            </Button>
          ) : (
            <Button
              variant="primary run"
              disabled={!canExport}
              onClick={() =>
                run("trimExport", {
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
                })
              }
            >
              <Play size={17} />
              导出
            </Button>
          )}
        </div>
      </footer>
    </>
  );
}
