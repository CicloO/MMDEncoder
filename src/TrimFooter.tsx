import {
  ArrowDownToLine,
  ArrowRight,
  FolderOpen,
  Square,
  Play,
} from "lucide-react";
import { Button } from "./components";
import { clock } from "./trimCoordinates";
import { AUDIO_MODES, AUDIO_CODECS, LOCATIONS } from "./trimOptions";
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
  stage?: string;
  progress: number;
  output?: string;
  canExport: boolean;
  onReveal: () => unknown;
  onCancel: () => unknown;
  onExport: () => unknown;
}) {
  return (
    <footer className="output-strip">
      <div className="output-icon">
        <ArrowDownToLine size={23} />
      </div>
      <div className="output-summary">
        <span className="eyebrow">预计结果</span>
        <strong>
          {clipCount ? `${clipCount} 段` : "添加片段"} <ArrowRight size={15} />
          <span>
            {totalFrames} 帧 · {clock(totalSeconds)}
          </span>
        </strong>
        <span className="output-facts">
          视频 → 直接复制
          <i /> 音频 → {AUDIO_MODES[audioMode].split("（")[0]}
          {audioMode !== "none" &&
            ` · ${AUDIO_CODECS[audioCodec].split(" ·")[0]}`}
          <i /> 位置 → {LOCATIONS[location]}
        </span>
        <span className="output-path" title={output}>
          {running
            ? `${stage} · ${progress}%`
            : output
              ? `已保存：${output}`
              : stage === "已取消"
                ? "已取消"
                : "保存为“第一个片段名_剪辑”，不覆盖已有文件"}
        </span>
      </div>
      <div className="run-actions">
        {output && !running && (
          <Button variant="ghost" onClick={onReveal}>
            <FolderOpen size={15} />
            打开位置
          </Button>
        )}
        {running ? (
          <Button variant="stop" onClick={onCancel}>
            <Square size={16} />
            取消导出
          </Button>
        ) : (
          <Button
            variant="primary run"
            disabled={!canExport}
            onClick={onExport}
          >
            <Play size={17} />
            导出
          </Button>
        )}
      </div>
    </footer>
  );
}
