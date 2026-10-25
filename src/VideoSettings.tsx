import { t, localeRuntime } from "./i18n";
import { Button, Field, Select } from "./components";
import { BackgroundColor } from "./BackgroundColor";
import { RtxSettings } from "./RtxSettings";
import { Copy, Folder, Info, Plus } from "lucide-react";
import {
  audioLabels,
  engineLabel,
  fadeOptions,
  fadeHint,
  maskFormatLabel,
} from "./presentation";
import type { Settings, Engine, Job, Preview, State } from "./types";
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const frameOptions = () => [
  { value: "source", label: t("video.fpsSource") },
  ...["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({
    value:
      (
        {
          "23.976": "24000/1001",
          "29.97": "30000/1001",
          "59.94": "60000/1001",
        } as Record<string, string>
      )[v] || v,
    label: t("video.fpsOption", {
      fps: localeRuntime.number(Number(v), {
        useGrouping: false,
        maximumFractionDigits: 3,
      }),
    }),
  })),
  { value: "custom", label: t("video.fpsCustom") },
];

export function VideoSettings({
  s,
  tab,
  engine,
  backend,
  engines,
  detecting,
  verification,
  placebo,
  canTest,
  job,
  preview,
  customFPS,
  setCustomFPS,
  set,
  changed,
  call,
  copy,
  pickDirectory,
}: {
  s: Settings;
  tab: string;
  engine?: Engine;
  backend: string;
  engines: Engine[];
  detecting: boolean;
  verification: State["enhancements"];
  placebo?: boolean;
  canTest: boolean;
  job?: Pick<Job, "meta" | "audioPath" | "audioMeta">;
  preview: Preview | null;
  customFPS: boolean;
  setCustomFPS: (v: boolean) => void;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  changed: (s: Settings) => void;
  call: (action: string, payload?: unknown) => Promise<any>;
  copy: () => void;
  pickDirectory: () => void;
}) {
  // 前向分析只对 NVENC / NVEncC 生效；级别只有 HEVC / AV1 支持
  const lookaheadSupported = /_nvenc$|^nvencc:/.test(s?.encoder || "");
  const lookaheadLevelSupported =
    lookaheadSupported && !/^h264_nvenc$|^nvencc:h264$/.test(s?.encoder || "");
  function fieldNumber(
    key: keyof Settings,
    label: string,
    min: number,
    max: number,
    hint?: string,
  ) {
    const value = Number(s?.[key]);
    const fieldError =
      !Number.isFinite(value) || value < min || value > max
        ? t("video.numberRange", {
            min: localeRuntime.number(min),
            max: localeRuntime.number(max),
          })
        : undefined;
    return (
      <Field id={key} label={label} hint={hint} error={fieldError}>
        <input
          id={key}
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(value) ? String(value) : ""}
          disabled={
            (s?.encoder === "prores_ks" && key === "bitrate") ||
            (key === "lookahead" && !lookaheadSupported) ||
            (key === "lookaheadLevel" && !lookaheadLevelSupported)
          }
          aria-invalid={!!fieldError}
          aria-describedby={
            fieldError ? `${key}-error` : hint ? `${key}-hint` : undefined
          }
          onChange={(e) =>
            set(key, e.target.value === "" ? NaN : Number(e.target.value))
          }
        />
      </Field>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      className="settings-body"
    >
      {tab === "encoding" && (
        <>
          <div className="form-row">
            <Select
              id="container"
              label={t("video.container")}
              value={s.container}
              options={options(["mp4", "mkv", "mov", "webm"]).map((o) => ({
                ...o,
                label: o.label.toUpperCase(),
              }))}
              onChange={(v) => set("container", v)}
            />
            <Select
              id="bitDepth"
              label={t("video.depth")}
              value={s.bitDepth}
              options={[
                {
                  value: 8,
                  label: t("video.depthOption", {
                    bits: localeRuntime.number(8),
                  }),
                },
                {
                  value: 10,
                  label: t("video.depthOption", {
                    bits: localeRuntime.number(10),
                  }),
                },
              ]}
              onChange={(v) => set("bitDepth", Number(v))}
            />
          </div>
          <Select
            id="encoder"
            label={t("video.encoder")}
            value={s.encoder}
            options={[
              ...(!engine
                ? [
                    {
                      value: s.encoder,
                      label: t("video.encoderAvailability", {
                        encoder: s.encoder,
                        status: detecting
                          ? t("video.detecting")
                          : t("video.unavailable"),
                      }),
                    },
                  ]
                : []),
              ...engines.map((e) => ({
                value: e.id,
                label: engineLabel(e),
              })),
            ]}
            onChange={(v) => {
              const en = engines.find((e) => e.id === v);
              changed({
                ...s,
                encoder: v,
                // ProRes takes a quantizer, not a CRF; start at 16 (the built-in value).
                ...(v === "prores_ks" && s.encoder !== "prores_ks"
                  ? { quality: 12, rateControl: "quality" }
                  : {}),
                preset:
                  en?.backend === "cpu"
                    ? v === "libsvtav1"
                      ? "6"
                      : "medium"
                    : en?.backend === "qsv"
                      ? "medium"
                      : en?.backend === "amf"
                        ? "balanced"
                        : "p7",
              });
            }}
            hint={
              detecting
                ? t("video.encoderDetectingHint")
                : t("video.encoderAvailableHint")
            }
          />
          <div className="form-row">
            <Select
              id="rateControl"
              disabled={s.encoder === "prores_ks"}
              label={t("video.rateControl")}
              value={s.rateControl}
              options={[
                {
                  value: "quality",
                  label:
                    backend === "cpu" ? t("video.rateCRF") : t("video.rateCQ"),
                },
                { value: "qp", label: t("video.rateQP") },
                { value: "bitrate", label: t("video.rateBitrate") },
              ]}
              onChange={(v) => set("rateControl", v)}
            />
            {s.rateControl === "bitrate"
              ? fieldNumber("bitrate", t("video.bitrate"), 100, 1000000)
              : fieldNumber(
                  "quality",
                  s.encoder === "prores_ks"
                    ? t("video.quantizer")
                    : t("video.qualityLabel", {
                        mode:
                          s.rateControl === "qp"
                            ? "QP"
                            : backend === "cpu"
                              ? "CRF"
                              : "CQ",
                      }),
                  0,
                  s.encoder === "prores_ks"
                    ? 64
                    : ["h264", "hevc"].includes(engine?.codec || "")
                      ? 51
                      : 63,
                )}
          </div>
          <p className="hint quality-hint">
            {s.encoder === "prores_ks"
              ? t("video.proresHint")
              : s.rateControl === "bitrate"
                ? t("video.bitrateHint")
                : s.rateControl === "qp"
                  ? t("video.qpHint")
                  : backend === "cpu"
                    ? t("video.crfHint")
                    : t("video.cqHint")}
          </p>
          <Select
            id="speed"
            label={t("video.speed")}
            value={s.preset}
            disabled={s.encoder === "prores_ks"}
            options={options(
              backend === "qsv"
                ? [
                    "veryfast",
                    "faster",
                    "fast",
                    "medium",
                    "slow",
                    "slower",
                    "veryslow",
                  ]
                : backend === "amf"
                  ? ["speed", "balanced", "quality"]
                  : backend === "cpu"
                    ? s.encoder === "libsvtav1"
                      ? ["0", "2", "4", "6", "8", "10", "12"]
                      : ["ultrafast", "fast", "medium", "slow", "veryslow"]
                    : ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
            )}
            onChange={(v) => set("preset", v)}
            hint={
              s.encoder === "prores_ks"
                ? t("video.speedProresHint")
                : backend === "nvenc" || backend === "nvencc"
                  ? t("video.speedNvencHint")
                  : s.encoder === "libsvtav1"
                    ? t("video.speedAv1Hint")
                    : backend === "amf"
                      ? t("video.speedAmfHint")
                      : t("video.speedCpuHint")
            }
          />
          <div className="divider" />
          <Select
            id="resizeMode"
            label={t("video.resize")}
            value={s.resizeMode || "source"}
            options={[
              { value: "source", label: t("video.resizeSource") },
              {
                value: "long",
                label: t("video.resizeLong"),
              },
              { value: "custom", label: t("video.resizeCustom") },
            ]}
            onChange={(v) => set("resizeMode", v)}
          />
          {s.resizeMode === "long" &&
            fieldNumber(
              "width",
              t("video.longEdge"),
              2,
              16384,
              t("video.longEdgeHint"),
            )}
          {s.resizeMode === "custom" && (
            <>
              <div className="form-row">
                {(["width", "height"] as const).map((axis) => {
                  const derived =
                    s.keepAspect && s.resizeAxis !== axis && job?.meta;
                  const value = derived
                    ? Math.max(
                        2,
                        Math.round(
                          (s[s.resizeAxis as "width" | "height"] *
                            job.meta![axis]) /
                            job.meta![s.resizeAxis as "width" | "height"] /
                            2,
                        ) * 2,
                      )
                    : s[axis];
                  const invalid =
                    !Number.isInteger(value) || value < 2 || value > 16384;
                  return (
                    <Field
                      key={axis}
                      id={axis}
                      label={
                        axis === "width" ? t("video.width") : t("video.height")
                      }
                      error={invalid ? t("video.sizeInteger") : undefined}
                    >
                      <input
                        id={axis}
                        type="number"
                        min={2}
                        max={16384}
                        step={1}
                        value={value || ""}
                        aria-invalid={invalid}
                        aria-describedby={invalid ? `${axis}-error` : undefined}
                        onChange={(e) =>
                          changed({
                            ...s,
                            [axis]: Number(e.target.value),
                            resizeAxis: axis,
                          })
                        }
                      />
                    </Field>
                  );
                })}
              </div>
              <label className="check-card">
                <input
                  type="checkbox"
                  checked={s.keepAspect}
                  onChange={(e) =>
                    changed({
                      ...s,
                      keepAspect: e.target.checked,
                      ...(e.target.checked
                        ? {}
                        : job?.meta
                          ? s.resizeAxis === "height"
                            ? {
                                width: Math.max(
                                  2,
                                  Math.round(
                                    (s.height * job.meta.width) /
                                      job.meta.height /
                                      2,
                                  ) * 2,
                                ),
                              }
                            : {
                                height: Math.max(
                                  2,
                                  Math.round(
                                    (s.width * job.meta.height) /
                                      job.meta.width /
                                      2,
                                  ) * 2,
                                ),
                              }
                          : {}),
                    })
                  }
                />
                <span>
                  <strong>{t("video.keepAspect")}</strong>
                  <small>{t("video.keepAspectHint")}</small>
                </span>
              </label>
              {!job?.meta && s.keepAspect && (
                <p className="hint">{t("video.keepAspectEmpty")}</p>
              )}
            </>
          )}
          <Select
            id="fps"
            label={t("video.fps")}
            value={
              customFPS || !frameOptions().some((o) => o.value === s.fps)
                ? "custom"
                : s.fps
            }
            options={frameOptions()}
            onChange={(v) => {
              setCustomFPS(v === "custom");
              if (v !== "custom") set("fps", v);
            }}
          />
          {(customFPS || !frameOptions().some((o) => o.value === s.fps)) && (
            <Field
              id="custom-fps"
              label={t("video.customFPS")}
              hint={t("video.fpsHint")}
            >
              <input
                id="custom-fps"
                value={s.fps === "source" ? "" : s.fps}
                onChange={(e) => set("fps", e.target.value)}
              />
            </Field>
          )}
          <p className="hint">{t("video.fpsConversionHint")}</p>
        </>
      )}
      {tab === "audio" && (
        <>
          <Select
            id="audio"
            label={t("video.audio")}
            value={s.audio}
            options={Object.entries(audioLabels()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("audio", v)}
          />
          <Select
            id="audioBitrate"
            label={t("video.audioBitrate")}
            value={s.audioBitrate}
            options={[64, 96, 128, 160, 192, 256, 320, 384, 512].map(
              (value) => ({
                value,
                label: t("video.bitrateOption", {
                  bitrate: localeRuntime.number(value),
                }),
              }),
            )}
            onChange={(v) => set("audioBitrate", Number(v))}
            disabled={!["aac", "libopus"].includes(s.audio)}
            hint={
              s.audio === "none"
                ? t("video.audioBitrateNoneHint")
                : ["flac", "pcm_s16le"].includes(s.audio)
                  ? t("video.audioBitrateLosslessHint")
                  : t("video.audioBitrateHint")
            }
          />
          <Select
            id="audioFade"
            label={t("video.audioFade")}
            value={String(s.audioFade ?? 0)}
            options={fadeOptions()}
            disabled={s.audio === "none"}
            hint={
              s.audio === "none" ? t("video.audioFadeNoneHint") : fadeHint()
            }
            onChange={(v) => set("audioFade", Number(v))}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!s.hiRes}
              disabled={!["flac", "pcm_s16le"].includes(s.audio)}
              onChange={(e) =>
                // FLAC / PCM do not fit MP4: switch to MKV with it.
                changed({
                  ...s,
                  hiRes: e.target.checked,
                  ...(e.target.checked && s.container === "mp4"
                    ? { container: "mkv" }
                    : {}),
                })
              }
            />
            <span>
              {t("video.hiRes")}
              <small className="hint hires-hint">
                {!["flac", "pcm_s16le"].includes(s.audio)
                  ? t("video.hiResDisabled")
                  : t("video.hiResDetails", {
                      source: (() => {
                        const a = job?.audioPath
                          ? job.audioMeta
                          : job?.meta?.audio;
                        if (!a?.sampleRate) return t("video.hiResPerSource");
                        const rate =
                          a.sampleRate < 48000
                            ? a.sampleRate * 2
                            : a.sampleRate;
                        return t("video.hiResCurrent", {
                          fromRate: localeRuntime.number(a.sampleRate / 1000),
                          depth: a.float
                            ? t("video.audioFloat")
                            : a.bits
                              ? t("video.depthOption", {
                                  bits: localeRuntime.number(a.bits),
                                })
                              : t("video.audioDepthUnknown"),
                          toRate: localeRuntime.number(rate / 1000),
                        });
                      })(),
                    })}
              </small>
            </span>
          </label>
          <div className="help-box">
            <Info size={17} />
            <p>{t("video.audioHint")}</p>
          </div>
          {(job?.audioPath ? job.audioMeta : job?.meta?.audio) &&
            (() => {
              const a = (job!.audioPath ? job!.audioMeta : job!.meta!.audio)!;
              return (
                <div className="mini-facts">
                  <span>
                    {job!.audioPath
                      ? t("video.replacementAudio")
                      : t("video.sourceAudio")}
                  </span>
                  <strong>
                    {t("video.audioFacts", {
                      codec: a.codec.toUpperCase(),
                      rate: localeRuntime.number(a.sampleRate / 1000),
                    })}
                  </strong>
                </div>
              );
            })()}
        </>
      )}
      {tab === "rtx" && (
        <RtxSettings
          s={s}
          verification={verification}
          placebo={placebo}
          canTest={canTest}
          set={set}
          patch={(p) => changed({ ...s, ...p })}
          call={call}
        />
      )}
      {tab === "alpha" && (
        <>
          <Select
            id="alphaMode"
            label={t("video.alpha")}
            // "split" = colour video without alpha + separate mask
            // (stored as alphaMode discard + alphaMask, any format).
            value={
              s.alphaMask && s.alphaMode === "discard" ? "split" : s.alphaMode
            }
            options={[
              { value: "discard", label: t("video.alphaDiscard") },
              { value: "preserve", label: t("video.alphaPreserve") },
              {
                value: "split",
                label: t("video.alphaSplit"),
              },
              { value: "mask", label: t("video.alphaMask") },
              { value: "color", label: t("video.alphaColor") },
            ]}
            onChange={(v) =>
              changed({
                ...s,
                alphaMode: v === "split" ? "discard" : v,
                alphaMask: v === "split",
                // ProRes alpha starts at quantizer 16 (~1/5 of the default size).
                ...(v === "preserve" &&
                s.alphaMode !== "preserve" &&
                s.encoder === "prores_ks"
                  ? { quality: 12 }
                  : {}),
              })
            }
          />
          {s.alphaMode === "color" && (
            <BackgroundColor
              value={s.alphaBackground}
              onChange={(hex) => changed({ ...s, alphaBackground: hex })}
            />
          )}
          {s.alphaMask && s.alphaMode === "discard" && (
            <>
              <div className="alpha-diagram">
                <div className="alpha-swatch color">RGB</div>
                <Plus size={16} />
                <div className="alpha-swatch mask">A</div>
              </div>
              <p className="hint">
                {t("video.alphaSplitHint", {
                  format: maskFormatLabel(s.maskFormat),
                })}
              </p>
            </>
          )}
          {s.alphaMode === "mask" && (
            <>
              <div className="alpha-diagram">
                <div className="alpha-swatch mask">A</div>
              </div>
              <p className="hint">
                {t(
                  (s.maskFormat ?? "lossless") === "lossless"
                    ? "video.alphaMaskHint"
                    : "video.alphaMaskLossyHint",
                )}
              </p>
            </>
          )}
          {(s.alphaMask || s.alphaMode === "mask") && (
            <>
              <Select
                id="maskFormat"
                label={t("mask.format")}
                value={s.maskFormat ?? "lossless"}
                options={["lossless", "gpu-lossy", "x264-lossy"].map(
                  (value) => ({ value, label: maskFormatLabel(value) }),
                )}
                onChange={(value) =>
                  set("maskFormat", value as Settings["maskFormat"])
                }
              />
              {(s.maskFormat ?? "lossless") !== "lossless" && (
                <p className="hint">{t("mask.lossyWarning")}</p>
              )}
              {s.container === "webm" &&
                (s.maskFormat ?? "lossless") !== "lossless" && (
                  <p className="hint">{t("mask.webmHint")}</p>
                )}
            </>
          )}
          {(s.alphaMask || s.alphaMode === "mask") &&
            job?.meta &&
            !job.meta.hasAlpha && (
              <p className="inline-error">{t("video.alphaMissing")}</p>
            )}
        </>
      )}
      {tab === "output" && (
        <>
          <Select
            id="outputMode"
            label={t("video.outputMode")}
            value={s.outputMode}
            options={[
              { value: "source", label: t("video.outputSource") },
              { value: "encoded", label: t("video.outputEncoded") },
              { value: "custom", label: t("video.outputCustom") },
            ]}
            onChange={(v) => set("outputMode", v)}
          />
          {s.outputMode === "custom" && (
            <Field id="outputDir" label={t("video.outputDirectory")}>
              <div className="input-action">
                <input
                  id="outputDir"
                  value={s.outputDir}
                  onChange={(e) => set("outputDir", e.target.value)}
                  placeholder={t("video.pickFolder")}
                />
                <Button
                  title={t("video.pickOutputFolder")}
                  aria-label={t("video.pickOutputFolder")}
                  onClick={pickDirectory}
                >
                  <Folder size={17} />
                </Button>
              </div>
            </Field>
          )}
          <p className="hint">{t("video.outputHint")}</p>
          <div className="divider" />
          <Field
            id="nameTemplate"
            label={t("video.nameTemplate")}
            hint={t("video.nameTemplateHint")}
          >
            <input
              id="nameTemplate"
              value={s.nameTemplate}
              onChange={(e) => set("nameTemplate", e.target.value)}
            />
          </Field>
          <div className="template-tokens">
            {["{name}", "{preset}", "{date}", "{index}"].map((v) => (
              <Button
                key={v}
                variant="ghost"
                onClick={() => set("nameTemplate", s.nameTemplate + v)}
              >
                {v}
              </Button>
            ))}
          </div>
          <p className="hint">{t("video.templateTokens")}</p>
          <div className="path-preview">
            <span>{t("video.outputExample")}</span>
            <code>{preview?.output || t("video.outputExampleEmpty")}</code>
          </div>
        </>
      )}
      {tab === "advanced" && (
        <>
          <div className="form-row">
            <Select
              id="chroma"
              label={t("video.chroma")}
              value={s.chroma}
              options={[
                { value: "420", label: "4:2:0" },
                { value: "422", label: "4:2:2" },
                { value: "444", label: "4:4:4" },
              ]}
              onChange={(v) => set("chroma", v)}
            />
            <Select
              id="colorRange"
              label={t("video.colorRange")}
              value={s.colorRange}
              options={[
                { value: "tv", label: t("video.rangeTv") },
                { value: "pc", label: t("video.rangePc") },
              ]}
              onChange={(v) => set("colorRange", v)}
            />
          </div>
          <Select
            id="colorSpace"
            label={t("video.colorSpace")}
            value={s.colorSpace}
            options={options(["bt709", "bt601", "bt2020"])}
            onChange={(v) => set("colorSpace", v)}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!s.editFriendly}
              onChange={(e) => set("editFriendly", e.target.checked)}
            />
            <span>
              {t("video.editFriendly")}
              <small className="hint hires-hint">
                {s.gop >= 0
                  ? t("video.editFriendlyManual")
                  : t("video.editFriendlyHint")}
              </small>
            </span>
          </label>
          <div className="form-row">
            {fieldNumber(
              "gop",
              t("video.gop"),
              -1,
              10000,
              t("video.automaticNegative"),
            )}
            {fieldNumber(
              "bframes",
              t("video.bframes"),
              -1,
              16,
              t("video.automaticNegative"),
            )}
          </div>
          <div className="form-row">
            {fieldNumber(
              "lookahead",
              t("video.lookahead"),
              0,
              32,
              lookaheadSupported ? undefined : t("video.lookaheadHint"),
            )}
            {fieldNumber(
              "lookaheadLevel",
              t("video.lookaheadLevel"),
              0,
              3,
              lookaheadLevelSupported
                ? undefined
                : t("video.lookaheadLevelHint"),
            )}
          </div>
          <div className="command-row">
            <details className="command-details">
              <summary>{t("video.showCommand")}</summary>
              <pre>{preview?.command || t("video.commandEmpty")}</pre>
            </details>
            <Button disabled={!job} onClick={copy}>
              <Copy size={14} />
              {t("video.copyCommand")}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
