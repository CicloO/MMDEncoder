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
import { createMediaAudioReplacement } from "./audioReplacement";
import { useAlignmentTasks } from "./useAlignmentTasks";
import { FileMeta } from "./FileMeta";
import {
  t,
  localeRuntime,
  errorMessage,
  summaryMessage,
  type ErrorData,
  type MessageDescriptor,
} from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import { invoke } from "./ipc";
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
    [error, setError] = useState<
      ErrorData | { notice: MessageDescriptor } | null
    >(null),
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
  const audioAlignment = useAlignmentTasks(
    "media",
    jobs
      .filter((job) => job.status === "ready")
      .map((job) => ({ id: job.id, target: job.audioPath })),
  );
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
    setError(null);
    try {
      return await call(action, payload);
    } catch (e) {
      setError(serializeError(e));
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
        setError({
          code: "MEDIA_PAIR_REQUIRED",
          params: {},
          message: t("error.MEDIA_PAIR_REQUIRED"),
        });
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
  const { setAudio } = createMediaAudioReplacement({
    run,
    call,
    notify: (notice) => setError({ notice }),
    tasks: audioAlignment,
    actions: { replace: "mediaSetAudio", offset: "mediaSetAudioOffset" },
  });
  async function pickFolder() {
    const dir = await run("pickDirectory", {
      title: t("media.outputDirTitle"),
    });
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
          <section className="queue-column" aria-label={t("media.queue")}>
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
              aligningIds={audioAlignment.active}
              onAlign={(id) => {
                void audioAlignment.cancel(id);
                setAlignId(id);
              }}
              onRequeue={(id) => run("mediaRequeue", { id })}
              onRemove={(id) => run("mediaRemove", { id })}
              onClear={() => run("mediaClearCompleted")}
            />
            {selected && (
              <section className="detail-card" aria-label={t("media.result")}>
                <div className="detail-title">
                  <span className="eyebrow">{t("media.currentFile")}</span>
                  <div className="detail-actions">
                    <Button
                      variant="ghost"
                      title={t("media.detailsHint")}
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
                      {t("details.title")}
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
                      {t("media.openLocation")}
                    </Button>
                  </div>
                </div>
                <h3 title={selected.path}>{selected.name}</h3>
                {selected.meta ? (
                  <FileMeta meta={selected.meta} />
                ) : (
                  <p className="muted">
                    {selected.metaErrorData
                      ? errorMessage(selected.metaErrorData)
                      : selected.metaError || t("media.readingDetail")}
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
                {(selected.errorData || selected.error) && (
                  <p role="alert" className="inline-error">
                    {selected.errorData
                      ? errorMessage(selected.errorData)
                      : selected.error}
                  </p>
                )}
                {selected.log && (
                  <details
                    onToggle={(e) => {
                      // Updates carry only the log's tail; load the whole log.
                      if ((e.currentTarget as HTMLDetailsElement).open)
                        void invoke("mediaLog", { id: selected.id })
                          .then((log) =>
                            setFullLog({ id: selected.id, log: log as string }),
                          )
                          .catch(() => {});
                    }}
                  >
                    <summary>{t("media.commandLog")}</summary>
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
            error={
              error
                ? "notice" in error
                  ? summaryMessage(error.notice)
                  : errorMessage(error)
                : ""
            }
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
          <span className="eyebrow">{t("media.expected")}</span>
          <strong>
            {readyJobs.length
              ? t("media.files", {
                  count: readyJobs.length,
                  quantity: localeRuntime.number(readyJobs.length),
                })
              : jobs.length
                ? t("media.nonePending")
                : t("media.addFile")}{" "}
            <ArrowRight size={15} />
            <span>{OPERATIONS()[o.operation]}</span>
          </strong>
          <span className="output-facts">
            {o.operation !== "video" ? (
              <>
                {t("media.audioTarget", { format: FORMATS()[o.audioFormat] })}
                {hiRes && t("media.hiresFact")}
                {LOSSY.includes(o.audioFormat) &&
                  (bitrate
                    ? t("media.bitrateFact", {
                        rate: localeRuntime.number(bitrate, {
                          useGrouping: false,
                        }),
                      })
                    : t("media.bitrateSourceFact"))}
              </>
            ) : (
              t("media.audioRemoved")
            )}
            {o.operation !== "audio" && (
              <>
                <i />
                {t("media.videoTarget", {
                  container: o.container.toUpperCase(),
                })}
              </>
            )}
            <i />{" "}
            {t("media.outputLocation", { location: LOCATIONS()[o.location] })}
          </span>
          <span className="output-path" title={preview}>
            {missingAudio
              ? t("media.mergeNeedsAudio")
              : preview || t("media.previewEmpty")}
          </span>
        </div>
        <div className="run-actions">
          <span>
            {running
              ? t("media.processing")
              : doneCount
                ? t("media.pendingAndDone", {
                    pending: t("media.pending", {
                      count: readyJobs.length,
                      quantity: localeRuntime.number(readyJobs.length),
                    }),
                    done: t("media.completed", {
                      count: doneCount,
                      quantity: localeRuntime.number(doneCount),
                    }),
                  })
                : t("media.pending", {
                    count: readyJobs.length,
                    quantity: localeRuntime.number(readyJobs.length),
                  })}
          </span>
          {running ? (
            <Button variant="stop" onClick={() => run("cancel")}>
              <Square size={16} />
              {t("media.cancel")}
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
              {t("media.start")}
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
            frameShift
            onClose={() => setAlignId("")}
            {...(merge
              ? {
                  // The added audio against the video's own sound.
                  targetPath: j?.audioPath,
                  fixedReference: j?.path,
                  fixedTiming: j?.meta && {
                    fpsText: j.meta.fpsText || String(j.meta.fps || "30/1"),
                    fallback: !!j.meta.audioOnly,
                    hasVideo: !j.meta.audioOnly,
                    hasAudio: !!j.meta.audio,
                    duration: j.meta.videoDuration ?? j.meta.duration,
                  },
                  initial:
                    j &&
                    (j.audioOffset !== undefined ||
                      j.audioShiftFrames !== undefined)
                      ? {
                          offset: j.audioOffset || 0,
                          shiftFrames: j.audioShiftFrames,
                        }
                      : undefined,
                  description: t("media.alignMergeDescription", {
                    name: j?.name || "",
                  }),
                  onApply: (a) =>
                    call("mediaSetAudioOffset", {
                      id: j!.id,
                      offset: a.offset,
                      shiftFrames: a.shiftFrames,
                      expectedAudioPath: j!.audioPath,
                    }),
                  onClear:
                    j &&
                    (j.audioOffset !== undefined ||
                      j.audioShiftFrames !== undefined)
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
                    shiftFrames: j.align.shiftFrames,
                    trim: !!j.align.length,
                  },
                  withTrim: true,
                  description: t("media.alignExtractDescription", {
                    name: j?.name || "",
                  }),
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
