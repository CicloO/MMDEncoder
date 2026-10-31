import { FolderOpen, SlidersHorizontal } from "lucide-react";
import { Button, Select } from "./components";
import { AlignmentIcon } from "./AlignmentIcon";
import { t as text, localeRuntime } from "./i18n";
import { fadeOptions } from "./presentation";
import {
  AUDIO_MODES,
  AUDIO_CODECS,
  LOCATIONS,
  type Options,
} from "./trimOptions";
export function TrimSettings({
  o,
  running,
  smart,
  error,
  aligning,
  audioFile,
  hasExportable,
  set,
  onSmart,
  onPickAudio,
  onAlign,
  onPickFolder,
}: {
  o: Options;
  running: boolean;
  smart: boolean;
  error: string;
  aligning: boolean;
  audioFile: string;
  hasExportable: boolean;
  set: <K extends keyof Options>(key: K, value: Options[K]) => void;
  onSmart: (value: boolean) => unknown;
  onPickAudio: () => unknown;
  onAlign: () => void;
  onPickFolder: () => unknown;
}) {
  return (
    <aside className="settings-column" aria-label={text("trim.exportSettings")}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{text("trim.outputControl")}</span>
          <h2>{text("trim.exportSettings")}</h2>
        </div>
        <SlidersHorizontal size={20} className="muted" />
      </div>
      <div className="settings-panel">
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          className="settings-body"
        >
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={smart}
              disabled={running}
              onChange={(e) => onSmart(e.target.checked)}
            />
            <span>
              {text("trim.smart")}
              <small className="hint">{text("trim.smartHint")}</small>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={o.mmdFrames}
              onChange={(e) => set("mmdFrames", e.target.checked)}
            />
            <span>
              {text("trim.mmdFrames")}
              <small className="hint">{text("trim.mmdFramesHint")}</small>
            </span>
          </label>
          <Select
            id="trim-audio"
            label={text("trim.audio")}
            value={o.audioMode}
            disabled={running}
            options={Object.entries(AUDIO_MODES()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("audioMode", v)}
          />
          {o.audioMode === "replace" && (
            <>
              <div className="file-pick">
                <Button disabled={running} onClick={onPickAudio}>
                  <FolderOpen size={15} />
                  {text("trim.chooseAudio")}
                </Button>
                <span className="path-text" title={audioFile}>
                  {audioFile || text("trim.notChosen")}
                </span>
                <Button
                  variant="ghost icon"
                  aria-label={text("trim.align")}
                  aria-busy={aligning}
                  title={text("trim.alignHint")}
                  disabled={running || !audioFile || !hasExportable}
                  onClick={() => onAlign()}
                >
                  <AlignmentIcon active={aligning} />
                </Button>
              </div>
            </>
          )}
          {o.audioMode !== "none" && (
            <Select
              id="trim-audio-codec"
              label={text("trim.audioCodec")}
              value={o.audioCodec}
              disabled={running}
              options={Object.entries(AUDIO_CODECS()).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => set("audioCodec", v)}
            />
          )}
          {o.audioMode !== "none" && (
            <Select
              id="trim-fade"
              label={text("trim.fade")}
              value={String(o.fade ?? 0)}
              disabled={running}
              options={fadeOptions()}
              hint={text("trim.fadeHint")}
              onChange={(v) => set("fade", Number(v))}
            />
          )}
          {o.audioMode !== "none" && o.audioCodec === "aac" && (
            <Select
              id="trim-kbps"
              label={text("trim.bitrate")}
              value={String(o.kbps)}
              disabled={running}
              options={[128, 192, 256, 320, 384, 512].map((b) => ({
                value: String(b),
                label: `${localeRuntime.number(b)} kbps`,
              }))}
              onChange={(v) => set("kbps", Number(v))}
            />
          )}
          <Select
            id="trim-location"
            label={text("trim.location")}
            value={o.location}
            disabled={running}
            options={Object.entries(LOCATIONS()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("location", v)}
          />
          {o.location === "custom" && (
            <div className="file-pick">
              <Button disabled={running} onClick={onPickFolder}>
                <FolderOpen size={15} />
                {text("trim.chooseFolder")}
              </Button>
              <span className="path-text" title={o.outputDir}>
                {o.outputDir || text("trim.notChosen")}
              </span>
            </div>
          )}
          <p className="hint">
            {text(smart ? "trim.exportHint.smart" : "trim.exportHint.copy")}
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
