import { t, localeRuntime, errorMessage } from "./i18n";
import {
  Check,
  FileAudio,
  FileVideo,
  Film,
  FolderOpen,
  LoaderCircle,
  Music,
  Plus,
  RefreshCw,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button, PAGE_SIZE, useDragSort } from "./components";
import { OutputFiles } from "./OutputFiles";
import { AlignmentIcon } from "./AlignmentIcon";
import { formatDuration } from "./presentation";
import { metaSummary } from "./FileMeta";
import { frameShiftText, offsetText } from "./autoAlign";
import { AUDIO_EXT, STATUS, baseName } from "./mediaOptions";
import type { MediaJob } from "./types";
export function MediaQueue({
  jobs,
  selectedId,
  operation,
  running,
  locked,
  clearable,
  page,
  pageCount,
  sortJob,
  onSelect,
  onPage,
  onPickFiles,
  onPickAudio,
  onClearAudio,
  onClearAlignment,
  onAlign,
  aligningIds = new Set<string>(),
  onRequeue,
  onRemove,
  onClear,
}: {
  jobs: MediaJob[];
  selectedId?: string;
  operation: string;
  running: boolean;
  locked: boolean;
  clearable: boolean;
  page: number;
  pageCount: number;
  sortJob: ReturnType<typeof useDragSort>;
  onSelect: (id: string) => void;
  onPage: (page: number) => void;
  onPickFiles: () => void;
  onPickAudio: (job: MediaJob) => void;
  onClearAudio?: (id: string) => void;
  onClearAlignment?: (id: string) => void;
  onAlign: (id: string) => void;
  aligningIds?: ReadonlySet<string>;
  onRequeue: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const jobError = (j: MediaJob) =>
    j.errorData ? errorMessage(j.errorData) : j.error || "";
  const row = (j: MediaJob) => (
    <li
      key={j.id}
      className={`job-row ${j.id === selectedId ? "selected" : ""}`}
      {...sortJob(j.id)}
    >
      <button
        className="job-select"
        onClick={() => onSelect(j.id)}
        aria-pressed={j.id === selectedId}
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
            {j.meta
              ? metaSummary(j.meta)
              : j.metaErrorData
                ? errorMessage(j.metaErrorData)
                : j.metaError || t("media.reading")}
            {operation === "merge" &&
              (j.audioPath
                ? t(
                    j.audioOffset !== undefined
                      ? "media.attachedAlignedAudio"
                      : "media.attachedAudio",
                    {
                      name: baseName(j.audioPath),
                      offset: offsetText(j.audioOffset || 0),
                    },
                  )
                : t("media.audioMissing"))}
            {operation === "merge" &&
              j.audioPath &&
              frameShiftText(j.audioShiftFrames)}
            {operation === "audio" &&
              j.align &&
              t(
                j.align.length
                  ? "media.extractionTrimmed"
                  : "media.extractionAligned",
                { offset: offsetText(j.align.offset) },
              )}
            {operation === "audio" &&
              j.align &&
              frameShiftText(j.align.shiftFrames)}
          </span>
          <span
            className={`job-status ${j.status}`}
            title={jobError(j) || undefined}
          >
            {j.status === "running" && (
              <LoaderCircle size={12} className="spin" />
            )}
            {STATUS()[j.status] || j.status}
            {j.status === "done" && j.elapsed !== undefined
              ? t("queue.completedTime", {
                  time:
                    j.elapsed < 1
                      ? t("queue.lessThanSecond")
                      : formatDuration(j.elapsed),
                })
              : ""}
            {j.status === "done" && <OutputFiles output={j.output} />}
            {j.status === "failed" && jobError(j)
              ? t("media.failureDetail", { detail: jobError(j).slice(0, 60) })
              : ""}
          </span>
        </span>
      </button>
      {operation === "merge" && j.status === "ready" && (
        <Button
          variant={`ghost icon${j.audioPath ? " active" : ""}`}
          aria-label={t("media.pickAudio", { name: j.name })}
          title={t("queue.replaceAudioHint")}
          aria-keyshortcuts="Shift+F10"
          onContextMenu={(event) => {
            event.preventDefault();
            if (!locked) onClearAudio?.(j.id);
          }}
          disabled={locked}
          onClick={() => onPickAudio(j)}
        >
          <Music size={16} />
        </Button>
      )}
      {operation === "merge" && j.status === "ready" && j.audioPath && (
        <Button
          variant={`ghost icon${j.audioOffset !== undefined ? " active" : ""}`}
          aria-label={t("media.alignMerge", { name: j.name })}
          title={t("queue.alignCancelHint")}
          aria-keyshortcuts="Shift+F10"
          onContextMenu={(event) => {
            event.preventDefault();
            if (!locked) onClearAlignment?.(j.id);
          }}
          disabled={locked}
          onClick={() => onAlign(j.id)}
          aria-busy={aligningIds.has(j.id)}
        >
          <AlignmentIcon active={aligningIds.has(j.id)} />
        </Button>
      )}
      {operation === "audio" && j.status === "ready" && (
        <Button
          variant={`ghost icon${j.align ? " active" : ""}`}
          aria-label={t("media.alignAudio", { name: j.name })}
          title={t("queue.alignCancelHint")}
          aria-keyshortcuts="Shift+F10"
          onContextMenu={(event) => {
            event.preventDefault();
            if (!locked) onClearAlignment?.(j.id);
          }}
          disabled={locked}
          onClick={() => onAlign(j.id)}
        >
          <AlignmentIcon active={aligningIds.has(j.id)} />
        </Button>
      )}
      {["done", "cancelled", "failed"].includes(j.status) && (
        <Button
          variant="ghost icon"
          aria-label={t("media.requeue", { name: j.name })}
          title={t("media.requeueTitle")}
          disabled={running}
          onClick={() => onRequeue(j.id)}
        >
          <RefreshCw size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={t("media.remove", { name: j.name })}
        title={t("media.removeTitle")}
        disabled={j.status === "running"}
        onClick={() => onRemove(j.id)}
      >
        <X size={16} />
      </Button>
    </li>
  );

  return (
    <>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t("media.workspace")}</span>
          <h2>
            {t("media.queue")}{" "}
            <span className="count">{localeRuntime.number(jobs.length)}</span>
          </h2>
        </div>
        <Button variant="primary" disabled={locked} onClick={onPickFiles}>
          <Plus size={17} />
          {t("media.addFiles")}
        </Button>
      </div>
      <div className="queue-panel">
        <div className="queue-toolbar">
          <span>
            <FileVideo size={15} /> {t("media.sourceFile")}
          </span>
          <Button
            variant="ghost"
            disabled={!clearable || running}
            onClick={() => onClear()}
          >
            {t("media.clearCompleted")}
          </Button>
        </div>
        {!jobs.length ? (
          <div className="empty-queue">
            <div className="film-emblem">
              <Film size={42} />
              <div className="frame-ticks" />
            </div>
            <h3>{t("media.emptyTitle")}</h3>
            <p>
              {t("media.emptyIntro")}
              <br />
              {t("media.emptyMerge")}
            </p>
            <Button disabled={locked} onClick={onPickFiles}>
              <FolderOpen size={17} />
              {t("media.pickFiles")}
            </Button>
            <small>{t("media.extensions")}</small>
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
              {t("media.pagination", {
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
                aria-label={t("media.previous")}
                disabled={page === 0}
                onClick={() => onPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                aria-label={t("media.next")}
                disabled={page + 1 >= pageCount}
                onClick={() => onPage(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
