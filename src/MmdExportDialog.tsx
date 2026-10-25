import { Folder, FolderOpen } from "lucide-react";
import { Button, Select, Modal } from "./components";
import { fadeOptions } from "./presentation";
import type { State, Preset } from "./types";
import { t, localeRuntime, errorMessage, summaryMessage } from "./i18n";
import type { ErrorData, MessageDescriptor, MessageKey } from "./i18n";
// Presets an MMD export cannot use yet (mirrors backend/mmd-export.cjs).
function mmdUnsupported(p: Preset) {
  if (
    p.settings.alphaMode !== "mask" &&
    p.settings.encoder.startsWith("nvencc:")
  )
    return t("mmd.presetUnsupported");
  return "";
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

export function MmdExportDialog({
  open,
  onClose,
  error,
  mmd,
  presets,
  busy,
  onCall,
  action,
}: {
  open: boolean;
  onClose: () => void;
  error: string | ErrorData;
  mmd: State["mmd"];
  presets: Preset[];
  busy: boolean;
  onCall: (
    action: string,
    payload?: unknown,
    message?: string,
  ) => Promise<void>;
  action: (action: string, payload?: unknown, message?: string) => void;
}) {
  function statusMessage() {
    if (mmd.errorData) return errorMessage(mmd.errorData);
    if (mmd.error) return mmd.error;
    if (mmd.test)
      return mmd.test.ok
        ? summaryMessage(mmd.test as MessageDescriptor)
        : errorMessage(mmd.test);
    const last = mmd.lastExport;
    if (!last) return t("mmd.outputHint");
    if (!last.ok) return t("mmd.lastFailed", { detail: last.error || "" });
    const audio =
      last.audio === "wav" ? "wav" : last.audio === "avi" ? "avi" : "none";
    const key = ("mmd.last." + audio + (last.mask ? "Mask" : "")) as MessageKey;
    return t(key, { name: baseName(last.output || "") });
  }
  return (
    <Modal
      error={typeof error === "string" ? error : errorMessage(error)}
      open={open}
      onClose={onClose}
      fixedHeight
      title={t("mmd.title")}
      description={t("mmd.description")}
    >
      {mmd.interrupted.length > 0 && (
        <section className="modal-section" aria-label={t("mmd.interrupted")}>
          <h3>{t("mmd.interrupted")}</h3>
          <p className="hint">{t("mmd.interruptedHint")}</p>
          {mmd.interrupted.map((x) => (
            <div className="status-row" key={x.id}>
              <p title={x.temp}>
                {baseName(x.output)}
                <small className="row-detail">
                  {t("mmd.interruptedEntry", {
                    preset: x.presetName,
                    size: localeRuntime.number(x.size / 1048576, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                    date: localeRuntime.dateTime(x.at, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    }),
                  })}
                </small>
              </p>
              <div className="row-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdRecover", { id: x.id }, t("mmd.recovered"))
                  }
                >
                  {t("mmd.recover")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdDiscard", { id: x.id }, t("mmd.discarded"))
                  }
                >
                  {t("mmd.discard")}
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}
      <section
        className="modal-section"
        aria-label={t("mmd.plugin")}
        aria-busy={busy}
      >
        <h3>{t("mmd.plugin")}</h3>
        <div className="status-row">
          <p className={mmd.plugin.broken ? "inline-error" : undefined}>
            {!mmd.plugin.available
              ? t("mmd.pluginMissing")
              : mmd.plugin.broken
                ? t("mmd.pluginBroken")
                : !mmd.plugin.installed
                  ? t("mmd.pluginNotInstalled")
                  : mmd.plugin.upToDate
                    ? t("mmd.pluginInstalled")
                    : t("mmd.pluginUpdateAvailable")}
          </p>
          <div className="row-actions">
            {mmd.plugin.available &&
              (!mmd.plugin.installed || !mmd.plugin.upToDate) && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdInstall", undefined, t("mmd.installed"))
                  }
                >
                  {mmd.plugin.broken
                    ? t("mmd.repairPlugin")
                    : mmd.plugin.installed
                      ? t("mmd.updatePlugin")
                      : t("mmd.installPlugin")}
                </Button>
              )}
            {mmd.plugin.installed && (
              <Button
                disabled={busy}
                onClick={() =>
                  onCall("mmdUninstall", undefined, t("mmd.uninstalled"))
                }
              >
                {t("mmd.uninstall")}
              </Button>
            )}
          </div>
        </div>
      </section>
      <section className="modal-section" aria-label={t("mmd.settings")}>
        <h3>{t("mmd.settings")}</h3>
        <Select
          id="mmd-export-preset"
          label={t("mmd.preset")}
          value={mmd.presetId}
          disabled={busy}
          options={[
            { value: "", label: t("mmd.noPreset") },
            ...presets.map((p) => {
              const why = mmdUnsupported(p);
              return {
                value: p.id,
                label: why
                  ? t("mmd.presetWithReason", { name: p.name, reason: why })
                  : p.name,
                disabled: !!why,
              };
            }),
          ]}
          onChange={(presetId) => onCall("mmdExportSet", { presetId })}
        />
        <label className="check-card">
          <input
            type="checkbox"
            checked={mmd.followMmd}
            disabled={busy}
            onChange={(e) =>
              onCall("mmdExportSet", { followMmd: e.target.checked })
            }
          />
          <span>
            <strong>{t("mmd.follow")}</strong>
            <small>{t("mmd.followHint")}</small>
          </span>
        </label>
        <label className="check-card">
          <input
            type="checkbox"
            checked={mmd.rangeSuffix !== false}
            disabled={busy}
            onChange={(e) =>
              onCall("mmdExportSet", { rangeSuffix: e.target.checked })
            }
          />
          <span>
            <strong>{t("mmd.suffix")}</strong>
            <small>{t("mmd.suffixHint")}</small>
          </span>
        </label>
        <div className="form-row">
          {/* Overrides the preset's own alpha setting; the same choice as
              in MMD's 詳細設定, where a change wins over this window. */}
          <Select
            id="mmd-mask-mode"
            label={t("mmd.mask")}
            value={mmd.maskMode || "off"}
            disabled={busy}
            hint={t("mmd.maskHint")}
            options={[
              { value: "off", label: t("mmd.maskOff") },
              { value: "with", label: t("mmd.maskWith") },
              { value: "only", label: t("mmd.maskOnly") },
            ]}
            onChange={(maskMode) => onCall("mmdExportSet", { maskMode })}
          />
          <Select
            id="mmd-audio-fade"
            label={t("mmd.fade")}
            value={String(mmd.audioFade)}
            disabled={busy}
            hint={t("mmd.fadeHint")}
            options={fadeOptions.map(({ value }) => ({
              value,
              label:
                value === "0"
                  ? t("mmd.fadeOff")
                  : t("mmd.fadeSeconds", {
                      seconds: localeRuntime.number(Number(value)),
                    }),
            }))}
            onChange={(v) => onCall("mmdExportSet", { audioFade: Number(v) })}
          />
        </div>
      </section>
      <section className="modal-section" aria-label={t("mmd.tests")}>
        <h3>{t("mmd.tests")}</h3>
        <div className="status-row">
          <p
            className={
              mmd.error || mmd.test?.ok === false ? "inline-error" : undefined
            }
            role={mmd.error ? "alert" : "status"}
          >
            {statusMessage()}
          </p>
          <div className="row-actions">
            <Button
              disabled={busy || !mmd.presetId || !!mmd.error}
              onClick={() => onCall("mmdTest")}
            >
              {busy ? t("mmd.busy") : t("mmd.test")}
            </Button>
            <Button
              disabled={!mmd.lastExport?.output}
              title={mmd.lastExport?.output}
              onClick={() => action("mmdOpenLatest")}
            >
              <Folder size={15} />
              {t("mmd.openLatest")}
            </Button>
            <Button onClick={() => action("mmdOpenLog")}>
              <FolderOpen size={15} />
              {t("mmd.openLog")}
            </Button>
          </div>
        </div>
        {(() => {
          const e = mmd.lastExport,
            timing = e?.ok ? e.timing : undefined;
          if (!timing || !(timing.render > 0)) return null;
          const seconds = (v: number) =>
            localeRuntime.unit(v, "second", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            });
          const share = (100 * timing.waited) / timing.render;
          const key = e?.frames
            ? timing.finish !== undefined
              ? "mmd.timingFramesFinish"
              : "mmd.timingFrames"
            : timing.finish !== undefined
              ? "mmd.timingFinish"
              : "mmd.timing";
          return (
            <p className="hint export-timing">
              {t(key, {
                total: seconds(
                  timing.setup +
                    timing.render +
                    timing.encoderTail +
                    (timing.finish || 0),
                ),
                setup: seconds(timing.setup),
                render: seconds(timing.render),
                waited: seconds(timing.waited),
                share: localeRuntime.number(share, {
                  maximumFractionDigits: 0,
                }),
                longest: localeRuntime.unit(
                  Math.round(timing.longestWait * 1000),
                  "millisecond",
                ),
                tail: seconds(timing.encoderTail),
                finish: seconds(timing.finish || 0),
                fps: localeRuntime.number((e?.frames || 0) / timing.render, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
              })}
              {t(share >= 10 ? "mmd.encoderSlow" : "mmd.encoderFast")}
            </p>
          );
        })()}
      </section>
    </Modal>
  );
}
