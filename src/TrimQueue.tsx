import {
  Copy,
  FileVideo,
  Film,
  FolderOpen,
  LoaderCircle,
  Plus,
  Scissors,
  X,
} from "lucide-react";
import { Button, useDragSort } from "./components";
import { clock, seconds } from "./trimCoordinates";
import type { TrimClip } from "./types";
import { errorMessage } from "./i18n";
export function TrimQueue({
  clips,
  selectedId,
  running,
  sortClip,
  onSelect,
  onDuplicate,
  onRemove,
  onAdd,
  onClear,
}: {
  clips: TrimClip[];
  selectedId?: string;
  running: boolean;
  sortClip: ReturnType<typeof useDragSort>;
  onSelect: (id: string) => void;
  onDuplicate: (id: string) => unknown;
  onRemove: (id: string) => unknown;
  onAdd: () => unknown;
  onClear: () => unknown;
}) {
  const row = (c: TrimClip, i: number) => (
    <li
      key={c.id}
      className={`job-row ${c.id === selectedId ? "selected" : ""}`}
      {...sortClip(c.id)}
    >
      <button
        className="job-select"
        onClick={() => onSelect(c.id)}
        aria-pressed={c.id === selectedId}
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
                : errorMessage(c.errorData || c.error || "")}
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
          disabled={running}
          onClick={() => onDuplicate(c.id)}
        >
          <Copy size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={`移除 ${c.name}`}
        title="从列表移除"
        disabled={running}
        onClick={() => onRemove(c.id)}
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
            片段 <span className="count">{clips.length}</span>
          </h2>
        </div>
        <Button variant="primary" disabled={running} onClick={onAdd}>
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
            disabled={!clips.length || running}
            onClick={onClear}
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
            <Button onClick={onAdd}>
              <FolderOpen size={17} />
              选择视频
            </Button>
            <small>H.264 · HEVC · ProRes · UtVideo · FFV1</small>
          </div>
        ) : (
          <ol className="job-list">{clips.map(row)}</ol>
        )}
      </div>
    </>
  );
}
