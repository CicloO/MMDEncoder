import {
  ArrowDownToLine,
  ArrowRight,
  FolderOpen,
  Square,
  Play,
} from "lucide-react";
import { Button } from "./components";
import { clock } from "./trimCoordinates";
import { LOCATIONS } from "./trimOptions";
import { OutputFiles } from "./OutputFiles";
import { formatDuration } from "./presentation";
import {
  t as text,
  localeRuntime,
  type MessageKey,
  stageMessage,
  type StageDescriptor,
} from "./i18n";
export function TrimFooter({
  clipCount,
  totalFrames,
  totalSeconds,
  audioMode,
  audioCodec,
  location,
  running,
  stage,
  progress,
  output,
  elapsed,
  canExport,
  onReveal,
  onCancel,
  onExport,
}: {
  clipCount: number;
  totalFrames: number;
  totalSeconds: number;
  audioMode: string;
  audioCodec: string;
  location: string;
  running: boolean;
  stage?: StageDescriptor | string;
  progress: number;
  output?: string;
  elapsed?: number;
  canExport: boolean;
  onReveal: () => unknown;
  onCancel: () => unknown;
  onExport: () => unknown;
}) {
  const n = (v: number) => localeRuntime.number(v);
  const completed =
    !running &&
    typeof stage === "object" &&
    stage.stage === "trim_completed" &&
    !!output;
  return (
    <footer className="output-strip">
      <div className="output-icon">
        <ArrowDownToLine size={23} />
      </div>
      <div className="output-summary">
        <span className="eyebrow">{text("trim.expected")}</span>
        <strong>
          {clipCount
            ? text("trim.segmentCount", {
                count: clipCount,
                value: n(clipCount),
              })
            : text("trim.addClips")}{" "}
          <ArrowRight size={15} />
          <span>
            {text("trim.outputDuration", {
              count: totalFrames,
              frames: n(totalFrames),
              time: clock(totalSeconds),
            })}
          </span>
        </strong>
        <span className="output-facts">
          {text("trim.outputVideo")}
          <i />{" "}
          {text("trim.outputAudio", {
            audio: text(("trim.audioSummary." + audioMode) as MessageKey),
          })}
          {audioMode !== "none" &&
            text("trim.outputCodec", {
              codec: text(("trim.codecSummary." + audioCodec) as MessageKey),
            })}
          <i />{" "}
          {text("trim.outputLocation", { location: LOCATIONS()[location] })}
        </span>
        <span
          className={`output-path${completed ? " trim-completion" : ""}`}
          title={output}
        >
          {running ? (
            text("trim.progress", {
              stage: stageMessage(stage || ""),
              progress: n(progress),
            })
          ) : completed ? (
            <>
              <span className="trim-completion-label">
                {text("trim.completed")}
                {elapsed !== undefined
                  ? text("queue.completedTime", {
                      time:
                        elapsed < 1
                          ? text("queue.lessThanSecond")
                          : formatDuration(elapsed),
                    })
                  : ""}
              </span>
              <OutputFiles output={output} />
            </>
          ) : typeof stage === "object" && stage.stage === "trim_cancelled" ? (
            stageMessage(stage)
          ) : (
            text("trim.outputName")
          )}
        </span>
      </div>
      <div className="run-actions">
        {completed && (
          <Button variant="ghost" onClick={onReveal}>
            <FolderOpen size={15} />
            {text("trim.reveal")}
          </Button>
        )}
        {running ? (
          <Button variant="stop" onClick={onCancel}>
            <Square size={16} />
            {text("trim.cancel")}
          </Button>
        ) : (
          <Button
            variant="primary run"
            disabled={!canExport}
            onClick={onExport}
          >
            <Play size={17} />
            {text("trim.export")}
          </Button>
        )}
      </div>
    </footer>
  );
}
