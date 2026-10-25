import { t } from "./i18n";
import { SlidersHorizontal, Info, Save, FilePlus2, Check } from "lucide-react";
import { Button } from "./components";
import { PresetChoice } from "./PresetChoice";
import type { Preset } from "./types";
import type { ReactNode } from "react";
export function VideoSettingsPanel({
  own,
  ownDisabled,
  jobName,
  onOwn,
  presets,
  presetId,
  modified,
  presetHidden,
  onSelectPreset,
  hasActivePreset,
  activePresetLabel,
  busy,
  onOverwrite,
  onSaveAs,
  tab,
  setTab,
  children,
}: {
  own: boolean;
  ownDisabled: boolean;
  jobName: string;
  onOwn: (on: boolean) => void;
  presets: Preset[];
  presetId: string;
  modified: boolean;
  presetHidden: (p: Preset) => boolean;
  onSelectPreset: (id: string) => void;
  hasActivePreset: boolean;
  activePresetLabel: string;
  busy: boolean;
  onOverwrite: () => void;
  onSaveAs: () => void;
  tab: string;
  setTab: (tab: string) => void;
  children: ReactNode;
}) {
  return (
    <aside className="settings-column" aria-label={t("video.settings")}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t("video.outputControl")}</span>
          <h2>{t("video.settings")}</h2>
        </div>
        <label className="job-own-toggle" title={t("video.ownHint")}>
          <input
            type="checkbox"
            checked={own}
            disabled={ownDisabled}
            onChange={(e) => onOwn(e.target.checked)}
          />
          <SlidersHorizontal size={16} />
          {t("video.own")}
        </label>
      </div>
      <div className="settings-panel">
        {own && (
          <div className="job-preset-note" role="status">
            <Info size={16} />
            <p>{t("video.ownNote", { name: jobName })}</p>
          </div>
        )}
        <div className="preset-bar">
          <PresetChoice
            presets={presets}
            value={presetId}
            modified={modified}
            hidden={presetHidden}
            onChange={onSelectPreset}
          />
          <Button
            title={
              hasActivePreset
                ? t("video.saveOverwrite", { name: activePresetLabel })
                : t("video.saveNeedsPreset")
            }
            aria-label={t("video.savePreset")}
            disabled={busy || !hasActivePreset || !modified}
            onClick={onOverwrite}
          >
            <Save size={17} />
          </Button>
          <Button
            title={t("video.saveAsPreset")}
            aria-label={t("video.saveAsPreset")}
            onClick={onSaveAs}
          >
            <FilePlus2 size={17} />
          </Button>
        </div>
        <div
          className="setting-tabs"
          role="group"
          aria-label={t("video.categories")}
        >
          {[
            { id: "encoding", name: t("video.tab.encoding") },
            { id: "audio", name: t("video.tab.audio") },
            { id: "alpha", name: t("video.tab.alpha") },
            { id: "rtx", name: t("video.tab.rtx") },
            { id: "output", name: t("video.tab.output") },
            { id: "advanced", name: t("video.tab.advanced") },
          ].map((t) => (
            <button
              key={t.id}
              aria-pressed={tab === t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
        {children}
        <div className="settings-foot">
          <Check size={13} />
          <span>{t("video.autoSave")}</span>
        </div>
      </div>
    </aside>
  );
}
