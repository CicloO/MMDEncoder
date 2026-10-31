import { t, localeRuntime, summaryMessage, errorMessage } from "./i18n";
import { Button, Field, Select } from "./components";
import type { Settings, State } from "./types";
// 超分补帧 tab: how to enlarge (Lanczos / ArtCNN / RTX VSR), RTX frame
// generation, and the local check RTX features need before encoding.
export function RtxSettings({
  s,
  verification,
  placebo: placeboAvailable,
  canTest,
  set,
  patch,
  call,
}: {
  s: Settings;
  verification: State["enhancements"];
  placebo?: boolean;
  canTest: boolean;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (p: Partial<Settings>) => void;
  call: (action: string, payload?: unknown) => Promise<any>;
}) {
  const upscaler = s.vsr ? "vsr" : s.upscaler || "lanczos";
  const placebo = placeboAvailable !== false;
  const number = (
    key: "vsrScale" | "vsrStrength",
    label: string,
    min: number,
    max: number,
  ) => (
    <Field id={key} label={label}>
      <input
        id={key}
        type="number"
        min={min}
        max={max}
        step="0.01"
        value={s[key]}
        onChange={(e) => set(key, Number(e.target.value))}
      />
    </Field>
  );
  // Things that stop ArtCNN from doing what the user expects.
  const warnings = [
    upscaler === "artcnn" &&
      s.resizeMode === "source" &&
      t("rtx.noResizeWarning"),
    upscaler === "artcnn" &&
      s.alphaMode === "preserve" &&
      t("rtx.alphaWarning"),
    !placebo && t("rtx.vulkanWarning"),
  ].filter(Boolean) as string[];
  const message =
    verification.messageData?.code === "RTX_SETTINGS_CHANGED"
      ? t("rtx.changed")
      : verification.messageData?.code === "RTX_FAILED" &&
          verification.errorData
        ? t("message.RTX_FAILED", {
            detail: errorMessage(verification.errorData),
          })
        : summaryMessage(verification.messageData || verification.message);
  return (
    <>
      <section className="settings-group">
        <Select
          id="upscaler"
          label={t("rtx.upscaler")}
          value={upscaler}
          options={[
            { value: "lanczos", label: t("rtx.lanczos") },
            {
              value: "artcnn",
              label: t("rtx.artcnn"),
              disabled: !placebo && upscaler !== "artcnn",
            },
            { value: "vsr", label: t("rtx.vsr") },
          ]}
          onChange={(v) =>
            patch(
              v === "vsr"
                ? // VSR sets the size itself (VSR 倍率).
                  { vsr: true, resizeMode: "source" }
                : { vsr: false, upscaler: v as Settings["upscaler"] },
            )
          }
          help={
            upscaler === "vsr"
              ? t("rtx.vsrHint")
              : upscaler === "artcnn"
                ? t("rtx.artcnnHint")
                : t("rtx.lanczosHint")
          }
        />
        {upscaler === "artcnn" && (
          <Select
            id="artcnnModel"
            label={t("rtx.artcnnModel")}
            value={s.artcnnModel || "C4F16"}
            options={[
              { value: "C4F16", label: t("rtx.artcnn16") },
              { value: "C4F32", label: t("rtx.artcnn32") },
            ]}
            onChange={(v) => set("artcnnModel", v as Settings["artcnnModel"])}
            help={t("rtx.artcnnModelHint")}
          />
        )}
        {s.vsr && (
          <>
            <div className="form-row">
              {number("vsrScale", t("rtx.vsrScale"), 1, 4)}
              {number("vsrStrength", t("rtx.vsrStrength"), 0, 1)}
            </div>
            <Select
              id="vsrQuality"
              label="NVIDIA QualityLevel"
              value={s.vsrQuality}
              options={[
                0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21,
                23,
              ].map((v) => ({
                value: v,
                label: t("rtx.qualityOption", {
                  level: localeRuntime.number(v),
                  mode:
                    v === 0
                      ? t("rtx.qualityBaseline")
                      : v <= 4
                        ? t("rtx.qualityUpscale")
                        : v <= 11
                          ? t("rtx.qualityDenoise")
                          : v <= 15
                            ? t("rtx.qualityDeblur")
                            : v <= 19
                              ? t("rtx.qualityDetail")
                              : v === 21
                                ? "Streaming Medium"
                                : "Streaming Ultra",
                }),
              }))}
              onChange={(v) => set("vsrQuality", Number(v))}
              help={t("rtx.qualityHint")}
            />
          </>
        )}
        {warnings.length > 0 && (
          <ul className="settings-warnings" role="alert">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-group">
        <label className="checkbox-row">
          <input
            id="vfg"
            type="checkbox"
            checked={s.vfg}
            onChange={(e) => set("vfg", e.target.checked)}
          />
          <span>
            {t("rtx.vfg")}
            <small className="hint">{t("rtx.vfgHint")}</small>
          </span>
        </label>
        {s.vfg && (
          <>
            <div className="form-row">
              <Select
                id="vfgMultiplier"
                label={t("rtx.multiplier")}
                value={s.vfgMultiplier}
                options={[2, 3, 4, 5, 6, 7, 8].map((v) => ({
                  value: v,
                  label: t("rtx.multiplierOption", {
                    value: localeRuntime.number(v),
                  }),
                }))}
                onChange={(v) => set("vfgMultiplier", Number(v))}
                help={t("rtx.multiplierHint", {
                  value: localeRuntime.number(s.vfgMultiplier),
                })}
              />
              <Select
                id="vfgMode"
                label={t("rtx.vfgModel")}
                value={s.vfgMode}
                options={[
                  { value: "low", label: t("rtx.vfgLow") },
                  { value: "medium", label: t("rtx.vfgMedium") },
                  { value: "high", label: t("rtx.vfgHigh") },
                ]}
                onChange={(v) => set("vfgMode", v)}
              />
            </div>
            <Field
              id="vfgModelDir"
              label={t("rtx.modelDirectory")}
              help={t("rtx.modelDirectoryHint")}
            >
              <div className="path-picker">
                <input id="vfgModelDir" readOnly value={s.vfgModelDir} />
                <Button
                  onClick={async () => {
                    const selected = await call("pickDirectory");
                    if (selected) set("vfgModelDir", selected);
                  }}
                >
                  {t("rtx.pickModelDirectory")}
                </Button>
              </div>
            </Field>
          </>
        )}
      </section>

      {(s.vsr || s.vfg) && (
        <section className="rtx-check" aria-labelledby="rtx-check-title">
          <h3 id="rtx-check-title" className="settings-group-title">
            {t("rtx.checkTitle")}
          </h3>
          <p className="hint">{t("rtx.checkHint")}</p>
          <div className="rtx-check-row">
            <Button
              disabled={!canTest}
              onClick={() =>
                call("testEnhancements", { settings: s }).catch(() => {})
              }
            >
              {verification.busy ? t("rtx.checking") : t("rtx.check")}
            </Button>
            {message && (
              <p className="hint" role="status">
                {message}
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
