import { AudioLines, Wand2, FolderOpen, SlidersHorizontal } from "lucide-react";
import { Button, Field, Select } from "./components";
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
  hasExportable,
  set,
  onSmart,
  onPickAudio,
  onAlign,
  fillOffset,
  onPickFolder,
}: {
  o: Options;
  running: boolean;
  smart: boolean;
  error: string;
  aligning: boolean;
  hasExportable: boolean;
  set: <K extends keyof Options>(key: K, value: Options[K]) => void;
  onSmart: (value: boolean) => unknown;
  onPickAudio: () => unknown;
  onAlign: () => void;
  fillOffset: () => unknown;
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
              <small className="hint hires-hint">
                {text("trim.smartHint")}
              </small>
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
              <small className="hint hires-hint">
                {text("trim.mmdFramesHint")}
              </small>
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
                <span className="path-text" title={o.audioFile}>
                  {o.audioFile || text("trim.notChosen")}
                </span>
              </div>
              <Field
                id="trim-offset"
                label={
                  o.mmdFrames
                    ? text("trim.offsetMmd")
                    : text("trim.offsetSeconds")
                }
                hint={text("trim.offsetHint")}
              >
                <div className="path-picker">
                  <input
                    id="trim-offset"
                    inputMode="decimal"
                    value={o.offset}
                    disabled={running}
                    onChange={(e) => set("offset", e.target.value)}
                  />
                  <Button
                    disabled={
                      running || !o.audioFile || !hasExportable || !!aligning
                    }
                    title={text("trim.autoFillHint")}
                    onClick={fillOffset}
                  >
                    <Wand2 size={15} />
                    {aligning ? text("trim.aligning") : text("trim.autoFill")}
                  </Button>
                  <Button
                    variant="ghost icon"
                    aria-label={text("trim.align")}
                    title={text("trim.alignHint")}
                    disabled={running || !o.audioFile || !hasExportable}
                    onClick={() => onAlign()}
                  >
                    <AudioLines size={16} />
                  </Button>
                </div>
              </Field>
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
