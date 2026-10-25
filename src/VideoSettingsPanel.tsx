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
    <aside className="settings-column" aria-label="压制设置">
      <div className="section-heading">
        <div>
          <span className="eyebrow">输出控制</span>
          <h2>压制设置</h2>
        </div>
        <label
          className="job-own-toggle"
          title="开启后，下面的设置只用于当前选中的视频"
        >
          <input
            type="checkbox"
            checked={own}
            disabled={ownDisabled}
            onChange={(e) => onOwn(e.target.checked)}
          />
          <SlidersHorizontal size={16} />
          单独设置
        </label>
      </div>
      <div className="settings-panel">
        {own && (
          <div className="job-preset-note" role="status">
            <Info size={16} />
            <p>
              正在单独设置“{jobName}
              ”：这里的修改只用于这个视频；关闭“单独设置”后这些修改会清除。
            </p>
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
                ? `保存（覆盖“${activePresetLabel}”）`
                : "保存（先选择一个预设）"
            }
            aria-label="保存到当前预设"
            disabled={busy || !hasActivePreset || !modified}
            onClick={onOverwrite}
          >
            <Save size={17} />
          </Button>
          <Button title="另存为预设" aria-label="另存为预设" onClick={onSaveAs}>
            <FilePlus2 size={17} />
          </Button>
        </div>
        <div className="setting-tabs" role="group" aria-label="设置分类">
          {[
            { id: "encoding", name: "画质" },
            { id: "audio", name: "音频" },
            { id: "alpha", name: "透明通道" },
            { id: "rtx", name: "超分补帧" },
            { id: "output", name: "输出" },
            { id: "advanced", name: "高级" },
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
          <span>设置自动保存 · 全部待处理视频共用当前设置</span>
        </div>
      </div>
    </aside>
  );
}
