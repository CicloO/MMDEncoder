import { Button, Field, Select } from "./components";
import { BackgroundColor } from "./BackgroundColor";
import { RtxSettings } from "./RtxSettings";
import { Copy, Folder, Info, Plus } from "lucide-react";
import {
  audioLabels,
  engineLabel,
  fadeOptions,
  fadeHint,
} from "./presentation";
import type { Settings, Engine, Job, Preview, State } from "./types";
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const frameOptions = [
  { value: "source", label: "保持源帧率" },
  ...["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({
    value:
      (
        {
          "23.976": "24000/1001",
          "29.97": "30000/1001",
          "59.94": "60000/1001",
        } as Record<string, string>
      )[v] || v,
    label: `${v} FPS`,
  })),
  { value: "custom", label: "自定义帧率" },
];

export function VideoSettings({
  s,
  tab,
  engine,
  backend,
  engines,
  detecting,
  verification,
  placebo,
  canTest,
  job,
  preview,
  customFPS,
  setCustomFPS,
  autoAlignAudio,
  setAutoAlignAudio,
  set,
  changed,
  call,
  copy,
  pickDirectory,
}: {
  s: Settings;
  tab: string;
  engine?: Engine;
  backend: string;
  engines: Engine[];
  detecting: boolean;
  verification: State["enhancements"];
  placebo?: boolean;
  canTest: boolean;
  job?: Pick<Job, "meta" | "audioPath" | "audioMeta">;
  preview: Preview | null;
  customFPS: boolean;
  setCustomFPS: (v: boolean) => void;
  autoAlignAudio: boolean;
  setAutoAlignAudio: (v: boolean) => void;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  changed: (s: Settings) => void;
  call: (action: string, payload?: unknown) => Promise<any>;
  copy: () => void;
  pickDirectory: () => void;
}) {
  // 前向分析只对 NVENC / NVEncC 生效；级别只有 HEVC / AV1 支持
  const lookaheadSupported = /_nvenc$|^nvencc:/.test(s?.encoder || "");
  const lookaheadLevelSupported =
    lookaheadSupported && !/^h264_nvenc$|^nvencc:h264$/.test(s?.encoder || "");
  function fieldNumber(
    key: keyof Settings,
    label: string,
    min: number,
    max: number,
    hint?: string,
  ) {
    const value = Number(s?.[key]);
    const fieldError =
      !Number.isFinite(value) || value < min || value > max
        ? `请输入 ${min}–${max} 范围内的数值。`
        : undefined;
    return (
      <Field id={key} label={label} hint={hint} error={fieldError}>
        <input
          id={key}
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(value) ? String(value) : ""}
          disabled={
            (s?.encoder === "prores_ks" && key === "bitrate") ||
            (key === "lookahead" && !lookaheadSupported) ||
            (key === "lookaheadLevel" && !lookaheadLevelSupported)
          }
          aria-invalid={!!fieldError}
          aria-describedby={
            fieldError ? `${key}-error` : hint ? `${key}-hint` : undefined
          }
          onChange={(e) =>
            set(key, e.target.value === "" ? NaN : Number(e.target.value))
          }
        />
      </Field>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      className="settings-body"
    >
      {tab === "encoding" && (
        <>
          <div className="form-row">
            <Select
              id="container"
              label="封装格式"
              value={s.container}
              options={options(["mp4", "mkv", "mov", "webm"]).map((o) => ({
                ...o,
                label: o.label.toUpperCase(),
              }))}
              onChange={(v) => set("container", v)}
            />
            <Select
              id="bitDepth"
              label="色彩位深"
              value={s.bitDepth}
              options={[
                { value: 8, label: "8-bit" },
                { value: 10, label: "10-bit" },
              ]}
              onChange={(v) => set("bitDepth", Number(v))}
            />
          </div>
          <Select
            id="encoder"
            label="视频编码器"
            value={s.encoder}
            options={[
              ...(!engine
                ? [
                    {
                      value: s.encoder,
                      label: `${s.encoder} · ${detecting ? "检测中" : "不可用"}`,
                    },
                  ]
                : []),
              ...engines.map((e) => ({
                value: e.id,
                label: engineLabel(e),
              })),
            ]}
            onChange={(v) => {
              const en = engines.find((e) => e.id === v);
              changed({
                ...s,
                encoder: v,
                // ProRes takes a quantizer, not a CRF; start at 16 (the built-in value).
                ...(v === "prores_ks" && s.encoder !== "prores_ks"
                  ? { quality: 12, rateControl: "quality" }
                  : {}),
                preset:
                  en?.backend === "cpu"
                    ? v === "libsvtav1"
                      ? "6"
                      : "medium"
                    : en?.backend === "qsv"
                      ? "medium"
                      : en?.backend === "amf"
                        ? "balanced"
                        : "p7",
              });
            }}
            hint={
              detecting
                ? "正在试编码，完成后显示当前电脑可用的编码器。"
                : "只显示已通过本机试编码的编码器。"
            }
          />
          <div className="form-row">
            <Select
              id="rateControl"
              disabled={s.encoder === "prores_ks"}
              label="码率控制"
              value={s.rateControl}
              options={[
                {
                  value: "quality",
                  label: backend === "cpu" ? "恒定质量 · CRF" : "目标质量 · CQ",
                },
                { value: "qp", label: "固定量化 · QP" },
                { value: "bitrate", label: "目标码率" },
              ]}
              onChange={(v) => set("rateControl", v)}
            />
            {s.rateControl === "bitrate"
              ? fieldNumber("bitrate", "码率 · kbps", 100, 1000000)
              : fieldNumber(
                  "quality",
                  s.encoder === "prores_ks"
                    ? "画质 · 量化"
                    : `画质 · ${s.rateControl === "qp" ? "QP" : backend === "cpu" ? "CRF" : "CQ"}`,
                  0,
                  s.encoder === "prores_ks"
                    ? 64
                    : ["h264", "hevc"].includes(engine?.codec || "")
                      ? 51
                      : 63,
                )}
          </div>
          <p className="hint quality-hint">
            {s.encoder === "prores_ks"
              ? "ProRes 量化 1–64：数值越小质量越高、文件越大；0 为编码器默认（实测约为量化 12 的 4 倍大小）。4:2:2 对应 HQ，4:4:4 对应 4444。"
              : s.rateControl === "bitrate"
                ? "目标平均码率（kbps）：数值越大通常质量越高、文件越大；单遍 VBR 实际码率会波动，不保证文件大小。"
                : s.rateControl === "qp"
                  ? "QP 固定量化：数值越小压缩越少；复杂场景使用相同量化，质量和码率会波动。"
                  : backend === "cpu"
                    ? "CRF 恒定质量：数值越小质量越高；码率随画面复杂度变化，不同软件编码器的 CRF 不可直接比较。"
                    : "CQ 目标质量：硬件按画面分配码率，数值越小通常质量越高；CQ 与 CRF 不在相同尺度。"}
          </p>
          <Select
            id="speed"
            label="编码预设 · 速度与压缩效率"
            value={s.preset}
            disabled={s.encoder === "prores_ks"}
            options={options(
              backend === "qsv"
                ? [
                    "veryfast",
                    "faster",
                    "fast",
                    "medium",
                    "slow",
                    "slower",
                    "veryslow",
                  ]
                : backend === "amf"
                  ? ["speed", "balanced", "quality"]
                  : backend === "cpu"
                    ? s.encoder === "libsvtav1"
                      ? ["0", "2", "4", "6", "8", "10", "12"]
                      : ["ultrafast", "fast", "medium", "slow", "veryslow"]
                    : ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
            )}
            onChange={(v) => set("preset", v)}
            hint={
              s.encoder === "prores_ks"
                ? "ProRes 使用 Profile 决定压缩配置。"
                : backend === "nvenc" || backend === "nvencc"
                  ? "p1 最快，p7 压缩效率优先；具体速度依显卡和处理链。"
                  : s.encoder === "libsvtav1"
                    ? "AV1 数字越小越慢、效率通常越高；数字越大越快。"
                    : backend === "amf"
                      ? "speed 优先速度，quality 优先压缩效率，balanced 折中。"
                      : "veryfast / ultrafast 更快；slow / veryslow 更慢、压缩效率通常更高。"
            }
          />
          <div className="divider" />
          <Select
            id="resizeMode"
            label="输出分辨率"
            value={s.resizeMode || "source"}
            options={[
              { value: "source", label: "保持源分辨率" },
              {
                value: "long",
                label: "按长边缩放 · 自动识别横竖屏",
              },
              { value: "custom", label: "自定义分辨率" },
            ]}
            onChange={(v) => set("resizeMode", v)}
          />
          {s.resizeMode === "long" &&
            fieldNumber(
              "width",
              "长边 · px",
              2,
              16384,
              "横屏视频用作宽度，竖屏视频用作高度，另一边按原比例计算。",
            )}
          {s.resizeMode === "custom" && (
            <>
              <div className="form-row">
                {(["width", "height"] as const).map((axis) => {
                  const derived =
                    s.keepAspect && s.resizeAxis !== axis && job?.meta;
                  const value = derived
                    ? Math.max(
                        2,
                        Math.round(
                          (s[s.resizeAxis as "width" | "height"] *
                            job.meta![axis]) /
                            job.meta![s.resizeAxis as "width" | "height"] /
                            2,
                        ) * 2,
                      )
                    : s[axis];
                  const invalid =
                    !Number.isInteger(value) || value < 2 || value > 16384;
                  return (
                    <Field
                      key={axis}
                      id={axis}
                      label={axis === "width" ? "宽度 · px" : "高度 · px"}
                      error={invalid ? "请输入 2–16384 的整数" : undefined}
                    >
                      <input
                        id={axis}
                        type="number"
                        min={2}
                        max={16384}
                        step={1}
                        value={value || ""}
                        aria-invalid={invalid}
                        aria-describedby={invalid ? `${axis}-error` : undefined}
                        onChange={(e) =>
                          changed({
                            ...s,
                            [axis]: Number(e.target.value),
                            resizeAxis: axis,
                          })
                        }
                      />
                    </Field>
                  );
                })}
              </div>
              <label className="check-card">
                <input
                  type="checkbox"
                  checked={s.keepAspect}
                  onChange={(e) =>
                    changed({
                      ...s,
                      keepAspect: e.target.checked,
                      ...(e.target.checked
                        ? {}
                        : job?.meta
                          ? s.resizeAxis === "height"
                            ? {
                                width: Math.max(
                                  2,
                                  Math.round(
                                    (s.height * job.meta.width) /
                                      job.meta.height /
                                      2,
                                  ) * 2,
                                ),
                              }
                            : {
                                height: Math.max(
                                  2,
                                  Math.round(
                                    (s.width * job.meta.height) /
                                      job.meta.width /
                                      2,
                                  ) * 2,
                                ),
                              }
                          : {}),
                    })
                  }
                />
                <span>
                  <strong>保持宽高比</strong>
                  <small>
                    默认开启；按每个源视频的比例计算另一边，取最接近的偶数像素。
                  </small>
                </span>
              </label>
              {!job?.meta && s.keepAspect && (
                <p className="hint">添加视频后自动计算另一边尺寸。</p>
              )}
            </>
          )}
          <Select
            id="fps"
            label="输出帧率"
            value={
              customFPS || !frameOptions.some((o) => o.value === s.fps)
                ? "custom"
                : s.fps
            }
            options={frameOptions}
            onChange={(v) => {
              setCustomFPS(v === "custom");
              if (v !== "custom") set("fps", v);
            }}
          />
          {(customFPS || !frameOptions.some((o) => o.value === s.fps)) && (
            <Field
              id="custom-fps"
              label="自定义 FPS"
              hint="1–240，可输入 30 或 30000/1001"
            >
              <input
                id="custom-fps"
                value={s.fps === "source" ? "" : s.fps}
                onChange={(e) => set("fps", e.target.value)}
              />
            </Field>
          )}
          <p className="hint">
            降帧率保持时长与音画同步；提高帧率使用重复帧，不生成运动细节。
          </p>
        </>
      )}
      {tab === "audio" && (
        <>
          <Select
            id="audio"
            label="音频编码"
            value={s.audio}
            options={Object.entries(audioLabels()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(v) => set("audio", v)}
          />
          <Select
            id="audioBitrate"
            label="音频码率"
            value={s.audioBitrate ?? 0}
            options={[
              {
                value: 0,
                label:
                  s.audio === "aac" ? "默认 · 192 kbps" : "默认 · 编码器自动",
              },
              ...[64, 96, 128, 160, 192, 256, 320, 384, 512].map((value) => ({
                value,
                label: `${value} kbps`,
              })),
            ]}
            onChange={(v) => set("audioBitrate", Number(v))}
            disabled={!["aac", "libopus"].includes(s.audio)}
            hint={
              s.audio === "none"
                ? "不保留音频，无需设置码率。"
                : ["flac", "pcm_s16le"].includes(s.audio)
                  ? "无损或未压缩音频不使用目标码率。"
                  : "目标码率；实际码率会随编码器和声音内容变化。"
            }
          />
          <Select
            id="audioFade"
            label="音频淡入淡出"
            value={String(s.audioFade ?? 0)}
            options={fadeOptions()}
            disabled={s.audio === "none"}
            hint={
              s.audio === "none" ? "不保留音频，无需淡入淡出。" : fadeHint()
            }
            onChange={(v) => set("audioFade", Number(v))}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!s.hiRes}
              disabled={!["flac", "pcm_s16le"].includes(s.audio)}
              onChange={(e) =>
                // FLAC / PCM do not fit MP4: switch to MKV with it.
                changed({
                  ...s,
                  hiRes: e.target.checked,
                  ...(e.target.checked && s.container === "mp4"
                    ? { container: "mkv" }
                    : {}),
                })
              }
            />
            <span>
              Hi-Res 音频（24-bit，低于 48 kHz 时升到 2 倍采样率）
              <small className="hint hires-hint">
                {!["flac", "pcm_s16le"].includes(s.audio)
                  ? "选择 FLAC 或 PCM 音频后可用。"
                  : (() => {
                      const a = job?.audioPath
                        ? job.audioMeta
                        : job?.meta?.audio;
                      if (!a?.sampleRate) return "按每个视频自己的音轨计算。";
                      const rate =
                        a.sampleRate < 48000 ? a.sampleRate * 2 : a.sampleRate;
                      return `当前素材：${a.sampleRate / 1000} kHz / ${a.float ? "浮点" : a.bits ? a.bits + "-bit" : "位深未知"} → ${rate / 1000} kHz / 24-bit。`;
                    })() + "升采样不会提高音质。"}
              </small>
            </span>
          </label>
          <div className="help-box">
            <Info size={17} />
            <p>
              保持源采样率与声道；MP4 用 AAC，FLAC 用
              MKV。要换成别的音频，点队列里的 ♪ 为该视频选择，按视频时长截取。
            </p>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={autoAlignAudio}
              onChange={(e) => setAutoAlignAudio(e.target.checked)}
            />
            <span>
              替换音频后自动对齐
              <small className="hint hires-hint">
                以视频自带的声音为参考；对不上时不应用，可在“当前素材”里点“对齐”检视、微调。
              </small>
            </span>
          </label>
          {(job?.audioPath ? job.audioMeta : job?.meta?.audio) &&
            (() => {
              const a = (job!.audioPath ? job!.audioMeta : job!.meta!.audio)!;
              return (
                <div className="mini-facts">
                  <span>{job!.audioPath ? "替换音频" : "源音频"}</span>
                  <strong>
                    {a.codec.toUpperCase()} / {a.sampleRate / 1000} kHz
                  </strong>
                </div>
              );
            })()}
        </>
      )}
      {tab === "rtx" && (
        <RtxSettings
          s={s}
          verification={verification}
          placebo={placebo}
          canTest={canTest}
          set={set}
          patch={(p) => changed({ ...s, ...p })}
          call={call}
        />
      )}
      {tab === "alpha" && (
        <>
          <Select
            id="alphaMode"
            label="透明通道处理"
            // "split" = colour video without alpha + separate mask
            // (stored as alphaMode discard + alphaMask, any format).
            value={
              s.alphaMask && s.alphaMode === "discard" ? "split" : s.alphaMode
            }
            options={[
              { value: "discard", label: "移除 Alpha" },
              { value: "preserve", label: "保留 Alpha" },
              {
                value: "split",
                label: "分离 Alpha · 彩色视频 + 黑白遮罩",
              },
              { value: "mask", label: "分离 Alpha · 仅黑白遮罩" },
              { value: "color", label: "合成到纯色" },
            ]}
            onChange={(v) =>
              changed({
                ...s,
                alphaMode: v === "split" ? "discard" : v,
                alphaMask: v === "split",
                // ProRes alpha starts at quantizer 16 (~1/5 of the default size).
                ...(v === "preserve" &&
                s.alphaMode !== "preserve" &&
                s.encoder === "prores_ks"
                  ? { quality: 12 }
                  : {}),
              })
            }
          />
          {s.alphaMode === "color" && (
            <BackgroundColor
              value={s.alphaBackground}
              onChange={(hex) => changed({ ...s, alphaBackground: hex })}
            />
          )}
          {s.alphaMask && s.alphaMode === "discard" && (
            <>
              <div className="alpha-diagram">
                <div className="alpha-swatch color">RGB</div>
                <Plus size={16} />
                <div className="alpha-swatch mask">A</div>
              </div>
              <p className="hint">
                {
                  "彩色视频不含 Alpha，可用任意编码器和封装；另外导出同尺寸、同帧率的黑白遮罩（_alpha 后缀，无损）。"
                }
                白色表示不透明，黑色表示透明，灰色保留半透明信息。
              </p>
            </>
          )}
          {s.alphaMode === "mask" && (
            <>
              <div className="alpha-diagram">
                <div className="alpha-swatch mask">A</div>
              </div>
              <p className="hint">
                只导出同尺寸、同帧率的黑白遮罩（_alpha
                后缀，无损，不含音频），不导出彩色视频。WebM 用 VP9，其他格式用
                H.264；画质页的编码器设置不影响遮罩。白色表示不透明，黑色表示透明，灰色保留半透明信息。
              </p>
            </>
          )}
          {(s.alphaMask || s.alphaMode === "mask") &&
            job?.meta &&
            !job.meta.hasAlpha && (
              <p className="inline-error">
                当前素材没有可读取的 Alpha
                通道，不能导出遮罩。请选择其他处理方式或包含透明通道的视频。
              </p>
            )}
        </>
      )}
      {tab === "output" && (
        <>
          <Select
            id="outputMode"
            label="保存位置"
            value={s.outputMode}
            options={[
              { value: "source", label: "源文件目录" },
              { value: "encoded", label: "源目录 \\ Encoded" },
              { value: "custom", label: "自定义统一目录" },
            ]}
            onChange={(v) => set("outputMode", v)}
          />
          {s.outputMode === "custom" && (
            <Field id="outputDir" label="统一输出目录">
              <div className="input-action">
                <input
                  id="outputDir"
                  value={s.outputDir}
                  onChange={(e) => set("outputDir", e.target.value)}
                  placeholder="选择文件夹"
                />
                <Button
                  title="选择输出文件夹"
                  aria-label="选择输出文件夹"
                  onClick={pickDirectory}
                >
                  <Folder size={17} />
                </Button>
              </div>
            </Field>
          )}
          <p className="hint">
            自动记住上一次选择。不同源目录分别创建自己的 Encoded 文件夹。
          </p>
          <div className="divider" />
          <Field
            id="nameTemplate"
            label="文件名模板"
            hint="扩展名自动添加，同名文件自动编号。"
          >
            <input
              id="nameTemplate"
              value={s.nameTemplate}
              onChange={(e) => set("nameTemplate", e.target.value)}
            />
          </Field>
          <div className="template-tokens">
            {["{name}", "{preset}", "{date}", "{index}"].map((v) => (
              <Button
                key={v}
                variant="ghost"
                onClick={() => set("nameTemplate", s.nameTemplate + v)}
              >
                {v}
              </Button>
            ))}
          </div>
          <p className="hint">原名 / 预设名 / 日期 / 队列序号</p>
          <div className="path-preview">
            <span>输出示例</span>
            <code>{preview?.output || "添加视频后显示完整路径"}</code>
          </div>
        </>
      )}
      {tab === "advanced" && (
        <>
          <div className="form-row">
            <Select
              id="chroma"
              label="色度采样"
              value={s.chroma}
              options={[
                { value: "420", label: "4:2:0" },
                { value: "422", label: "4:2:2" },
                { value: "444", label: "4:4:4" },
              ]}
              onChange={(v) => set("chroma", v)}
            />
            <Select
              id="colorRange"
              label="输出范围"
              value={s.colorRange}
              options={[
                { value: "tv", label: "有限 · TV" },
                { value: "pc", label: "全范围 · PC" },
              ]}
              onChange={(v) => set("colorRange", v)}
            />
          </div>
          <Select
            id="colorSpace"
            label="色彩空间 · SDR"
            value={s.colorSpace}
            options={options(["bt709", "bt601", "bt2020"])}
            onChange={(v) => set("colorSpace", v)}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!s.editFriendly}
              onChange={(e) => set("editFriendly", e.target.checked)}
            />
            <span>
              剪辑友好：每秒一个关键帧
              <small className="hint hires-hint">
                {s.gop >= 0
                  ? "已手动设置 GOP 间隔，此项不生效。"
                  : "成片可以按约 1 秒的间隔无损裁切；同画质下文件约大 2%–5%（软件编码更多）。"}
              </small>
            </span>
          </label>
          <div className="form-row">
            {fieldNumber("gop", "GOP 间隔", -1, 10000, "-1 为自动")}
            {fieldNumber("bframes", "B 帧", -1, 16, "-1 为自动")}
          </div>
          <div className="form-row">
            {fieldNumber(
              "lookahead",
              "前向分析帧数",
              0,
              32,
              lookaheadSupported ? undefined : "仅 NVIDIA 硬件编码",
            )}
            {fieldNumber(
              "lookaheadLevel",
              "前向分析级别",
              0,
              3,
              lookaheadLevelSupported ? undefined : "仅 NVIDIA HEVC / AV1",
            )}
          </div>
          <div className="command-row">
            <details className="command-details">
              <summary>查看完整命令</summary>
              <pre>{preview?.command || "添加视频后生成命令"}</pre>
            </details>
            <Button disabled={!job} onClick={copy}>
              <Copy size={14} />
              复制命令
            </Button>
          </div>
        </>
      )}
      {s.encoder.startsWith("nvencc:") && (
        <p className="help-box">
          NVEncC 将先生成临时中间视频，可能需要较多磁盘空间；完成后自动清理。
        </p>
      )}
    </form>
  );
}
