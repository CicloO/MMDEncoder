import { ArrowDownToLine, ArrowRight, Play, Square } from "lucide-react";
import { Button } from "./components";
import { audioLabels, engineLabel, formatFPS } from "./presentation";
import type { Settings, Job, Engine, Preview } from "./types";
export function EncodeFooter({
  s,
  job,
  preview,
  engine,
  backend,
  running,
  readyCount,
  doneCount,
  busy,
  errorCount,
  onCancel,
  onStart,
}: {
  s: Settings;
  job?: Pick<Job, "meta" | "audioPath">;
  preview: Preview | null;
  engine?: Engine;
  backend: string;
  running: boolean;
  readyCount: number;
  doneCount: number;
  busy: boolean;
  errorCount: number;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <footer className="output-strip">
      <div className="output-icon">
        <ArrowDownToLine size={23} />
      </div>
      <div className="output-summary">
        <span className="eyebrow">预计结果</span>
        <strong>
          {job?.meta
            ? `${job.meta.width}×${job.meta.height}${(s.resizeMode !== "source" || s.vsr) && preview?.dimensions ? ` → ${preview.dimensions.width}×${preview.dimensions.height}` : ""} · ${formatFPS(job.meta.fpsText || job.meta.fps)}${s.vfg ? ` → ${formatFPS(Number(job.meta.fps) * s.vfgMultiplier)}（VFG ${s.vfgMultiplier}×）` : s.fps === "source" ? "" : ` → ${formatFPS(s.fps)}`} FPS`
            : "保持源分辨率与帧率"}{" "}
          <ArrowRight size={15} />
          <span>
            {s.alphaMode === "mask"
              ? "Alpha 黑白遮罩"
              : `${engine ? engineLabel(engine) : s.encoder} · ${s.bitDepth}-bit`}
          </span>
        </strong>
        <span className="output-facts">
          {s.alphaMode === "mask" ? (
            <>
              {s.container === "webm" ? "VP9" : "H.264"} 无损
              <i /> 无音频
              <i /> 输出 → {s.container.toUpperCase()}
            </>
          ) : (
            <>
              {s.encoder === "prores_ks" ? (
                `ProRes ${s.chroma === "444" ? "4444" : "HQ"}`
              ) : (
                <>
                  {s.rateControl === "bitrate"
                    ? `${s.bitrate} kbps`
                    : `${s.rateControl === "qp" ? "QP" : backend === "cpu" ? "CRF" : "CQ"} ${s.quality}`}{" "}
                  · {s.preset}
                </>
              )}
              <i />
              音频 →{" "}
              {job?.meta && !job.meta.audio && !job.audioPath
                ? "无音轨"
                : audioLabels()[s.audio]}
              {(!job?.meta || job.meta.audio || job.audioPath) &&
              ["aac", "libopus"].includes(s.audio) &&
              s.audioBitrate > 0
                ? ` · ${s.audioBitrate} kbps`
                : ""}
              {(!job?.meta || job.meta.audio || job.audioPath) && s.hiRes
                ? " · Hi-Res 24-bit"
                : ""}
              {job?.audioPath && s.audio !== "none" ? " · 替换音频" : ""}{" "}
              {s.alphaMode === "preserve" && " · 保留 Alpha"}
              <i /> 输出 → {s.container.toUpperCase()}{" "}
              {s.alphaMask && (
                <>
                  <i />+ Alpha 遮罩
                </>
              )}
            </>
          )}
        </span>
        <span className="output-path" title={preview?.output}>
          {preview?.output || "添加视频后预览保存路径"}
        </span>
      </div>
      <div className="run-actions">
        <span>
          {running
            ? "正在处理队列"
            : `${readyCount} 个视频待处理${doneCount ? ` · ${doneCount} 个已完成` : ""}`}
        </span>
        {running ? (
          <Button variant="stop" onClick={onCancel}>
            <Square size={16} />
            取消队列
          </Button>
        ) : (
          <Button
            variant="primary run"
            disabled={busy || !readyCount || !engine || errorCount > 0}
            onClick={onStart}
          >
            <Play size={17} />
            {busy ? "准备中…" : "开始压制"}
          </Button>
        )}
      </div>
    </footer>
  );
}
