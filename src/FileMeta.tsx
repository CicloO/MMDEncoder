import { formatDuration, formatFPS, formatSize } from "./presentation";
import type { MediaMeta } from "./types";
import { localeRuntime, t } from "./i18n";

type Audio = NonNullable<MediaMeta["audio"]>;
const channelName = (a: Audio) =>
  a.channels === 2
    ? t("meta.stereo")
    : a.channelLayout ||
      t("meta.channels", {
        count: a.channels,
        quantity: localeRuntime.number(a.channels, { useGrouping: false }),
      });
const sampleRate = (a: Audio) =>
  t("meta.sampleRate", {
    rate: localeRuntime.number(a.sampleRate / 1000, { useGrouping: false }),
  });
const channelText = (a: Audio) => [sampleRate(a), channelName(a)].join(" / ");
// e.g. "AAC LC · 317 kbps · 48 kHz / 立体声"; PCM shows its codec name.
const audioName = (a: Audio) =>
  a.codec?.startsWith("pcm_")
    ? `PCM ${a.codec.replace(/^pcm_/, "").toUpperCase()}`
    : [a.codec?.toUpperCase() || t("presentation.unknown"), a.profile]
        .filter(Boolean)
        .join(" ");
// Lossless streams (FLAC in MKV etc.) often record no bitrate; say so instead.
const LOSSLESS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|truehd$|mlp$)/;
const rateText = (a: Audio) =>
  a.bitRate
    ? t("meta.bitrate", {
        rate: localeRuntime.number(Math.round(a.bitRate / 1000), {
          useGrouping: false,
        }),
      })
    : LOSSLESS.test(a.codec || "")
      ? t("meta.lossless")
      : "";
// Separate items for the parameter rows, matching the video row's style.
const audioParts = (a: Audio) =>
  [audioName(a), rateText(a), sampleRate(a), channelName(a)].filter(Boolean);
// Audio part for queue rows: just the bitrate ("317 kbps" / "无损").
const audioShort = (a?: Audio) => (a ? rateText(a) : t("meta.noAudio"));
const audioText = (a: Audio) =>
  [audioName(a), rateText(a), channelText(a)].filter(Boolean).join(" · ");

// Video bitrate in Mbps: "0.85" / "9.86" / "48.3" / "236".
const mbps = (bits?: number) => {
  if (!bits) return "";
  const m = bits / 1e6;
  const digits = m >= 100 ? 0 : m >= 10 ? 1 : 2;
  return localeRuntime.number(m, {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

// A PNG sequence's size is added up after it is usable.
const sizeText = (meta: MediaMeta) =>
  meta.sizing ? t("meta.sizing") : formatSize(meta.size);

// One-line summary for queue rows.
export function metaSummary(meta: MediaMeta) {
  const video = mbps(meta.videoBitRate);
  return meta.audioOnly
    ? `${meta.audio ? audioText(meta.audio) : meta.codec.toUpperCase()} · ${formatDuration(meta.duration)} · ${sizeText(meta)}`
    : t("meta.videoSummary", {
        width:
          meta.width === undefined
            ? t("presentation.unknown")
            : localeRuntime.number(meta.width, { useGrouping: false }),
        height:
          meta.height === undefined
            ? t("presentation.unknown")
            : localeRuntime.number(meta.height, { useGrouping: false }),
        fps: formatFPS(meta.fpsText || meta.fps || 0),
        details: [
          meta.sequence
            ? t("meta.pngCount", {
                count: meta.sequence.count,
                quantity: localeRuntime.number(meta.sequence.count, {
                  useGrouping: false,
                }),
              })
            : video && video + " Mbps",
          meta.sequence ? "" : audioShort(meta.audio),
          sizeText(meta),
        ]
          .filter(Boolean)
          .join(" · "),
      });
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
            {formatDuration(meta.duration)} <small>{t("meta.duration")}</small>
          </span>
        </div>
        <div className="metadata">
          {meta.audio && rateText(meta.audio) ? (
            <span>{rateText(meta.audio)}</span>
          ) : null}
          {meta.audio && <span>{channelText(meta.audio)}</span>}
          <span>{sizeText(meta)}</span>
          <span>{t("meta.audioOnly")}</span>
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
          <small>{meta.vfr ? t("meta.variableFps") : "FPS"}</small>
        </span>
        {mbps(meta.videoBitRate) && (
          <span>
            {mbps(meta.videoBitRate)} <small>Mbps</small>
          </span>
        )}
      </div>
      <div className="metadata">
        <span>
          {meta.sequence
            ? t("meta.pngFrames", {
                count: meta.sequence.count,
                quantity: localeRuntime.number(meta.sequence.count, {
                  useGrouping: false,
                }),
              })
            : meta.codec.toUpperCase()}
        </span>
        <span>{meta.pixFmt}</span>
        <span>
          {t("meta.bitDepth", {
            bits: meta.bitDepth || t("presentation.unknown"),
          })}
        </span>
        <span>{formatDuration(meta.duration)}</span>
        <span>{sizeText(meta)}</span>
        <span>{meta.hasAlpha ? t("meta.alpha") : t("meta.noAlpha")}</span>
      </div>
      <div className="metadata audio-row">
        <span className="metadata-label">{t("meta.audio")}</span>
        {meta.audio ? (
          audioParts(meta.audio).map((p) => <span key={p}>{p}</span>)
        ) : (
          <span>{t("meta.noAudio")}</span>
        )}
      </div>
    </>
  );
}
