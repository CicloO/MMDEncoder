import { ArrowDownToLine, ArrowRight, Play, Square } from "lucide-react";
import { Button } from "./components";
import { t, localeRuntime } from "./i18n";
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
  const n = (value: number) =>
    localeRuntime.number(value, { useGrouping: false });
  const dimensions = job?.meta
    ? t("output.dimensions", {
        width: n(job.meta.width),
        height: n(job.meta.height),
      })
    : "";
  const outputDimensions =
    (s.resizeMode !== "source" || s.vsr) && preview?.dimensions
      ? t("output.scaledDimensions", {
          source: dimensions,
          target: t("output.dimensions", {
            width: n(preview.dimensions.width),
            height: n(preview.dimensions.height),
          }),
        })
      : dimensions;
  const fps = job?.meta
    ? s.vfg
      ? t("output.vfgFPS", {
          source: formatFPS(job.meta.fpsText || job.meta.fps),
          target: formatFPS(Number(job.meta.fps) * s.vfgMultiplier),
          multiplier: n(s.vfgMultiplier),
        })
      : s.fps === "source"
        ? formatFPS(job.meta.fpsText || job.meta.fps)
        : t("output.scaledFPS", {
            source: formatFPS(job.meta.fpsText || job.meta.fps),
            target: formatFPS(s.fps),
          })
    : "";
  return (
    <footer className="output-strip">
      <div className="output-icon">
        <ArrowDownToLine size={23} />
      </div>
      <div className="output-summary">
        <span className="eyebrow">{t("output.expected")}</span>
        <strong>
          {job?.meta
            ? t("output.basis", { dimensions: outputDimensions, fps })
            : t("output.sourceSizeFPS")}{" "}
          <ArrowRight size={15} />
          <span>
            {s.alphaMode === "mask"
              ? t("output.mask")
              : t("output.engineFacts", {
                  encoder: engine ? engineLabel(engine) : s.encoder,
                  depth: n(s.bitDepth),
                })}
          </span>
        </strong>
        <span className="output-facts">
          {s.alphaMode === "mask" ? (
            <>
              {t("output.maskFacts", {
                codec: s.container === "webm" ? "VP9" : "H.264",
              })}
              <i /> {t("output.noAudio")}
              <i /> {t("output.format", { format: s.container.toUpperCase() })}
            </>
          ) : (
            <>
              {s.encoder === "prores_ks" ? (
                `ProRes ${s.chroma === "444" ? "4444" : "HQ"}`
              ) : (
                <>
                  {s.rateControl === "bitrate"
                    ? t("video.bitrateOption", {
                        bitrate: localeRuntime.number(s.bitrate),
                      })
                    : t("output.quality", {
                        mode:
                          s.rateControl === "qp"
                            ? "QP"
                            : backend === "cpu"
                              ? "CRF"
                              : "CQ",
                        quality: n(s.quality),
                      })}{" "}
                  · {s.preset}
                </>
              )}
              <i />
              {t("output.audio", {
                audio:
                  job?.meta && !job.meta.audio && !job.audioPath
                    ? t("output.noTrack")
                    : audioLabels()[s.audio],
              })}
              {(!job?.meta || job.meta.audio || job.audioPath) &&
              ["aac", "libopus"].includes(s.audio) &&
              s.audioBitrate > 0
                ? ` · ${t("video.bitrateOption", { bitrate: localeRuntime.number(s.audioBitrate) })}`
                : ""}
              {(!job?.meta || job.meta.audio || job.audioPath) && s.hiRes
                ? " · Hi-Res 24-bit"
                : ""}
              {job?.audioPath && s.audio !== "none"
                ? t("output.replacedAudio")
                : ""}{" "}
              {s.alphaMode === "preserve" && t("output.preserveAlpha")}
              <i /> {t("output.format", {
                format: s.container.toUpperCase(),
              })}{" "}
              {s.alphaMask && (
                <>
                  <i />
                  {t("output.withMask")}
                </>
              )}
            </>
          )}
        </span>
        <span className="output-path" title={preview?.output}>
          {preview?.output || t("output.empty")}
        </span>
      </div>
      <div className="run-actions">
        <span>
          {running
            ? t("output.running")
            : t("output.queueCounts", {
                ready: t("output.readyCount", {
                  count: readyCount,
                  countText: localeRuntime.number(readyCount),
                }),
                done: doneCount
                  ? t("output.doneCount", {
                      count: doneCount,
                      countText: localeRuntime.number(doneCount),
                    })
                  : "",
              })}
        </span>
        {running ? (
          <Button variant="stop" onClick={onCancel}>
            <Square size={16} />
            {t("output.cancel")}
          </Button>
        ) : (
          <Button
            variant="primary run"
            disabled={busy || !readyCount || !engine || errorCount > 0}
            onClick={onStart}
          >
            <Play size={17} />
            {busy ? t("output.preparing") : t("output.start")}
          </Button>
        )}
      </div>
    </footer>
  );
}
