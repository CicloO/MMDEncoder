import {
  t,
  localeRuntime,
  errorMessage,
  stageMessage,
  notification,
} from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import type { ErrorData, MessageDescriptor } from "./i18n";
import {
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  FileVideo,
  FolderOpen,
  Info,
  LoaderCircle,
  Music,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button, Select, useDragSort, PAGE_SIZE } from "./components";
import { AlignDialog } from "./AlignDialog";
import { OutputFiles } from "./OutputFiles";
import { offsetText } from "./autoAlign";
import { FileMeta, metaSummary } from "./FileMeta";
import {
  formatDuration,
  statusLabel,
  targetLabel,
  videoName,
} from "./presentation";
import type { Job, Settings, State } from "./types";

// Frame rates a PNG sequence can play at (backend SEQUENCE_RATES).
const SEQUENCE_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
// Time left from the pace so far, once there is enough to go on.
const remaining = (j: Job) =>
  j.progress >= 2 && (j.elapsed || 0) >= 5
    ? t("queue.remaining", {
        time: formatDuration(
          ((j.elapsed || 0) * (100 - j.progress)) / j.progress,
        ),
      })
    : "";
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// 视频压制 page, left column: the queue, its pages, and the selected video.
export function EncodeQueue({
  engines,
  running,
  toolsBusy,
  jobs,
  job,
  s,
  page,
  setPage,
  pageCount,
  setSelected,
  drag,
  busy,
  doneCount,
  sortJob,
  add,
  call,
  action,
  pickAudio,
  persist,
  openLog,
  setDetails,
  setModal,
  setError,
  setTab,
  setFallback,
}: {
  engines: State["engines"];
  running: boolean;
  toolsBusy: boolean;
  jobs: Job[];
  job: Job | undefined;
  s: Settings;
  page: number;
  setPage: (page: number) => void;
  pageCount: number;
  setSelected: (id: string) => void;
  drag: boolean;
  busy: boolean;
  doneCount: number;
  sortJob: ReturnType<typeof useDragSort>;
  add: () => void;
  call: (
    action: string,
    payload?: unknown,
    message?: string | MessageDescriptor,
  ) => Promise<any>;
  action: (
    action: string,
    payload?: unknown,
    message?: string | MessageDescriptor,
  ) => void;
  pickAudio: (job: Job) => void;
  persist: (settings: Settings) => Promise<void>;
  openLog: (job: Job) => void;
  setDetails: (details: any) => void;
  setModal: (modal: string) => void;
  setError: (message: string | ErrorData) => void;
  setTab: (tab: string) => void;
  setFallback: (job: Job) => void;
}) {
  const renderMeta = () =>
    job?.meta ? (
      <FileMeta meta={job.meta} />
    ) : (
      <p className="muted">
        {job?.status === "probing" ? t("queue.reading") : t("queue.metaEmpty")}
      </p>
    );
  // The video whose replacement audio is being aligned (音频对齐).
  const [alignId, setAlignId] = useState("");
  const aligning = jobs.find((j) => j.id === alignId);
  return (
    <section className="queue-column" aria-label={t("queue.title")}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t("queue.workspace")}</span>
          <h2>
            {t("queue.title")}
            <span className="count">{localeRuntime.number(jobs.length)}</span>
          </h2>
        </div>
        <Button variant="primary" onClick={add} disabled={busy}>
          <Plus size={17} />
          {t("queue.add")}
        </Button>
      </div>
      <div className={`queue-panel ${drag ? "dragging" : ""}`}>
        <div className="queue-toolbar">
          <span>
            <FileVideo size={15} /> {t("queue.source")}
          </span>
          <Button
            variant="ghost"
            disabled={!doneCount}
            onClick={() =>
              action("clearCompleted", undefined, notification("VIDEO_CLEARED"))
            }
          >
            {t("queue.clear")}
          </Button>
        </div>
        {!jobs.length ? (
          <div className="empty-queue">
            <div className="film-emblem">
              <Film size={42} />
              <div className="frame-ticks" />
            </div>
            <h3>{t("queue.emptyTitle")}</h3>
            <p>
              {t("queue.emptyFiles")}
              <br />
              {t("queue.emptySequence")}
            </p>
            <Button onClick={add} disabled={busy}>
              <FolderOpen size={17} />
              {t("queue.pickFiles")}
            </Button>
            <small>{t("queue.formats")}</small>
          </div>
        ) : (
          <ol className="job-list">
            {jobs
              .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
              .map((j, i) => (
                <li
                  key={j.id}
                  className={`job-row ${j.id === job?.id ? "selected" : ""}`}
                  {...sortJob(j.id)}
                >
                  <button
                    className="job-select"
                    onClick={() => setSelected(j.id)}
                    aria-pressed={j.id === job?.id}
                  >
                    <span
                      className={`file-tile ${j.status === "done" ? "complete" : ""}`}
                    >
                      {j.status === "done" ? (
                        <Check size={22} />
                      ) : (
                        <FileVideo size={23} />
                      )}
                      <small>
                        {j.name.split(".").pop()?.slice(0, 5).toUpperCase()}
                      </small>
                    </span>
                    <span className="job-copy">
                      <strong title={videoName(j)}>{videoName(j)}</strong>
                      <span className="job-sub">
                        {j.meta ? metaSummary(j.meta) : t("queue.metaReading")}
                        {j.audioPath &&
                          (j.audioOffset !== undefined
                            ? t("queue.audioAligned", {
                                file: baseName(j.audioPath),
                                offset: offsetText(j.audioOffset),
                              })
                            : t("queue.audioNamed", {
                                file: baseName(j.audioPath),
                              }))}
                      </span>
                      {(() => {
                        const own = j.ownSettings;
                        return (
                          own && (
                            <span
                              className="job-target"
                              title={
                                own.presetName
                                  ? t("queue.ownPreset", {
                                      name: own.presetName,
                                    })
                                  : t("video.own")
                              }
                            >
                              → {targetLabel(own, engines)}
                            </span>
                          )
                        );
                      })()}
                      <span className={`job-status ${j.status}`}>
                        {j.status === "encoding" && (
                          <LoaderCircle size={12} className="spin" />
                        )}
                        {statusLabel(j.status)}
                        {j.status === "encoding"
                          ? t("queue.progress", {
                              progress: localeRuntime.number(
                                Math.round(j.progress),
                              ),
                              stage: stageMessage(
                                j.stage || {
                                  stage: "video_encoding",
                                  params: {},
                                },
                              ),
                              elapsed: formatDuration(j.elapsed || 0),
                              remaining: remaining(j),
                            })
                          : j.status === "done" && j.elapsed
                            ? t("queue.completedTime", {
                                time:
                                  j.elapsed < 1
                                    ? t("queue.lessThanSecond")
                                    : formatDuration(j.elapsed),
                              })
                            : ""}
                        {!["encoding", "ready", "probing", "invalid"].includes(
                          j.status,
                        ) && (
                          <OutputFiles
                            output={j.output}
                            maskOutput={j.maskOutput}
                          />
                        )}
                      </span>
                    </span>
                  </button>
                  {!["encoding", "done"].includes(j.status) && (
                    <Button
                      variant="ghost icon"
                      aria-label={t("queue.pickAudio", { name: videoName(j) })}
                      title={t("video.replacementAudio")}
                      disabled={running}
                      onClick={() => pickAudio(j)}
                    >
                      <Music size={16} />
                    </Button>
                  )}
                  {/* As on the media page: the alignment of a chosen audio. */}
                  {!["encoding", "done"].includes(j.status) && j.audioPath && (
                    <Button
                      variant={`ghost icon${j.audioOffset !== undefined ? " active" : ""}`}
                      aria-label={t("queue.alignAudio", { name: videoName(j) })}
                      title={
                        j.meta?.audio
                          ? t("queue.alignHint")
                          : t("queue.noReference")
                      }
                      disabled={running || !j.meta?.audio}
                      onClick={() => setAlignId(j.id)}
                    >
                      <AudioLines size={16} />
                    </Button>
                  )}
                  {["done", "cancelled"].includes(j.status) && (
                    <Button
                      variant="ghost icon"
                      aria-label={t("queue.requeue", { name: videoName(j) })}
                      title={t("queue.requeueHint")}
                      disabled={running}
                      onClick={() =>
                        action(
                          "requeue",
                          { id: j.id },
                          notification("VIDEO_REQUEUED"),
                        )
                      }
                    >
                      <RefreshCw size={16} />
                    </Button>
                  )}
                  <Button
                    variant="ghost icon"
                    aria-label={t("queue.remove", { name: videoName(j) })}
                    title={t("queue.removeHint")}
                    disabled={j.status === "encoding" || running}
                    onClick={() => action("remove", { id: j.id })}
                  >
                    <X size={16} />
                  </Button>
                  <span className="row-index">
                    {String(page * PAGE_SIZE + i + 1).padStart(2, "0")}
                  </span>
                  {j.status === "encoding" && (
                    <progress
                      max={100}
                      value={j.progress}
                      aria-label={t("queue.progressLabel", {
                        name: videoName(j),
                      })}
                    />
                  )}
                </li>
              ))}
          </ol>
        )}
        {jobs.length > 0 && (
          <div className="queue-pagination">
            <span>
              {t("queue.pageCount", {
                count: jobs.length,
                from: localeRuntime.number(page * PAGE_SIZE + 1),
                to: localeRuntime.number(
                  Math.min((page + 1) * PAGE_SIZE, jobs.length),
                ),
                total: localeRuntime.number(jobs.length),
              })}
            </span>
            <div>
              <Button
                aria-label={t("queue.previous")}
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                aria-label={t("queue.next")}
                disabled={page + 1 >= pageCount}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>
      {job && (
        <section className="detail-card">
          <div className="detail-title">
            <span className="eyebrow">{t("queue.current")}</span>
            <div className="detail-actions">
              <Button
                variant="ghost"
                title={t("queue.detailsHint")}
                disabled={toolsBusy}
                onClick={async () => {
                  setDetails(null);
                  setModal("details");
                  try {
                    setDetails(await call("details", { id: job.id }));
                  } catch (e) {
                    setError(serializeError(e));
                  }
                }}
              >
                <Info size={14} />
                {t("queue.details")}
              </Button>
              <Button
                variant="ghost"
                // Before encoding: the source; once written: the result.
                title={
                  job.output ? t("queue.revealOutput") : t("queue.revealSource")
                }
                onClick={() =>
                  action("reveal", { path: job.output || job.path })
                }
              >
                <FolderOpen size={14} />
                {t("queue.reveal")}
              </Button>
            </div>
          </div>
          <h3 title={videoName(job)}>{videoName(job)}</h3>
          {renderMeta()}
          {job.sequence && (
            // Pictures carry no frame rate: the user says how fast they play.
            <div className="sequence-rate">
              <Select
                id="sequence-fps"
                label={t("queue.sequenceFPS")}
                value={String(job.sequence.fps)}
                disabled={
                  running ||
                  ![
                    "ready",
                    "invalid",
                    "done",
                    "failed",
                    "cancelled",
                    "partial",
                  ].includes(job.status)
                }
                hint={t("queue.sequenceHint", {
                  count: job.sequence.count,
                  countText: localeRuntime.number(job.sequence.count),
                })}
                options={SEQUENCE_RATES.map((r) => ({
                  value: String(r),
                  label: t("video.fpsOption", {
                    fps: localeRuntime.number(r, {
                      useGrouping: false,
                      maximumFractionDigits: 3,
                    }),
                  }),
                }))}
                onChange={(v) =>
                  action("setSequenceFps", {
                    id: job.id,
                    fps: Number(v),
                  })
                }
              />
            </div>
          )}
          <p
            className="path-text"
            title={job.sequence ? job.sequence.pattern : job.path}
          >
            {job.sequence ? job.sequence.pattern.replace(/%%/g, "%") : job.path}
          </p>
          {job.audioPath && (
            <div className="replace-audio">
              <Music size={14} />
              <span className="path-text" title={job.audioPath}>
                {job.audioOffset !== undefined
                  ? t("queue.replacementAligned", {
                      path: job.audioPath,
                      offset: offsetText(job.audioOffset),
                    })
                  : t("queue.replacementNamed", { path: job.audioPath })}
              </span>
              <Button
                variant="ghost"
                disabled={running || !job.meta?.audio}
                title={
                  job.meta?.audio
                    ? t("queue.alignSelectedHint")
                    : t("queue.noReference")
                }
                onClick={() => setAlignId(job.id)}
              >
                <AudioLines size={14} />
                {t("queue.align")}
              </Button>
              <Button
                variant="ghost"
                disabled={running}
                onClick={() => action("setAudio", { id: job.id, path: "" })}
              >
                {t("queue.originalAudio")}
              </Button>
            </div>
          )}
          {job.error && (
            <div className="inline-error" role="alert">
              {errorMessage(job.errorData || job.error)}
            </div>
          )}
          {["failed", "partial", "cancelled", "invalid"].includes(
            job.status,
          ) && (
            <div className="recovery">
              <Button onClick={() => openLog(job)}>
                <Terminal size={14} />
                {t("queue.logs")}
              </Button>
              <Button
                onClick={() => {
                  setTab("encoding");
                  document.getElementById("encoder")?.focus();
                }}
              >
                {t("queue.adjust")}
              </Button>
              <Button
                disabled={running}
                onClick={() => {
                  if (s)
                    persist(s)
                      .then(() => call("retry", { id: job.id }))
                      .catch((e) => setError(serializeError(e)));
                }}
              >
                {t("queue.retry")}
              </Button>
              {job.status === "failed" &&
                job.softwareRetry !== false &&
                /nvenc|qsv|amf/.test(job.settings?.encoder || s.encoder) && (
                  <Button disabled={running} onClick={() => setFallback(job)}>
                    {t("queue.softwareRetry")}
                  </Button>
                )}
            </div>
          )}
        </section>
      )}
      <div className="workflow-note">
        <span className="note-icon">
          <Info size={17} />
        </span>
        <div>
          <strong>{t("queue.noteTitle")}</strong>
          <p>{t("queue.note")}</p>
        </div>
      </div>
      <AlignDialog
        open={!!aligning?.audioPath}
        call={call}
        onClose={() => setAlignId("")}
        targetPath={aligning?.audioPath}
        fixedReference={aligning?.path}
        initial={
          aligning?.audioOffset !== undefined
            ? { offset: aligning.audioOffset }
            : undefined
        }
        description={t("queue.alignDescription", {
          name: aligning ? videoName(aligning) : "",
        })}
        onApply={(a) =>
          call("setAudioOffset", { id: aligning!.id, offset: a.offset })
        }
        onClear={
          aligning?.audioOffset !== undefined
            ? () => call("setAudioOffset", { id: aligning.id, offset: null })
            : undefined
        }
      />
    </section>
  );
}
