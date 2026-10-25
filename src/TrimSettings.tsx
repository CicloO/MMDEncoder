import { AudioLines, Wand2, FolderOpen, SlidersHorizontal } from "lucide-react";
import { Button, Field, Select } from "./components";
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
    <aside className="settings-column" aria-label="导出设置">
      <div className="section-heading">
        <div>
          <span className="eyebrow">输出控制</span>
          <h2>导出设置</h2>
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
              智能剪切
              <small className="hint hires-hint">
                切点精确到帧：只重新编码切点附近几帧，其余直接复制。仅限
                MMDEncoder 1.5.0 起导出的 H.264 / HEVC。
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
              按 MMD 帧号输入
              <small className="hint hires-hint">
                按 MMD 30 FPS 时间轴，从片段的起始帧算起；MMDEncoder
                导出的文件自动识别。
              </small>
            </span>
          </label>
          <Select
            id="trim-audio"
            label="音频"
            value={o.audioMode}
            disabled={running}
            options={Object.entries(AUDIO_MODES).map(([value, label]) => ({
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
                  选择音频
                </Button>
                <span className="path-text" title={o.audioFile}>
                  {o.audioFile || "尚未选择"}
                </span>
              </div>
              <Field
                id="trim-offset"
                label={o.mmdFrames ? "起点偏移 · MMD 帧" : "起点偏移 · 秒"}
                hint="正数：从音频此处开始；负数：视频开头先留空。"
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
                    title="以第一个片段的原视频声音为参考，自动算出起点偏移"
                    onClick={fillOffset}
                  >
                    <Wand2 size={15} />
                    {aligning ? "对齐中…" : "自动填写"}
                  </Button>
                  <Button
                    variant="ghost icon"
                    aria-label="音频对齐"
                    title="音频对齐：以第一个片段原视频的声音为参考检视、微调"
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
              label="音频格式"
              value={o.audioCodec}
              disabled={running}
              options={Object.entries(AUDIO_CODECS).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => set("audioCodec", v)}
            />
          )}
          {o.audioMode !== "none" && (
            <Select
              id="trim-fade"
              label="音频淡入淡出"
              value={String(o.fade ?? 0)}
              disabled={running}
              options={fadeOptions()}
              hint="只淡化成片首尾，片段接缝不淡化。"
              onChange={(v) => set("fade", Number(v))}
            />
          )}
          {o.audioMode !== "none" && o.audioCodec === "aac" && (
            <Select
              id="trim-kbps"
              label="音频码率"
              value={String(o.kbps)}
              disabled={running}
              options={[128, 192, 256, 320, 384, 512].map((b) => ({
                value: String(b),
                label: `${b} kbps`,
              }))}
              onChange={(v) => set("kbps", Number(v))}
            />
          )}
          <Select
            id="trim-location"
            label="输出位置"
            value={o.location}
            disabled={running}
            options={Object.entries(LOCATIONS).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("location", v)}
          />
          {o.location === "custom" && (
            <div className="file-pick">
              <Button disabled={running} onClick={onPickFolder}>
                <FolderOpen size={15} />
                选择文件夹
              </Button>
              <span className="path-text" title={o.outputDir}>
                {o.outputDir || "尚未选择"}
              </span>
            </div>
          )}
          <p className="hint">
            {smart
              ? "视频只重新编码切点附近几帧，其余直接复制；"
              : "视频直接复制，不重新压制；"}
            音频按采样点拼接，不足处补静音。不同文件的片段须编码参数一致。
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
