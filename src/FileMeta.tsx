import { formatDuration, formatFPS, formatSize } from "./presentation";
import type { MediaMeta } from "./types";

type Audio = NonNullable<MediaMeta["audio"]>;
const channelText = (a: Audio) =>
  `${a.sampleRate / 1000} kHz / ${a.channels === 2 ? "立体声" : a.channelLayout || `${a.channels} 声道`}`;
// e.g. "AAC LC · 317 kbps · 48 kHz / 立体声"; PCM shows its codec name.
const audioName = (a: Audio) =>
  a.codec?.startsWith("pcm_")
    ? `PCM ${a.codec.replace(/^pcm_/, "").toUpperCase()}`
    : [a.codec?.toUpperCase() || "未知", a.profile].filter(Boolean).join(" ");
// Lossless streams (FLAC in MKV etc.) often record no bitrate; say so instead.
const LOSSLESS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|truehd$|mlp$)/;
const rateText = (a: Audio) =>
  a.bitRate
    ? `${Math.round(a.bitRate / 1000)} kbps`
    : LOSSLESS.test(a.codec || "")
      ? "无损"
      : "";
// Separate items for the parameter rows, matching the video row's style.
const audioParts = (a: Audio) =>
  [
    audioName(a),
    rateText(a),
    `${a.sampleRate / 1000} kHz`,
    a.channels === 2 ? "立体声" : a.channelLayout || `${a.channels} 声道`,
  ].filter(Boolean);
// Audio part for queue rows: just the bitrate ("317 kbps" / "无损").
const audioShort = (a?: Audio) => (a ? rateText(a) : "无音轨");
const audioText = (a: Audio) =>
  [audioName(a), rateText(a), channelText(a)].filter(Boolean).join(" · ");

// Video bitrate in Mbps: "0.85" / "9.86" / "48.3" / "236".
const mbps = (bits?: number) => {
  if (!bits) return "";
  const m = bits / 1e6;
  return m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
};

// One-line summary for queue rows.
export function metaSummary(meta: MediaMeta) {
  const video = mbps(meta.videoBitRate);
  return meta.audioOnly
    ? `${meta.audio ? audioText(meta.audio) : meta.codec.toUpperCase()} · ${formatDuration(meta.duration)} · ${formatSize(meta.size)}`
    : `${meta.width}×${meta.height} · ${formatFPS(meta.fpsText || meta.fps || 0)} FPS · ${[video && video + " Mbps", audioShort(meta.audio), formatSize(meta.size)].filter(Boolean).join(" · ")}`;
}

// Parameter block shown under "当前素材" / "当前文件".
export function FileMeta({ meta }: { meta: MediaMeta }) {
  if (meta.audioOnly)
    return (
      <>
        <div className="source-key">
          <span>
            {meta.audio ? audioName(meta.audio) : meta.codec.toUpperCase()}
          </span>
          <span>
            {formatDuration(meta.duration)} <small>时长</small>
          </span>
        </div>
        <div className="metadata">
          {meta.audio && rateText(meta.audio) ? (
            <span>{rateText(meta.audio)}</span>
          ) : null}
          {meta.audio && <span>{channelText(meta.audio)}</span>}
          <span>{formatSize(meta.size)}</span>
          <span>仅音频</span>
        </div>
      </>
    );
  return (
    <>
      <div className="source-key">
        <span>
          {meta.width} <small>×</small> {meta.height}
        </span>
        <span>
          {formatFPS(meta.fpsText || meta.fps || 0)}{" "}
          <small>FPS{meta.vfr ? " · 可变" : ""}</small>
        </span>
        {mbps(meta.videoBitRate) && (
          <span>
            {mbps(meta.videoBitRate)} <small>Mbps</small>
          </span>
        )}
      </div>
      <div className="metadata">
        <span>{meta.codec.toUpperCase()}</span>
        <span>{meta.pixFmt}</span>
        <span>{meta.bitDepth || "未知"}-bit</span>
        <span>{formatDuration(meta.duration)}</span>
        <span>{formatSize(meta.size)}</span>
        <span>{meta.hasAlpha ? "含 Alpha" : "无 Alpha"}</span>
      </div>
      <div className="metadata audio-row">
        <span className="metadata-label">音频</span>
        {meta.audio ? (
          audioParts(meta.audio).map((p) => <span key={p}>{p}</span>)
        ) : (
          <span>无音轨</span>
        )}
      </div>
    </>
  );
}
