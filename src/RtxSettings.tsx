import { Button, Field, Select } from "./components";
import type { Settings, State } from "./types";
export function RtxSettings({
  s,
  state,
  set,
  patch,
  call,
}: {
  s: Settings;
  state: State;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (p: Partial<Settings>) => void;
  call: (action: string, payload?: unknown) => Promise<any>;
}) {
  const upscaler = s.vsr ? "vsr" : s.upscaler || "lanczos";
  const placebo = state.engineInfo.libplacebo !== false;
  const number = (
    key: "vsrScale" | "vsrStrength",
    label: string,
    min: number,
    max: number,
  ) => (
    <Field id={key} label={label}>
      <input
        id={key}
        type="number"
        min={min}
        max={max}
        step="0.01"
        value={s[key]}
        onChange={(e) => set(key, Number(e.target.value))}
      />
    </Field>
  );
  return (
    <>
      <Select
        id="upscaler"
        label="放大算法"
        value={upscaler}
        options={[
          { value: "lanczos", label: "Lanczos · 标准缩放" },
          {
            value: "artcnn",
            label: "ArtCNN · AI 放大（推荐）",
            disabled: !placebo && upscaler !== "artcnn",
          },
          { value: "vsr", label: "RTX VSR · NVIDIA 超分" },
        ]}
        onChange={(v) =>
          patch(
            v === "vsr"
              ? // VSR sets the size itself (VSR 倍率).
                { vsr: true, resizeMode: "source" }
              : { vsr: false, upscaler: v as Settings["upscaler"] },
          )
        }
      />
      {upscaler !== "vsr" && (
        <p className="hint">
          {upscaler === "artcnn"
            ? "线条更清晰，保留原有颗粒质感；在 GPU 上运行，任何支持 Vulkan 的显卡都可以，不需要 NVEncC。ArtCNN 是 2 倍放大模型，1080p → 4K 效果最好；其他尺寸先放大 2 倍再缩放到目标。宽、高都要放大超过 1.3 倍才会用到 AI，否则自动改用 Lanczos（任务日志里会注明）。不建议用于带透明通道的素材。"
            : "FFmpeg 的 Lanczos 缩放，速度快，画面偏软。"}
          目标尺寸在“画质”里的“输出分辨率”设置。
        </p>
      )}
      {upscaler === "artcnn" && s.alphaMode === "preserve" && (
        <p className="inline-error">
          当前“保留 Alpha”：不建议使用 ArtCNN。速度只有 Lanczos
          的三分之一左右，透明通道本身仍用 Lanczos 放大。
        </p>
      )}
      {upscaler === "artcnn" && s.resizeMode === "source" && (
        <p className="inline-error">
          当前为“保持源分辨率”，不会放大。请在“画质”里设置更大的输出分辨率。
        </p>
      )}
      {!placebo && (
        <p className="inline-error">
          本机未检测到可用的 Vulkan，ArtCNN 无法运行；请更新显卡驱动后重新检测。
        </p>
      )}
      {(s.vsr || s.vfg) && (
        <p className="hint">
          RTX VSR / VFG 仅 NVEncC；验证所选配置后可编码。需要兼容驱动与 NVIDIA
          VFX SDK 运行库 / 模型；不会自动替换为普通缩放或重复帧。
        </p>
      )}
      {s.vsr && (
        <>
          <div className="form-row">
            {number("vsrScale", "VSR 倍率 · 1.00–4.00", 1, 4)}
            {number("vsrStrength", "VSR 强度 · 0.00–1.00", 0, 1)}
          </div>
          <Select
            id="vsrQuality"
            label="NVIDIA QualityLevel"
            value={s.vsrQuality}
            options={[
              0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21,
              23,
            ].map((v) => ({
              value: v,
              label: `${v} · ${v === 0 ? "双三次基线" : v <= 4 ? "VSR 放大" : v <= 11 ? "去噪（原尺寸）" : v <= 15 ? "去模糊（原尺寸）" : v <= 19 ? "补细节（非 VSR 放大）" : v === 21 ? "Streaming Medium" : "Streaming Ultra"}`,
            }))}
            onChange={(v) => set("vsrQuality", Number(v))}
          />
          <p className="hint">
            8–19 使用 1.00 倍原尺寸；16–19 补细节，不标为 VSR 放大。强度需 VFX
            SDK 1.3+，1.2 DLL 会忽略。
          </p>
        </>
      )}
      <div className="divider" />
      <label className="checkbox-row">
        <input
          id="vfg"
          type="checkbox"
          checked={s.vfg}
          onChange={(e) => set("vfg", e.target.checked)}
        />
        启用 NVIDIA VFG 插帧
      </label>
      {s.vfg && (
        <>
          <div className="form-row">
            <Select
              id="vfgMultiplier"
              label="帧率倍率"
              value={s.vfgMultiplier}
              options={[2, 3, 4, 5, 6, 7, 8].map((v) => ({
                value: v,
                label: `${v}×`,
              }))}
              onChange={(v) => set("vfgMultiplier", Number(v))}
            />
            <Select
              id="vfgMode"
              label="VFG 模型"
              value={s.vfgMode}
              options={[
                { value: "low", label: "Low · 低复杂度" },
                { value: "medium", label: "Medium · 均衡" },
                { value: "high", label: "High · 高复杂度" },
              ]}
              onChange={(v) => set("vfgMode", v)}
            />
          </div>
          <Field
            id="vfgModelDir"
            label="VFG 模型目录（可选）"
            hint="留空使用 NVEncC 默认模型位置；缺模型时请安装 NVIDIA VFX SDK。"
          >
            <div className="path-picker">
              <input id="vfgModelDir" readOnly value={s.vfgModelDir} />
              <Button
                onClick={async () => {
                  const selected = await call("pickDirectory");
                  if (selected) set("vfgModelDir", selected);
                }}
              >
                选择模型目录
              </Button>
            </div>
          </Field>
          <p className="hint">
            Windows · NVEncC 9.36+ · Ada / Blackwell。输出帧率 = 源帧率 ×
            倍率；保持源帧率。Alpha 保留 / 遮罩暂不支持此组合。
          </p>
        </>
      )}
      {(s.vsr || s.vfg) && (
        <div className="rtx-verify">
          <Button
            disabled={
              state.running ||
              state.detecting ||
              !!state.tools?.busy ||
              state.enhancements.busy
            }
            onClick={() =>
              call("testEnhancements", { settings: s }).catch(() => {})
            }
          >
            {state.enhancements.busy ? "正在验证 RTX…" : "验证本机 RTX 设置"}
          </Button>
          <p className="hint" role="status">
            {state.enhancements.message}
          </p>
        </div>
      )}
    </>
  );
}
