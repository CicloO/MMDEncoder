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
// ffprobe reads MP4, MOV, M4A and 3GP with one demuxer whose long name is
// always "QuickTime / MOV"; name that family by extension, then by brand.
const FAMILY: Record<string, string> = {
  mp4: "MP4",
  m4v: "MP4",
  m4a: "M4A",
  "3gp": "3GP",
  "3g2": "3G2",
  mov: "QuickTime / MOV",
};
export const containerName = (format: any, file = "") => {
  if (!String(format?.format_name || "").startsWith("mov,mp4")) {
    return format?.format_long_name || format?.format_name;
  }
  const ext = file.split(".").pop()?.toLowerCase() || "";
  if (FAMILY[ext]) return FAMILY[ext];
  return String(format?.tags?.major_brand || "").trim() === "qt"
    ? FAMILY.mov
    : FAMILY.mp4;
};
// "0", 0 and "0/0" mean unknown in ffprobe output (e.g. audio frame rate).
const known = (v: unknown) =>
  v === undefined || v === null || v === "" || v === 0 || v === "0"
    ? undefined
    : v;
const streamRows = (s: any): [string, unknown][] => [
  [t("details.codec"), s.codec_long_name || s.codec_name],
  [t("details.profile"), s.profile],
  [t("details.resolution"), s.width ? `${s.width} × ${s.height}` : undefined],
  [t("details.pixelFormat"), s.pix_fmt],
  [t("details.bitDepth"), known(s.bits_per_raw_sample || s.bits_per_sample)],
  [
    t("details.fps"),
    s.avg_frame_rate && s.avg_frame_rate !== "0/0"
      ? `${s.avg_frame_rate} / ${s.r_frame_rate}`
      : undefined,
  ],
  [
    t("details.colorSpace"),
    s.color_space
      ? `${s.color_space} / ${s.color_primaries || t("presentation.unknown")} / ${s.color_transfer || t("presentation.unknown")}`
      : undefined,
  ],
  [t("details.colorRange"), s.color_range],
  [
    t("details.sampleRate"),
    s.sample_rate
      ? t("details.hz", {
          rate: localeRuntime.number(Number(s.sample_rate), {
            useGrouping: false,
          }),
        })
      : undefined,
  ],
  [t("details.channels"), known(s.channel_layout || s.channels)],
  // MKV keeps the stream bitrate in the BPS tag.
  [t("details.streamBitrate"), kbps(s.bit_rate || s.tags?.BPS)],
  [t("details.duration"), clock(s.duration)],
];
export function MediaDetails({
  details,
  media = false,
}: {
  details: any;
  media?: boolean;
}) {
  // Before / after columns show the same rows per stream ("—" where one side
  // lacks a value), so their streams line up side by side.
  const section = ([key, label, peerKey]: string[]) => {
    const data = details?.[key];
    const peer = peerKey ? details?.[peerKey] : undefined;
    const peerStream = (s: any) =>
      peer?.streams?.find((p: any) => p.index === s.index);
    return (
      <section key={key}>
        <h3>{label}</h3>
        {!data ? (
          <p>{t("details.reading")}</p>
        ) : data.message ? (
          <p>{errorMessage(data)}</p>
        ) : (
          <>
            <p className="path-text" title={data.path}>
              {data.path}
            </p>
            <dl className="metadata-grid">
              <dt>{t("details.containerSize")}</dt>
              <dd>
                {containerName(data.format, data.path)} ·{" "}
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
                  {(() => {
                    const other = peerStream(s);
                    const otherRows = other ? streamRows(other) : [];
                    return streamRows(s)
                      .filter(
                        ([, v], i) =>
                          v !== undefined || otherRows[i]?.[1] !== undefined,
                      )
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v === undefined ? "—" : String(v)}</dd>
                        </div>
                      ));
                  })()}
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
          ["before", t("details.before"), "after"],
          ["after", t("details.after"), "before"],
        ].map(section)}
      </div>
      {details?.audio && section(["audio", t("details.replacement")])}
      {!media && section(["mask", t("details.mask")])}
      {!media && <p className="hint">{t("details.alphaHint")}</p>}
    </div>
  );
}
