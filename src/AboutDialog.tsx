import { BrandMark } from "./BrandMark";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ExternalLink,
  FolderOpen,
  Globe,
  MessageSquareWarning,
  RefreshCw,
} from "lucide-react";
import { Button, Modal, Select } from "./components";
import { formatSize } from "./presentation";
import { t as text, errorMessage, type ErrorData } from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import registry from "../locales/registry.json";
import { invoke } from "./ipc";

export type UpdateCheck = {
  checking: boolean;
  current?: string;
  latest?: string;
  newer?: boolean;
  url?: string;
  error?: string;
  errorData?: ErrorData;
  canInstall?: boolean;
  installBlocked?: string;
  installBlockedData?: ErrorData | null;
  assets?: { size: number; kind?: "app" | "full" } | null;
};
export type AppUpdate = {
  phase: string;
  received: number;
  total: number;
  error: string;
  errorData?: ErrorData | null;
  packageKind?: "app" | "full";
  fallbackData?: ErrorData | null;
};

export function AboutDialog({
  open,
  onClose,
  update,
  appUpdate,
  localePreference,
  systemLocale,
  accent = "cyan",
  autoAlignAudio = true,
  blocked,
  onCheck,
  onDownload,
  onInstall,
  action,
}: {
  open: boolean;
  onClose: () => void;
  update: UpdateCheck;
  appUpdate: AppUpdate;
  localePreference: string | null;
  systemLocale: string;
  accent?: "blue" | "cyan";
  autoAlignAudio?: boolean;
  // Why installing has to wait (an encode is running), "" when it can go.
  blocked: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  action: (name: string, payload?: unknown) => void;
}) {
  const [info, setInfo] = useState<{ version: string }>({
    version: __APP_VERSION__,
  });
  const [languagePending, setLanguagePending] = useState(false);
  const [languageError, setLanguageError] = useState<ErrorData | string>("");
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceError, setPreferenceError] = useState<ErrorData | null>(
    null,
  );
  async function changePreference(name: string, payload: unknown) {
    setPreferencePending(true);
    setPreferenceError(null);
    try {
      await invoke(name, payload);
    } catch (error) {
      setPreferenceError(serializeError(error));
    } finally {
      setPreferencePending(false);
    }
  }
  const languageLabel = `${text("about.language")} · Language`;
  const systemName =
    registry.locales.find((l) => l.id === systemLocale)?.name ||
    registry.locales[0].name;
  async function changeLanguage(value: string) {
    setLanguagePending(true);
    setLanguageError("");
    try {
      await invoke("setLocale", { locale: value === "system" ? null : value });
    } catch (error) {
      setLanguageError(serializeError(error));
    } finally {
      setLanguagePending(false);
    }
  }
  useEffect(() => {
    if (open && window.encoder)
      invoke("aboutInfo")
        .then(setInfo)
        .catch(() => {});
  }, [open]);
  const working = ["downloading", "extracting", "installing"].includes(
    appUpdate.phase,
  );
  const status = update.checking
    ? text("about.checking")
    : update.error || update.errorData
      ? text("about.checkFailed", {
          detail: errorMessage(update.errorData || update.error),
        })
      : update.newer
        ? text("about.updateAvailable", { version: update.latest ?? "" })
        : update.current
          ? update.latest
            ? text("about.upToDate")
            : text("about.noReleases")
          : text("about.notChecked");
  const tone =
    update.error || update.errorData ? "danger" : update.newer ? "new" : "";
  const updateError = errorMessage(appUpdate.errorData || appUpdate.error);
  const started = appUpdate.phase !== "idle";
  const packageSize = started ? appUpdate.total : update.assets?.size;
  const packageKind = started ? appUpdate.packageKind : update.assets?.kind;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={text("about.title")}
      description={text("about.description")}
      fixedHeight
    >
      <div className="about-hero">
        <span className="brand-icon" aria-hidden="true">
          <BrandMark />
        </span>
        <p className="about-name">
          MMD<span>Encoder</span>
        </p>
        <p className="about-version">
          <span>{text("about.version")}</span>
          <strong>{info.version}</strong>
        </p>
      </div>
      <div className="about-ticks" aria-hidden="true" />

      <section
        className="modal-section"
        aria-label={text("about.softwareUpdate")}
        aria-busy={update.checking}
      >
        <div className="status-row">
          <p className={`about-status ${tone}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {status}
          </p>
          <div className="row-actions">
            <Button disabled={update.checking || working} onClick={onCheck}>
              <RefreshCw size={15} />
              {text("about.check")}
            </Button>
            {update.newer && update.canInstall && (
              <Button
                variant="primary"
                disabled={working || (appUpdate.phase === "ready" && !!blocked)}
                title={appUpdate.phase === "ready" ? blocked : undefined}
                onClick={appUpdate.phase === "ready" ? onInstall : onDownload}
              >
                <ArrowDownToLine size={15} />
                {appUpdate.phase === "ready"
                  ? text("about.restart")
                  : appUpdate.phase === "downloading"
                    ? text("about.downloading")
                    : appUpdate.phase === "extracting"
                      ? text("about.extracting")
                      : text("about.download")}
              </Button>
            )}
            <Button
              variant={
                update.newer && !update.canInstall ? "primary" : undefined
              }
              onClick={() =>
                action("openReleasePage", {
                  url: update.newer ? update.url : "",
                })
              }
            >
              <ExternalLink size={15} />
              {text(update.newer ? "about.downloadPage" : "about.releases")}
            </Button>
          </div>
        </div>
        {update.newer && update.canInstall && !!packageSize && (
          <p className="hint">
            {text("about.packageSize", {
              kind: text(
                packageKind === "app"
                  ? "about.appPackage"
                  : "about.fullPackage",
              ),
              size: formatSize(packageSize),
            })}
          </p>
        )}
        {update.newer && appUpdate.fallbackData && (
          <p className="hint" role="status">
            {text("about.fullFallback", {
              detail: errorMessage(appUpdate.fallbackData),
            })}
          </p>
        )}
        {update.newer && (
          <p
            className={updateError ? "inline-error" : "hint"}
            role={updateError ? "alert" : undefined}
          >
            {updateError
              ? text("about.updateFailed", { detail: updateError })
              : appUpdate.phase === "downloading"
                ? text(
                    appUpdate.total
                      ? "about.downloadedKnown"
                      : "about.downloaded",
                    {
                      received: formatSize(appUpdate.received),
                      total: formatSize(appUpdate.total),
                    },
                  )
                : appUpdate.phase === "ready"
                  ? blocked || text("about.readyHint")
                  : update.canInstall
                    ? text("about.downloadHint")
                    : errorMessage(
                        update.installBlockedData || update.installBlocked,
                      ) || text("about.manualHint")}
          </p>
        )}
      </section>

      <section
        className="modal-section about-preferences"
        aria-label={text("about.preferences")}
      >
        <h3>{text("about.preferences")}</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={autoAlignAudio}
            disabled={preferencePending}
            aria-label={text("about.autoAlignAudio")}
            aria-describedby="about-auto-align-hint"
            onChange={(event) =>
              void changePreference("setAutoAlignAudio", {
                enabled: event.target.checked,
              })
            }
          />
          <span>
            {text("about.autoAlignAudio")}
            <span className="hint" id="about-auto-align-hint">
              {text("about.autoAlignAudioHint")}
            </span>
          </span>
        </label>
        <Select
          id="about-accent"
          label={text("about.accent")}
          value={accent}
          disabled={preferencePending}
          options={[
            { value: "cyan", label: text("about.accentCyan") },
            { value: "blue", label: text("about.accentBlue") },
          ]}
          onChange={(value) =>
            void changePreference("setAccent", { accent: value })
          }
          hint={text("about.accentHint")}
        />
        {preferenceError && (
          <p className="inline-error" role="alert">
            {errorMessage(preferenceError)}
          </p>
        )}
      </section>
      {registry.locales.length >= 2 && (
        <section
          className="modal-section about-language"
          aria-label={languageLabel}
          aria-busy={languagePending}
        >
          <Select
            id="about-locale"
            label={
              <span
                className="about-language-label"
                role="heading"
                aria-level={3}
              >
                <Globe size={18} aria-hidden="true" />
                {languageLabel}
              </span>
            }
            value={localePreference ?? "system"}
            disabled={languagePending}
            options={[
              {
                value: "system",
                label: text("about.followSystem", { language: systemName }),
              },
              ...registry.locales.map(({ id, name }) => ({
                value: id,
                label: name,
              })),
            ]}
            onChange={(value) => void changeLanguage(value)}
            hint={text("about.languageHint")}
          />
          {languageError && (
            <p className="inline-error" role="alert">
              {text("about.languageFailed", {
                detail: errorMessage(languageError),
              })}
            </p>
          )}
        </section>
      )}
      <section className="modal-section" aria-label={text("about.support")}>
        <h3>{text("about.support")}</h3>
        <dl className="about-facts">
          <div>
            <dt>{text("about.author")}</dt>
            <dd>CicloO</dd>
          </div>
          <div>
            <dt>{text("about.collaboration")}</dt>
            <dd>{text("about.collaborators")}</dd>
          </div>
          <div>
            <dt>{text("about.license")}</dt>
            <dd>
              <button
                type="button"
                className="text-link"
                onClick={() => action("openProjectPage", { page: "license" })}
              >
                Mozilla Public License 2.0
              </button>
            </dd>
          </div>
          <div>
            <dt>{text("about.thirdParty")}</dt>
            <dd>
              <button
                type="button"
                className="text-link"
                onClick={() => action("openProjectPage", { page: "notices" })}
              >
                {text("about.notices")}
              </button>
            </dd>
          </div>
        </dl>
        <p className="hint">{text("about.feedbackHint")}</p>
        <div className="row-actions">
          <Button onClick={() => action("openProjectPage", { page: "home" })}>
            <ExternalLink size={15} />
            {text("about.home")}
          </Button>
          <Button onClick={() => action("openProjectPage", { page: "issues" })}>
            <MessageSquareWarning size={15} />
            {text("about.feedback")}
          </Button>
          <Button onClick={() => action("openDataFolder")}>
            <FolderOpen size={15} />
            {text("about.data")}
          </Button>
        </div>
      </section>
    </Modal>
  );
}
