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
import { t as text, localeRuntime, errorMessage } from "./i18n";
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
  const n = (v: number | undefined) => localeRuntime.number(v ?? 0);
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
          <small>{n(i + 1)}</small>
        </span>
        <span className="job-copy">
          <strong title={c.path}>{c.name}</strong>
          <span className="job-sub">
            {c.status === "ready"
              ? text("trim.rangeSummary", {
                  from: n(c.from),
                  to: c.to === c.frames ? text("trim.end") : n(c.to),
                  count: (c.to ?? 0) - (c.from ?? 0),
                  value: n((c.to ?? 0) - (c.from ?? 0)),
                  time: clock(seconds(c, (c.to ?? 0) - (c.from ?? 0))),
                })
              : c.status === "indexing"
                ? text("trim.indexing")
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
                ? text("trim.emptyRangeSnapped")
                : text("trim.videoFacts", {
                    codec: c.codec?.toUpperCase() || "",
                    width: n(c.width),
                    height: n(c.height),
                    cuts:
                      c.cuts === "all"
                        ? text("trim.allFrames")
                        : text("trim.cutCount", {
                            count: (c.cuts as number[]).length,
                            value: n((c.cuts as number[]).length),
                          }),
                  })
              : c.status === "indexing"
                ? text("trim.reading")
                : text("trim.invalid")}
          </span>
        </span>
      </button>
      {c.status === "ready" && (
        <Button
          variant="ghost icon"
          aria-label={text("trim.duplicate", { name: c.name })}
          title={text("trim.duplicateHint")}
          disabled={running}
          onClick={() => onDuplicate(c.id)}
        >
          <Copy size={16} />
        </Button>
      )}
      <Button
        variant="ghost icon"
        aria-label={text("trim.remove", { name: c.name })}
        title={text("trim.removeHint")}
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
          <span className="eyebrow">{text("trim.workspace")}</span>
          <h2>
            {text("trim.clips")}{" "}
            <span className="count">{n(clips.length)}</span>
          </h2>
        </div>
        <Button variant="primary" disabled={running} onClick={onAdd}>
          <Plus size={17} />
          {text("trim.add")}
        </Button>
      </div>
      <div className="queue-panel">
        <div className="queue-toolbar">
          <span>
            <Scissors size={15} /> {text("trim.joinOrder")}
          </span>
          <Button
            variant="ghost"
            disabled={!clips.length || running}
            onClick={onClear}
          >
            {text("trim.clear")}
          </Button>
        </div>
        {!clips.length ? (
          <div className="empty-queue">
            <div className="film-emblem">
              <Film size={42} />
              <div className="frame-ticks" />
            </div>
            <h3>{text("trim.emptyTitle")}</h3>
            <p>
              {text("trim.emptyCopy")}
              <br />
              {text("trim.emptyRange")}
            </p>
            <Button onClick={onAdd}>
              <FolderOpen size={17} />
              {text("trim.chooseVideo")}
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
