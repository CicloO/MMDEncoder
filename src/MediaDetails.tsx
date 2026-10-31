import { formatSize } from "./presentation";
import { localeRuntime, t, errorMessage } from "./i18n";

// ffprobe's "10.033333" → "00:00:10.033".
const clock = (v: unknown) => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) return undefined;
  const ms = Math.round(n * 1000);
  const integer = (value: number, digits: number) =>
    localeRuntime.number(value, {
      useGrouping: false,
      minimumIntegerDigits: digits,
      maximumFractionDigits: 0,
    });
  return t("details.clock", {
    hours: integer(Math.floor(ms / 3600000), 2),
    minutes: integer(Math.floor(ms / 60000) % 60, 2),
    seconds: integer(Math.floor(ms / 1000) % 60, 2),
    milliseconds: integer(ms % 1000, 3),
  });
};
// Whole kbps with thousands separators: "10,081 kbps".
const kbps = (bits: unknown) =>
  Number(bits)
    ? t("details.bitrate", {
        rate: localeRuntime.number(Math.round(Number(bits) / 1000)),
      })
    : undefined;
export function MediaDetails({
  details,
  media = false,
}: {
  details: any;
  media?: boolean;
}) {
  const section = ([key, label]: string[]) => {
    const data = details?.[key];
    return (
      <section key={key}>
        <h3>{label}</h3>
        {!data ? (
          <p>{t("details.reading")}</p>
        ) : data.message ? (
          <p>{errorMessage(data)}</p>
        ) : (
          <>
            <p className="path-text">{data.path}</p>
            <dl className="metadata-grid">
              <dt>{t("details.containerSize")}</dt>
              <dd>
                {data.format?.format_long_name} ·{" "}
                {formatSize(Number(data.format?.size))}
              </dd>
              <dt>{t("details.durationRate")}</dt>
              <dd>
                {clock(data.format?.duration) || t("presentation.unknown")} ·{" "}
                {kbps(data.format?.bit_rate) || t("presentation.unknown")}
              </dd>
            </dl>
            {data.streams?.map((s: any) => (
              <div key={s.index}>
                <h4>
                  {t("details.stream", {
                    type:
                      s.codec_type === "video"
                        ? t("details.video")
                        : s.codec_type === "audio"
                          ? t("details.audio")
                          : s.codec_type,
                    index: localeRuntime.number(s.index, {
                      useGrouping: false,
                    }),
                  })}
                </h4>
                <dl className="metadata-grid">
                  {Object.entries({
                    [t("details.codec")]: s.codec_long_name || s.codec_name,
                    [t("details.profile")]: s.profile,
                    [t("details.resolution")]: s.width
                      ? `${s.width} × ${s.height}`
                      : undefined,
                    [t("details.pixelFormat")]: s.pix_fmt,
                    [t("details.bitDepth")]:
                      s.bits_per_raw_sample || s.bits_per_sample,
                    [t("details.fps")]: s.avg_frame_rate
                      ? `${s.avg_frame_rate} / ${s.r_frame_rate}`
                      : undefined,
                    [t("details.colorSpace")]: s.color_space
                      ? `${s.color_space} / ${s.color_primaries || t("presentation.unknown")} / ${s.color_transfer || t("presentation.unknown")}`
                      : undefined,
                    [t("details.colorRange")]: s.color_range,
                    [t("details.sampleRate")]: s.sample_rate
                      ? t("details.hz", {
                          rate: localeRuntime.number(Number(s.sample_rate), {
                            useGrouping: false,
                          }),
                        })
                      : undefined,
                    [t("details.channels")]: s.channel_layout || s.channels,
                    // MKV keeps the stream bitrate in the BPS tag.
                    [t("details.streamBitrate")]: kbps(
                      s.bit_rate || s.tags?.BPS,
                    ),
                    [t("details.duration")]: clock(s.duration),
                  })
                    .filter(([, v]) => v !== undefined && v !== "0")
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}
            <details>
              <summary>{t("details.raw")}</summary>
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </details>
          </>
        )}
      </section>
    );
  };
  return (
    <div className="media-details">
      <div className="details-compare">
        {[
          ["before", t("details.before")],
          ["after", t("details.after")],
        ].map(section)}
      </div>
      {details?.audio && section(["audio", t("details.replacement")])}
      {!media && section(["mask", t("details.mask")])}
      {!media && <p className="hint">{t("details.alphaHint")}</p>}
    </div>
  );
}
