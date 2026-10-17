import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileAudio,
  FileVideo,
  Film,
  FolderOpen,
  LoaderCircle,
  Music,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { Button, Field, Select } from "./components";
import { formatSize } from "./presentation";
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
  aac: "AAC · 192 kbps",
  opus: "Opus · 192 kbps",
  copy: "直接复制原音频 · 不重新编码",
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
  shortest: boolean;
  location: string;
  outputDir: string;
};
const DEFAULT_OPTIONS: Options = {
  operation: "audio",
  audioFormat: "wav",
  shortest: true,
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

export function MediaTools({
  state,
  call,
  dropped,
}: {
  state: State;
  call: (action: string, payload?: unknown) => Promise<any>;
  dropped?: { paths: string[]; seq: number };
}) {
  const [o, setOptions] = useState<Options>(loadOptions),
    [selectedId, setSelectedId] = useState(""),
    [preview, setPreview] = useState(""),
    [error, setError] = useState("");
  const jobs = state.mediaJobs;
  const selected = jobs.find((j) => j.id === selectedId) || jobs[0];
  const locked =
    state.running ||
    state.detecting ||
    !!state.tools?.busy ||
    state.enhancements.busy;
  const readyJobs = jobs.filter((j) => j.status === "ready");
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const clearable = jobs.some((j) => ["done", "cancelled"].includes(j.status));
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
      current =
        (await run("mediaSetAudio", { id: target.id, path }))?.mediaJobs ||
        current;
    }
  }
  useEffect(() => {
    if (dropped?.paths.length && !locked) void accept(dropped.paths);
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
    if (file) await run("mediaSetAudio", { id: job.id, path: file });
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
            {formatSize(j.size)}
            {o.operation === "merge" &&
              (j.audioPath
                ? ` · 音频：${baseName(j.audioPath)}`
                : " · 尚未选择替换音频")}
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
              <ol className="job-list">{jobs.map(row)}</ol>
            )}
          </div>
          {selected && (
            <section className="detail-card" aria-label="处理结果">
              <div className="detail-title">
                <span className="eyebrow">当前文件</span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    run("reveal", { path: selected.output || selected.path })
                  }
                >
                  <FolderOpen size={14} />
                  打开位置
                </Button>
              </div>
              <h3 title={selected.path}>{selected.name}</h3>
              <div role="status">
                <p>{STATUS[selected.status] || selected.status}</p>
              </div>
              {selected.output && (
                <p className="path-text" title={selected.output}>
                  {selected.output}
                </p>
              )}
              {selected.error && (
                <p role="alert" className="inline-error">
                  {selected.error}
                </p>
              )}
              {selected.log && (
                <details>
                  <summary>实际命令与日志</summary>
                  <pre className="media-log" tabIndex={0}>
                    {selected.log}
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
              {o.operation === "merge" && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={o.shortest}
                    onChange={(e) => set("shortest", e.target.checked)}
                  />
                  按较短流结束（关闭则保留较长流时长）
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
                  : "第一条视频流直接复制、不重新压制，使用 MKV。"}
                文件名自动生成，已有文件不覆盖、自动编号；源文件保持不变。
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
            <span>
              {OPERATIONS[o.operation]}
              {o.operation !== "video"
                ? ` · ${FORMATS[o.audioFormat]}`
                : " · MKV"}
            </span>
          </strong>
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
                  shortest: o.shortest,
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
    </>
  );
}
