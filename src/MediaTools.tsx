import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  FileAudio,
  FileVideo,
  Film,
  FolderOpen,
  Info,
  LoaderCircle,
  Music,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Button,
  Field,
  Select,
  Modal,
  useDragSort,
  PAGE_SIZE,
} from "./components";
import { MediaDetails } from "./MediaDetails";
import { AlignDialog } from "./AlignDialog";
import { autoAlign, offsetText } from "./autoAlign";
import { fadeOptions, fadeHint } from "./presentation";
import { FileMeta, metaSummary } from "./FileMeta";
import type { MediaJob, State } from "./types";

const AUDIO_EXT = /\.(wav|flac|mp3|aac|m4a|opus|ogg|mka)$/i;
const OPERATIONS: Record<string, string> = {
  audio: "提取音频",
  video: "提取无音频视频",
  merge: "视频与独立音频合并",
};
const FORMATS: Record<string, string> = {
  wav: "WAV · PCM 16-bit 无损",
  flac: "FLAC · 无损",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  copy: "直接复制原音频 · 不重新编码",
};
const LOSSY = ["aac", "mp3", "opus"];
// 0 follows the source audio bitrate (lossless sources use 320 kbps).
const BITRATES = [0, 96, 128, 160, 192, 256, 320, 384, 512];
const MAX_BITRATE: Record<string, number> = { aac: 512, mp3: 320, opus: 512 };
const CONTAINERS: Record<string, string> = {
  mp4: "MP4",
  mkv: "MKV",
};
const LOCATIONS: Record<string, string> = {
  source: "与源文件同目录",
  encoded: "源目录下的 Encoded 子文件夹",
  custom: "自定义文件夹",
};
const STATUS: Record<string, string> = {
  ready: "等待处理",
  running: "处理中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const OPTIONS_KEY = "mmd-media-options";
type Options = {
  operation: string;
  audioFormat: string;
  audioBitrate: number;
  container: string;
  // 24-bit, and twice the sample rate below 48 kHz (WAV / FLAC only).
  hiRes: boolean;
  // Seconds of fade in / out (0 = off); not with a copied audio track.
  audioFade: number;
  // Merging: line the added audio up with the video's sound once chosen.
  autoAlign: boolean;
  location: string;
  outputDir: string;
};
const DEFAULT_OPTIONS: Options = {
  operation: "audio",
  audioFormat: "wav",
  audioBitrate: 0,
  container: "mp4",
  hiRes: false,
  audioFade: 0,
  autoAlign: true,
  location: "source",
  outputDir: "",
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
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// Hi-Res result for a source, as backend/media.cjs hiResPlan decides it.
const HIRES_FORMATS = ["wav", "flac"];
function hiResText(a?: { sampleRate: number; bits?: number; float?: boolean }) {
  if (!a?.sampleRate) return "";
  const rate = a.sampleRate < 48000 ? a.sampleRate * 2 : a.sampleRate;
  const depth = a.float ? "浮点" : a.bits ? a.bits + "-bit" : "位深未知";
  return `${a.sampleRate / 1000} kHz / ${depth} → ${rate / 1000} kHz / 24-bit`;
}

export function MediaTools({
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
  const [o, setOptions] = useState<Options>(loadOptions),
    [selectedId, setSelectedId] = useState(""),
    [preview, setPreview] = useState(""),
    [error, setError] = useState(""),
    [details, setDetails] = useState<any>(null),
    [detailsOpen, setDetailsOpen] = useState(false),
    [detailsError, setDetailsError] = useState(""),
    // The file whose 音频对齐 dialog is open.
    [alignId, setAlignId] = useState("");
  const jobs = state.mediaJobs;
  // Same paging as the video queue.
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  const sortJob = useDragSort(
    jobs.map((j) => j.id),
    (ids) => void call("mediaReorder", { ids }).catch(() => {}),
  );
  const selected = jobs.find((j) => j.id === selectedId) || jobs[0];
  const [fullLog, setFullLog] = useState<{ id: string; log: string } | null>(
    null,
  );
  const locked =
    state.running ||
    state.detecting ||
    !!state.tools?.busy ||
    state.enhancements.busy;
  const readyJobs = jobs.filter((j) => j.status === "ready");
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const clearable = jobs.some((j) => ["done", "cancelled"].includes(j.status));
  // A remembered bitrate above the chosen format's limit (e.g. 512k → MP3) is capped.
  const bitrate = Math.min(o.audioBitrate, MAX_BITRATE[o.audioFormat] || 512);
  // Hi-Res applies to lossless audio output only.
  const hiRes =
    o.hiRes && o.operation !== "video" && HIRES_FORMATS.includes(o.audioFormat);
  const missingAudio =
    o.operation === "merge" && readyJobs.some((j) => !j.audioPath);

  function set<K extends keyof Options>(key: K, value: Options[K]) {
    const next = { ...o, [key]: value };
    setOptions(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {
      /* Options still apply for this session. */
    }
  }
  async function run(action: string, payload?: unknown) {
    setError("");
    try {
      return await call(action, payload);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Added or dropped files: when merging, audio files are paired with the
  // selected video (or the first one still missing audio); the rest join the queue.
  async function accept(paths: string[]) {
    if (!paths.length) return;
    const audio =
      o.operation === "merge" ? paths.filter((p) => AUDIO_EXT.test(p)) : [];
    const media = paths.filter((p) => !audio.includes(p));
    // Use the queue returned by each call; props update only after re-render.
    let current: MediaJob[] = jobs;
    if (media.length)
      current = (await run("mediaAdd", { paths: media }))?.mediaJobs || current;
    for (const path of audio) {
      const chosen = current.find((j) => j.id === selected?.id);
      const target =
        (chosen?.status === "ready" && !chosen.audioPath
          ? chosen
          : undefined) ||
        current.find((j) => j.status === "ready" && !j.audioPath);
      if (!target) {
        setError("没有等待配对音频的视频，请先加入视频文件");
        break;
      }
      current = (await setAudio(target, path))?.mediaJobs || current;
    }
  }
  useEffect(() => {
    if (!dropped?.paths.length) return;
    onDropHandled?.();
    if (!locked) void accept(dropped.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped?.seq]);

  // Preview of the automatic output name for the selected (or first waiting) file.
  const previewJob =
    selected?.status === "ready" ? selected : readyJobs[0] || selected;
  useEffect(() => {
    if (!previewJob) return setPreview("");
    let live = true;
    call("mediaSuggest", {
      operation: o.operation,
      input: previewJob.path,
      audioInput: previewJob.audioPath,
      audioFormat: o.audioFormat,
      container: o.container,
      hiRes,
      location: o.location,
      outputDir: o.outputDir,
    })
      .then((r) => live && setPreview(r || ""))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewJob?.id,
    previewJob?.audioPath,
    previewJob?.status,
    o.operation,
    o.audioFormat,
    o.container,
    hiRes,
    o.location,
    o.outputDir,
  ]);

  async function pickFiles() {
    const files = await run("pickMedia", { multiple: true });
    if (Array.isArray(files)) await accept(files);
  }
  async function pickAudio(job: MediaJob) {
    const files = await run("pickMedia", { multiple: false });
    const file = Array.isArray(files) ? files[0] : files;
    if (file) await setAudio(job, file);
  }
  // Pair an audio file with a video and, when chosen, line it up at once.
  async function setAudio(job: MediaJob, file: string) {
    const r = await run("mediaSetAudio", { id: job.id, path: file });
    if (r && o.autoAlign) {
      const note = await autoAlign(job.path, file, (offset) =>
        run("mediaSetAudioOffset", { id: job.id, offset }),
      );
      if (note) setError(note);
    }
    return r;
  }
  async function pickFolder() {
    const dir = await run("pickDirectory", { title: "选择输出文件夹" });
    if (dir) set("outputDir", dir);
  }
  const ready =
    !locked &&
    readyJobs.length > 0 &&
    !missingAudio &&
    (o.location !== "custom" || !!o.outputDir);

  const row = (j: MediaJob) => (
    <li
      key={j.id}
      className={`job-row ${j.id === selected?.id ? "selected" : ""}`}
      {...sortJob(j.id)}
    >
      <button
        className="job-select"
        onClick={() => setSelectedId(j.id)}
        aria-pressed={j.id === selected?.id}
      >
        <span className={`file-tile ${j.status === "done" ? "complete" : ""}`}>
          {j.status === "done" ? (
            <Check size={22} />
          ) : AUDIO_EXT.test(j.path) ? (
            <FileAudio size={23} />
          ) : (
            <FileVideo size={23} />
          )}
          <small>{j.name.split(".").pop()?.slice(0, 5).toUpperCase()}</small>
        </span>
        <span className="job-copy">
          <strong title={j.path}>{j.name}</strong>
          <span className="job-sub">
            {j.meta ? metaSummary(j.meta) : j.metaError || "正在读取文件信息"}
            {o.operation === "merge" &&
              (j.audioPath
                ? ` · 音频：${baseName(j.audioPath)}${j.audioOffset !== undefined ? " · 对齐 " + offsetText(j.audioOffset) : ""}`
                : " · 尚未选择替换音频")}
            {o.operation === "audio" &&
              j.align &&
              ` · 对齐 ${j.align.offset >= 0 ? "+" : ""}${j.align.offset.toFixed(3)} 秒${j.align.length ? " · 截到参考长度" : ""}`}
          </span>
          <span className={`job-status ${j.status}`} title={j.error}>
            {j.status === "running" && (
              <LoaderCircle size={12} className="spin" />
            )}
            {STATUS[j.status] || j.status}
            {j.status === "failed" && j.error
              ? ` · ${j.error.slice(0, 60)}`
              : ""}
          </span>
        </span>
      </button>
      {o.operation === "merge" && j.status === "ready" && (
        <Button
          variant="ghost icon"
          aria-label={`为 ${j.name} 选择音频`}
          title="选择替换音频"
          disabled={locked}
          onClick={() => pickAudio(j)}
        >
          <Music size={16} />
        </Button>
      )}
      {o.operation === "merge" && j.status === "ready" && j.audioPath && (
        <Button
          variant={`ghost icon${j.audioOffset !== undefined ? " active" : ""}`}
          aria-label={`对齐 ${j.name} 的合并音频`}
          title="音频对齐：以视频自带的声音为参考检视、微调"
          disabled={locked}
          onClick={() => setAlignId(j.id)}
        >
          <AudioLines size={16} />
        </Button>
      )}
      {o.operation === "audio" && j.status === "ready" && (
        <Button
          variant={`ghost icon${j.align ? " active" : ""}`}
          aria-label={`对齐 ${j.name} 的音频`}
          title={
            j.align ? "音频对齐（已对齐）" : "音频对齐：按参考音频对齐起点"
          }
          disabled={locked}
          onClick={() => setAlignId(j.id)}
        >
          <AudioLines size={16} />
        </Button>
      )}
      {["done", "cancelled", "failed"].includes(j.status) && (
        <Button
          variant="ghost icon"
          aria-label={`重新导出 ${j.name}`}
          title="重新导出：放回队列，按当前设置处理，已有文件不覆盖"
          disabled={state.running}
          onClick={() => run("mediaRequeue", { id: j.id })}
        >
          <RefreshCw size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={`移除 ${j.name}`}
        title="从列表移除"
        disabled={j.status === "running"}
        onClick={() => run("mediaRemove", { id: j.id })}
      >
        <X size={16} />
      </Button>
    </li>
  );

  return (
    <>
      <div className="page-scroll">
        <main className="workspace">
          <section className="queue-column" aria-label="媒体队列">
            <div className="section-heading">
              <div>
                <span className="eyebrow">工作区</span>
                <h2>
                  媒体队列 <span className="count">{jobs.length}</span>
                </h2>
              </div>
              <Button variant="primary" disabled={locked} onClick={pickFiles}>
                <Plus size={17} />
                添加文件
              </Button>
            </div>
            <div className="queue-panel">
              <div className="queue-toolbar">
                <span>
                  <FileVideo size={15} /> 源文件
                </span>
                <Button
                  variant="ghost"
                  disabled={!clearable || state.running}
                  onClick={() => run("mediaClearCompleted")}
                >
                  清除已完成
                </Button>
              </div>
              {!jobs.length ? (
                <div className="empty-queue">
                  <div className="film-emblem">
                    <Film size={42} />
                    <div className="frame-ticks" />
                  </div>
                  <h3>把音视频放进来</h3>
                  <p>
                    拖入多个视频或音频，或从文件夹中选择
                    <br />
                    合并时拖入的音频会配给选中的视频。
                  </p>
                  <Button disabled={locked} onClick={pickFiles}>
                    <FolderOpen size={17} />
                    选择文件
                  </Button>
                  <small>MP4 · MKV · MOV · WAV · FLAC · MP3 等常见格式</small>
                </div>
              ) : (
                <ol className="job-list">
                  {jobs
                    .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
                    .map(row)}
                </ol>
              )}
              {jobs.length > 0 && (
                <div className="queue-pagination">
                  <span>
                    {page * PAGE_SIZE + 1}–
                    {Math.min((page + 1) * PAGE_SIZE, jobs.length)} /{" "}
                    {jobs.length} 个文件
                  </span>
                  <div>
                    <Button
                      aria-label="上一页"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      <ChevronLeft size={16} />
                    </Button>
                    <Button
                      aria-label="下一页"
                      disabled={page + 1 >= pageCount}
                      onClick={() => setPage(page + 1)}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {selected && (
              <section className="detail-card" aria-label="处理结果">
                <div className="detail-title">
                  <span className="eyebrow">当前文件</span>
                  <div className="detail-actions">
                    <Button
                      variant="ghost"
                      title="转换前 / 后的 ffprobe 参数"
                      disabled={!!state.tools?.busy}
                      onClick={async () => {
                        setDetails(null);
                        setDetailsError("");
                        setDetailsOpen(true);
                        try {
                          setDetails(
                            await call("details", {
                              id: selected.id,
                              media: true,
                            }),
                          );
                        } catch (e) {
                          setDetailsError((e as Error).message);
                        }
                      }}
                    >
                      <Info size={14} />
                      文件详情
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        run("reveal", {
                          path: selected.output || selected.path,
                        })
                      }
                    >
                      <FolderOpen size={14} />
                      打开位置
                    </Button>
                  </div>
                </div>
                <h3 title={selected.path}>{selected.name}</h3>
                {selected.meta ? (
                  <FileMeta meta={selected.meta} />
                ) : (
                  <p className="muted">
                    {selected.metaError || "正在读取文件信息…"}
                  </p>
                )}
                <p className="path-text" title={selected.path}>
                  {selected.path}
                </p>
                {selected.output && (
                  <p className="path-text" title={selected.output}>
                    → {selected.output}
                  </p>
                )}
                {selected.error && (
                  <p role="alert" className="inline-error">
                    {selected.error}
                  </p>
                )}
                {selected.log && (
                  <details
                    onToggle={(e) => {
                      // Updates carry only the log's tail; load the whole log.
                      if ((e.currentTarget as HTMLDetailsElement).open)
                        void window.encoder
                          .invoke("mediaLog", { id: selected.id })
                          .then((log) =>
                            setFullLog({ id: selected.id, log: log as string }),
                          )
                          .catch(() => {});
                    }}
                  >
                    <summary>实际命令与日志</summary>
                    <pre className="media-log" tabIndex={0}>
                      {fullLog?.id === selected.id &&
                      fullLog.log.length >= selected.log.length
                        ? fullLog.log
                        : selected.log}
                    </pre>
                  </details>
                )}
              </section>
            )}
          </section>
          <aside className="settings-column" aria-label="处理设置">
            <div className="section-heading">
              <div>
                <span className="eyebrow">输出控制</span>
                <h2>处理设置</h2>
              </div>
              <SlidersHorizontal size={20} className="muted" />
            </div>
            <div className="settings-panel">
              <form
                noValidate
                onSubmit={(e) => e.preventDefault()}
                className="settings-body"
              >
                <Select
                  id="media-operation"
                  label="操作"
                  value={o.operation}
                  disabled={locked}
                  options={Object.entries(OPERATIONS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(v) => set("operation", v)}
                />
                {o.operation !== "video" && (
                  <Select
                    id="media-format"
                    label="输出音频"
                    value={o.audioFormat}
                    disabled={locked}
                    options={Object.entries(FORMATS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(v) => set("audioFormat", v)}
                  />
                )}
                {o.operation !== "video" && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      disabled={
                        locked || !HIRES_FORMATS.includes(o.audioFormat)
                      }
                      checked={hiRes}
                      onChange={(e) => set("hiRes", e.target.checked)}
                    />
                    <span>
                      Hi-Res 音频（24-bit，低于 48 kHz 时升到 2 倍采样率）
                      <small className="hint hires-hint">
                        {!HIRES_FORMATS.includes(o.audioFormat)
                          ? "仅 WAV / FLAC 可用。"
                          : (hiResText(
                              o.operation === "merge"
                                ? selected?.audioMeta
                                : selected?.meta?.audio,
                            ) ||
                              (o.operation === "merge"
                                ? "选择替换音频后显示转换结果"
                                : "读取文件后显示转换结果")) +
                            (o.operation === "merge" ? "，输出 MKV。" : "。") +
                            "升采样不会提高音质。"}
                      </small>
                    </span>
                  </label>
                )}
                {o.operation !== "video" && (
                  <Select
                    id="media-fade"
                    label="音频淡入淡出"
                    value={String(o.audioFormat === "copy" ? 0 : o.audioFade)}
                    disabled={locked || o.audioFormat === "copy"}
                    options={fadeOptions}
                    hint={
                      o.audioFormat === "copy"
                        ? "复制原音轨时不能淡化。"
                        : fadeHint
                    }
                    onChange={(v) => set("audioFade", Number(v))}
                  />
                )}
                {o.operation !== "video" && LOSSY.includes(o.audioFormat) && (
                  <Select
                    id="media-bitrate"
                    label="音频码率"
                    value={String(bitrate)}
                    disabled={locked}
                    options={BITRATES.filter(
                      (b) => b <= MAX_BITRATE[o.audioFormat],
                    ).map((b) => ({
                      value: String(b),
                      label: b
                        ? `${b} kbps`
                        : "跟随源文件（无损源用 320 kbps）",
                    }))}
                    onChange={(v) => set("audioBitrate", Number(v))}
                  />
                )}
                {o.operation !== "audio" && (
                  <Select
                    id="media-container"
                    label="输出格式"
                    value={o.container}
                    disabled={locked}
                    options={Object.entries(CONTAINERS).map(
                      ([value, label]) => ({
                        value,
                        label,
                      }),
                    )}
                    onChange={(v) => set("container", v)}
                  />
                )}
                {o.operation === "merge" && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={o.autoAlign}
                      onChange={(e) => set("autoAlign", e.target.checked)}
                    />
                    <span>
                      选择音频后自动对齐
                      <small className="hint hires-hint">
                        以视频自带的声音为参考；对不上时不应用，可点队列里的波形按钮检视、微调。
                      </small>
                    </span>
                  </label>
                )}
                <Select
                  id="media-location"
                  label="输出位置"
                  value={o.location}
                  disabled={locked}
                  options={Object.entries(LOCATIONS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(v) => set("location", v)}
                />
                {o.location === "custom" && (
                  <Field id="media-output-dir" label="自定义文件夹">
                    <div className="path-picker">
                      <input
                        id="media-output-dir"
                        value={o.outputDir}
                        readOnly
                        title={o.outputDir}
                        placeholder="选择输出文件夹"
                      />
                      <Button disabled={locked} onClick={pickFolder}>
                        选择
                      </Button>
                    </div>
                  </Field>
                )}
                <p className="hint">
                  {o.operation === "audio"
                    ? "只输出第一条音频流。"
                    : `视频直接复制，不重新压制${o.container === "mp4" ? "；MP4 放不下时自动改用 MKV" : ""}。${o.operation === "merge" ? (o.audioFormat === "copy" ? "时长与视频相同，音频长了截掉。" : "时长与视频相同：音频长了截掉，短了补静音。") : ""}`}
                  已有文件不覆盖。
                </p>
                {error && (
                  <p role="alert" className="inline-error">
                    {error}
                  </p>
                )}
              </form>
            </div>
          </aside>
        </main>
      </div>
      <footer className="output-strip">
        <div className="output-icon">
          <ArrowDownToLine size={23} />
        </div>
        <div className="output-summary">
          <span className="eyebrow">预计结果</span>
          <strong>
            {readyJobs.length
              ? `${readyJobs.length} 个文件`
              : jobs.length
                ? "没有待处理文件"
                : "添加文件"}{" "}
            <ArrowRight size={15} />
            <span>{OPERATIONS[o.operation]}</span>
          </strong>
          <span className="output-facts">
            {o.operation !== "video" ? (
              <>
                音频 → {FORMATS[o.audioFormat]}
                {hiRes && " · Hi-Res 24-bit"}
                {LOSSY.includes(o.audioFormat) &&
                  ` · ${bitrate ? bitrate + " kbps" : "跟随源码率"}`}
              </>
            ) : (
              "音频 → 移除"
            )}
            {o.operation !== "audio" && (
              <>
                <i />
                视频 → 直接复制 · {o.container.toUpperCase()}
              </>
            )}
            <i /> 位置 → {LOCATIONS[o.location]}
          </span>
          <span className="output-path" title={preview}>
            {missingAudio
              ? "合并前请为每个视频选择替换音频"
              : preview || "添加文件后预览保存路径"}
          </span>
        </div>
        <div className="run-actions">
          <span>
            {state.running
              ? "正在处理"
              : `${readyJobs.length} 个待处理${doneCount ? ` · ${doneCount} 个已完成` : ""}`}
          </span>
          {state.running ? (
            <Button variant="stop" onClick={() => run("cancel")}>
              <Square size={16} />
              取消处理
            </Button>
          ) : (
            <Button
              variant="primary run"
              disabled={!ready}
              onClick={() =>
                run("mediaStart", {
                  operation: o.operation,
                  audioFormat: o.audioFormat,
                  audioBitrate: bitrate,
                  container: o.container,
                  hiRes,
                  audioFade: o.audioFormat === "copy" ? 0 : o.audioFade,
                  location: o.location,
                  outputDir: o.outputDir,
                })
              }
            >
              <Play size={17} />
              开始处理
            </Button>
          )}
        </div>
      </footer>
      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="文件详情"
        description="直接读取源文件与实际生成文件的 ffprobe 参数。"
        error={detailsError}
        wide
      >
        <MediaDetails details={details} media />
      </Modal>
      {(() => {
        const j = jobs.find((x) => x.id === alignId);
        const merge = o.operation === "merge";
        return (
          <AlignDialog
            open={!!j && (!merge || !!j.audioPath)}
            call={call}
            onClose={() => setAlignId("")}
            {...(merge
              ? {
                  // The added audio against the video's own sound.
                  targetPath: j?.audioPath,
                  fixedReference: j?.path,
                  initial:
                    j?.audioOffset !== undefined
                      ? { offset: j.audioOffset }
                      : undefined,
                  description: `把合并用的音频对齐到“${j?.name || ""}”自带的声音；合并时按这里的结果截取或补静音，时长仍与视频相同。`,
                  onApply: (a) =>
                    call("mediaSetAudioOffset", {
                      id: j!.id,
                      offset: a.offset,
                    }),
                  onClear:
                    j?.audioOffset !== undefined
                      ? () =>
                          call("mediaSetAudioOffset", {
                            id: j.id,
                            offset: null,
                          })
                      : undefined,
                }
              : {
                  targetPath: j?.path,
                  initial: j?.align && {
                    reference: j.align.reference,
                    offset: j.align.offset,
                    trim: !!j.align.length,
                  },
                  withTrim: true,
                  description: `把“${j?.name || ""}”的音频起点对齐到参考音频；提取音频时按这里的结果截取或补静音。`,
                  onApply: (a) =>
                    call("mediaSetAlign", { id: j!.id, align: a }),
                  onClear: j?.align
                    ? () => call("mediaSetAlign", { id: j.id, align: null })
                    : undefined,
                })}
          />
        );
      })()}
    </>
  );
}
