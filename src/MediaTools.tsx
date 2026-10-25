import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  FolderOpen,
  Info,
  Play,
  Square,
} from "lucide-react";
import { Button, Modal, useDragSort, PAGE_SIZE } from "./components";
import { MediaDetails } from "./MediaDetails";
import { AlignDialog } from "./AlignDialog";
import { autoAlign } from "./autoAlign";
import { FileMeta } from "./FileMeta";
import { t, errorMessage } from "./i18n";
import type { MediaJob } from "./types";
import { MediaQueue } from "./MediaQueue";
import { MediaSettings } from "./MediaSettings";
import {
  AUDIO_EXT,
  OPERATIONS,
  FORMATS,
  LOSSY,
  MAX_BITRATE,
  LOCATIONS,
  OPTIONS_KEY,
  loadOptions,
  HIRES_FORMATS,
  type Options,
} from "./mediaOptions";

export function MediaTools({
  jobs,
  running,
  detecting,
  toolsBusy,
  enhancementsBusy,
  call,
  dropped,
  onDropHandled,
}: {
  jobs: MediaJob[];
  running: boolean;
  detecting: boolean;
  toolsBusy: boolean;
  enhancementsBusy: boolean;
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
    [detailsError, setDetailsError] = useState<unknown>(null),
    // The file whose 音频对齐 dialog is open.
    [alignId, setAlignId] = useState("");
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
  const locked = running || detecting || toolsBusy || enhancementsBusy;
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

  return (
    <>
      <div className="page-scroll">
        <main className="workspace">
          <section className="queue-column" aria-label="媒体队列">
            <MediaQueue
              jobs={jobs}
              selectedId={selected?.id}
              operation={o.operation}
              running={running}
              locked={locked}
              clearable={clearable}
              page={page}
              pageCount={pageCount}
              sortJob={sortJob}
              onSelect={setSelectedId}
              onPage={setPage}
              onPickFiles={pickFiles}
              onPickAudio={pickAudio}
              onAlign={setAlignId}
              onRequeue={(id) => run("mediaRequeue", { id })}
              onRemove={(id) => run("mediaRemove", { id })}
              onClear={() => run("mediaClearCompleted")}
            />
            {selected && (
              <section className="detail-card" aria-label="处理结果">
                <div className="detail-title">
                  <span className="eyebrow">当前文件</span>
                  <div className="detail-actions">
                    <Button
                      variant="ghost"
                      title="转换前 / 后的 ffprobe 参数"
                      disabled={toolsBusy}
                      onClick={async () => {
                        setDetails(null);
                        setDetailsError(null);
                        setDetailsOpen(true);
                        try {
                          setDetails(
                            await call("details", {
                              id: selected.id,
                              media: true,
                            }),
                          );
                        } catch (e) {
                          setDetailsError(e);
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
          <MediaSettings
            o={o}
            selected={selected}
            locked={locked}
            hiRes={hiRes}
            bitrate={bitrate}
            error={error}
            set={set}
            pickFolder={pickFolder}
          />
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
            {running
              ? "正在处理"
              : `${readyJobs.length} 个待处理${doneCount ? ` · ${doneCount} 个已完成` : ""}`}
          </span>
          {running ? (
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
        title={t("details.title")}
        description={t("details.description")}
        error={detailsError ? errorMessage(detailsError) : ""}
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
