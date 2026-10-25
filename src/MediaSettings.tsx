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
    <aside className="settings-column" aria-label="处理设置">
      <div className="section-heading">
        <div>
          <span className="eyebrow">输出控制</span>
          <h2>处理设置</h2>
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
            label="操作"
            value={o.operation}
            disabled={locked}
            options={Object.entries(OPERATIONS).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("operation", v)}
          />
          {o.operation !== "video" && (
            <Select
              id="media-format"
              label="输出音频"
              value={o.audioFormat}
              disabled={locked}
              options={Object.entries(FORMATS).map(([value, label]) => ({
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
                Hi-Res 音频（24-bit，低于 48 kHz 时升到 2 倍采样率）
                <small className="hint hires-hint">
                  {!HIRES_FORMATS.includes(o.audioFormat)
                    ? "仅 WAV / FLAC 可用。"
                    : (hiResText(
                        o.operation === "merge"
                          ? selected?.audioMeta
                          : selected?.meta?.audio,
                      ) ||
                        (o.operation === "merge"
                          ? "选择替换音频后显示转换结果"
                          : "读取文件后显示转换结果")) +
                      (o.operation === "merge" ? "，输出 MKV。" : "。") +
                      "升采样不会提高音质。"}
                </small>
              </span>
            </label>
          )}
          {o.operation !== "video" && (
            <Select
              id="media-fade"
              label="音频淡入淡出"
              value={String(o.audioFormat === "copy" ? 0 : o.audioFade)}
              disabled={locked || o.audioFormat === "copy"}
              options={fadeOptions()}
              hint={
                o.audioFormat === "copy" ? "复制原音轨时不能淡化。" : fadeHint()
              }
              onChange={(v) => set("audioFade", Number(v))}
            />
          )}
          {o.operation !== "video" && LOSSY.includes(o.audioFormat) && (
            <Select
              id="media-bitrate"
              label="音频码率"
              value={String(bitrate)}
              disabled={locked}
              options={BITRATES.filter(
                (b) => b <= MAX_BITRATE[o.audioFormat],
              ).map((b) => ({
                value: String(b),
                label: b ? `${b} kbps` : "跟随源文件（无损源用 320 kbps）",
              }))}
              onChange={(v) => set("audioBitrate", Number(v))}
            />
          )}
          {o.operation !== "audio" && (
            <Select
              id="media-container"
              label="输出格式"
              value={o.container}
              disabled={locked}
              options={Object.entries(CONTAINERS).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => set("container", v)}
            />
          )}
          {o.operation === "merge" && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                disabled={locked}
                checked={o.autoAlign}
                onChange={(e) => set("autoAlign", e.target.checked)}
              />
              <span>
                选择音频后自动对齐
                <small className="hint hires-hint">
                  以视频自带的声音为参考；对不上时不应用，可点队列里的波形按钮检视、微调。
                </small>
              </span>
            </label>
          )}
          <Select
            id="media-location"
            label="输出位置"
            value={o.location}
            disabled={locked}
            options={Object.entries(LOCATIONS).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("location", v)}
          />
          {o.location === "custom" && (
            <Field id="media-output-dir" label="自定义文件夹">
              <div className="path-picker">
                <input
                  id="media-output-dir"
                  value={o.outputDir}
                  readOnly
                  title={o.outputDir}
                  placeholder="选择输出文件夹"
                />
                <Button disabled={locked} onClick={pickFolder}>
                  选择
                </Button>
              </div>
            </Field>
          )}
          <p className="hint">
            {o.operation === "audio"
              ? "只输出第一条音频流。"
              : `视频直接复制，不重新压制${o.container === "mp4" ? "；MP4 放不下时自动改用 MKV" : ""}。${o.operation === "merge" ? (o.audioFormat === "copy" ? "时长与视频相同，音频长了截掉。" : "时长与视频相同：音频长了截掉，短了补静音。") : ""}`}
            已有文件不覆盖。
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
