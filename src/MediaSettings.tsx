import { t, localeRuntime } from "./i18n";
import { SlidersHorizontal } from "lucide-react";
import { Button, Field, Select } from "./components";
import { fadeOptions, fadeHint } from "./presentation";
import {
  OPERATIONS,
  FORMATS,
  HIRES_FORMATS,
  LOSSY,
  BITRATES,
  MAX_BITRATE,
  CONTAINERS,
  LOCATIONS,
  hiResText,
} from "./mediaOptions";
import type { Options } from "./mediaOptions";
import type { MediaJob } from "./types";
export function MediaSettings({
  o,
  selected,
  locked,
  hiRes,
  bitrate,
  error,
  set,
  pickFolder,
}: {
  o: Options;
  selected?: MediaJob;
  locked: boolean;
  hiRes: boolean;
  bitrate: number;
  error: string;
  set: <K extends keyof Options>(key: K, value: Options[K]) => void;
  pickFolder: () => void;
}) {
  return (
    <aside className="settings-column" aria-label={t("media.settings")}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t("media.outputControl")}</span>
          <h2>{t("media.settings")}</h2>
        </div>
        <SlidersHorizontal size={20} className="muted" />
      </div>
      <div className="settings-panel">
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          className="settings-body"
        >
          <Select
            id="media-operation"
            label={t("media.operationLabel")}
            value={o.operation}
            disabled={locked}
            options={Object.entries(OPERATIONS()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("operation", v)}
          />
          {o.operation !== "video" && (
            <Select
              id="media-format"
              label={t("media.formatLabel")}
              value={o.audioFormat}
              disabled={locked}
              options={Object.entries(FORMATS()).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => set("audioFormat", v)}
            />
          )}
          {o.operation !== "video" && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                disabled={locked || !HIRES_FORMATS.includes(o.audioFormat)}
                checked={hiRes}
                onChange={(e) => set("hiRes", e.target.checked)}
              />
              <span>
                {t("media.hiresLabel")}
                <small className="hint">
                  {!HIRES_FORMATS.includes(o.audioFormat)
                    ? t("media.hiresUnsupported")
                    : t(
                        o.operation === "merge"
                          ? "media.hiresMergeHint"
                          : "media.hiresHint",
                        {
                          conversion:
                            hiResText(
                              o.operation === "merge"
                                ? selected?.audioMeta
                                : selected?.meta?.audio,
                            ) ||
                            t(
                              o.operation === "merge"
                                ? "media.hiresAwaitAudio"
                                : "media.hiresAwaitFile",
                            ),
                        },
                      )}
                </small>
              </span>
            </label>
          )}
          {o.operation !== "video" && (
            <Select
              id="media-fade"
              label={t("media.fadeLabel")}
              value={String(o.audioFormat === "copy" ? 0 : o.audioFade)}
              disabled={locked || o.audioFormat === "copy"}
              options={fadeOptions()}
              hint={
                o.audioFormat === "copy" ? t("media.copyFadeHint") : fadeHint()
              }
              onChange={(v) => set("audioFade", Number(v))}
            />
          )}
          {o.operation !== "video" && LOSSY.includes(o.audioFormat) && (
            <Select
              id="media-bitrate"
              label={t("media.bitrateLabel")}
              value={String(bitrate)}
              disabled={locked}
              options={BITRATES.filter(
                (b) => b <= MAX_BITRATE[o.audioFormat],
              ).map((b) => ({
                value: String(b),
                label: b
                  ? t("meta.bitrate", {
                      rate: localeRuntime.number(b, { useGrouping: false }),
                    })
                  : t("media.bitrateFollow"),
              }))}
              onChange={(v) => set("audioBitrate", Number(v))}
            />
          )}
          {o.operation !== "audio" && (
            <Select
              id="media-container"
              label={t("media.containerLabel")}
              value={o.container}
              disabled={locked}
              options={Object.entries(CONTAINERS).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => set("container", v)}
            />
          )}
          <Select
            id="media-location"
            label={t("media.locationLabel")}
            value={o.location}
            disabled={locked}
            options={Object.entries(LOCATIONS()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("location", v)}
          />
          {o.location === "custom" && (
            <Field id="media-output-dir" label={t("media.outputDirLabel")}>
              <div className="path-picker">
                <input
                  id="media-output-dir"
                  value={o.outputDir}
                  readOnly
                  title={o.outputDir}
                  placeholder={t("media.outputDirTitle")}
                />
                <Button disabled={locked} onClick={pickFolder}>
                  {t("media.pick")}
                </Button>
              </div>
            </Field>
          )}
          <p className="hint">
            {o.operation === "audio"
              ? t("media.audioOnlyHint")
              : t(
                  o.container === "mp4"
                    ? "media.videoCopyMp4Hint"
                    : "media.videoCopyHint",
                )}
            {o.operation === "merge" &&
              t(
                o.audioFormat === "copy"
                  ? "media.mergeCopyHint"
                  : "media.mergeEncodeHint",
              )}
            {t("media.keepExisting")}
          </p>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </form>
      </div>
    </aside>
  );
}
