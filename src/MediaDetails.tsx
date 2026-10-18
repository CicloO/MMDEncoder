import { formatSize } from "./presentation";
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
                {data.format?.duration || "未知"} 秒 ·{" "}
                {data.format?.bit_rate
                  ? `${Number(data.format.bit_rate) / 1000} kbps`
                  : "未知"}
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
                    流码率: s.bit_rate
                      ? `${Number(s.bit_rate) / 1000} kbps`
                      : undefined,
                    时长: s.duration,
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
