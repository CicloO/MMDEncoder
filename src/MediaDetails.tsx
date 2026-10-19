import { formatSize } from "./presentation";

// ffprobe's "10.033333" → "00:00:10.033".
const clock = (v: unknown) => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) return undefined;
  const ms = Math.round(n * 1000);
  const hms = [
    Math.floor(ms / 3600000),
    Math.floor(ms / 60000) % 60,
    Math.floor(ms / 1000) % 60,
  ]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
  return `${hms}.${String(ms % 1000).padStart(3, "0")}`;
};
// Whole kbps with thousands separators: "10,081 kbps".
const kbps = (bits: unknown) =>
  Number(bits)
    ? `${Math.round(Number(bits) / 1000).toLocaleString("en-US")} kbps`
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
          <p>正在读取实际文件…</p>
        ) : data.message ? (
          <p>{data.message}</p>
        ) : (
          <>
            <p className="path-text">{data.path}</p>
            <dl className="metadata-grid">
              <dt>封装 / 大小</dt>
              <dd>
                {data.format?.format_long_name} ·{" "}
                {formatSize(Number(data.format?.size))}
              </dd>
              <dt>时长 / 总码率</dt>
              <dd>
                {clock(data.format?.duration) || "未知"} ·{" "}
                {kbps(data.format?.bit_rate) || "未知"}
              </dd>
            </dl>
            {data.streams?.map((s: any) => (
              <div key={s.index}>
                <h4>
                  {s.codec_type === "video"
                    ? "视频"
                    : s.codec_type === "audio"
                      ? "音频"
                      : s.codec_type}
                  流 #{s.index}
                </h4>
                <dl className="metadata-grid">
                  {Object.entries({
                    编码: s.codec_long_name || s.codec_name,
                    Profile: s.profile,
                    分辨率: s.width ? `${s.width} × ${s.height}` : undefined,
                    像素格式: s.pix_fmt,
                    位深: s.bits_per_raw_sample || s.bits_per_sample,
                    "帧率 (平均 / 标记)": s.avg_frame_rate
                      ? `${s.avg_frame_rate} / ${s.r_frame_rate}`
                      : undefined,
                    "色彩空间 / 原色 / 传递": s.color_space
                      ? `${s.color_space} / ${s.color_primaries || "未知"} / ${s.color_transfer || "未知"}`
                      : undefined,
                    色彩范围: s.color_range,
                    音频采样率: s.sample_rate
                      ? `${s.sample_rate} Hz`
                      : undefined,
                    声道: s.channel_layout || s.channels,
                    // MKV keeps the stream bitrate in the BPS tag.
                    流码率: kbps(s.bit_rate || s.tags?.BPS),
                    时长: clock(s.duration),
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
              <summary>完整 ffprobe 数据</summary>
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
          ["before", "转换前"],
          ["after", "转换后"],
        ].map(section)}
      </div>
      {details?.audio && section(["audio", "替换用的音频"])}
      {!media && section(["mask", "独立 Alpha 遮罩"])}
      {!media && (
        <p className="hint">
          HEVC 辅助 Alpha 层不一定由 ffprobe 像素格式显示；本机能力检测另验证
          Alpha 码流信息。
        </p>
      )}
    </div>
  );
}
