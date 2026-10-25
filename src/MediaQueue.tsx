import {
  AudioLines,
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
import { metaSummary } from "./FileMeta";
import { offsetText } from "./autoAlign";
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
  onAlign,
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
  onAlign: (id: string) => void;
  onRequeue: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
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
            {j.meta ? metaSummary(j.meta) : j.metaError || "正在读取文件信息"}
            {operation === "merge" &&
              (j.audioPath
                ? ` · 音频：${baseName(j.audioPath)}${j.audioOffset !== undefined ? " · 对齐 " + offsetText(j.audioOffset) : ""}`
                : " · 尚未选择替换音频")}
            {operation === "audio" &&
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
      {operation === "merge" && j.status === "ready" && (
        <Button
          variant="ghost icon"
          aria-label={`为 ${j.name} 选择音频`}
          title="选择替换音频"
          disabled={locked}
          onClick={() => onPickAudio(j)}
        >
          <Music size={16} />
        </Button>
      )}
      {operation === "merge" && j.status === "ready" && j.audioPath && (
        <Button
          variant={`ghost icon${j.audioOffset !== undefined ? " active" : ""}`}
          aria-label={`对齐 ${j.name} 的合并音频`}
          title="音频对齐：以视频自带的声音为参考检视、微调"
          disabled={locked}
          onClick={() => onAlign(j.id)}
        >
          <AudioLines size={16} />
        </Button>
      )}
      {operation === "audio" && j.status === "ready" && (
        <Button
          variant={`ghost icon${j.align ? " active" : ""}`}
          aria-label={`对齐 ${j.name} 的音频`}
          title={
            j.align ? "音频对齐（已对齐）" : "音频对齐：按参考音频对齐起点"
          }
          disabled={locked}
          onClick={() => onAlign(j.id)}
        >
          <AudioLines size={16} />
        </Button>
      )}
      {["done", "cancelled", "failed"].includes(j.status) && (
        <Button
          variant="ghost icon"
          aria-label={`重新导出 ${j.name}`}
          title="重新导出：放回队列，按当前设置处理，已有文件不覆盖"
          disabled={running}
          onClick={() => onRequeue(j.id)}
        >
          <RefreshCw size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={`移除 ${j.name}`}
        title="从列表移除"
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
          <span className="eyebrow">工作区</span>
          <h2>
            媒体队列 <span className="count">{jobs.length}</span>
          </h2>
        </div>
        <Button variant="primary" disabled={locked} onClick={onPickFiles}>
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
            disabled={!clearable || running}
            onClick={() => onClear()}
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
            <Button disabled={locked} onClick={onPickFiles}>
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
              {Math.min((page + 1) * PAGE_SIZE, jobs.length)} / {jobs.length}{" "}
              个文件
            </span>
            <div>
              <Button
                aria-label="上一页"
                disabled={page === 0}
                onClick={() => onPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                aria-label="下一页"
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
