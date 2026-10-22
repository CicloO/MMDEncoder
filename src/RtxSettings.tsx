import { Button, Field, Select } from "./components";
import type { Settings, State } from "./types";
// 超分补帧 tab: how to enlarge (Lanczos / ArtCNN / RTX VSR), RTX frame
// generation, and the local check RTX features need before encoding.
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
  // Things that stop ArtCNN from doing what the user expects.
  const warnings = [
    upscaler === "artcnn" &&
      s.resizeMode === "source" &&
      "当前为“保持源分辨率”，不会放大。请在“画质”里设置更大的输出分辨率。",
    upscaler === "artcnn" &&
      s.alphaMode === "preserve" &&
      "保留 Alpha 时速度只有 Lanczos 的三分之一左右，透明通道本身仍用 Lanczos 放大。",
    !placebo &&
      "本机未检测到可用的 Vulkan，ArtCNN 无法运行；请更新显卡驱动后重新检测。",
  ].filter(Boolean) as string[];
  const message =
    state.enhancements.message === "RTX 设置已更改，请重新验证本机设置"
      ? "设置已更改，请重新验证。"
      : state.enhancements.message;
  return (
    <>
      <section className="settings-group" aria-labelledby="upscale-title">
        <h3 id="upscale-title" className="settings-group-title">
          放大
        </h3>
        <Select
          id="upscaler"
          label="放大算法"
          value={upscaler}
          options={[
            { value: "lanczos", label: "Lanczos · 标准缩放" },
            {
              value: "artcnn",
              label: "ArtCNN · AI 放大",
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
          hint={
            upscaler === "vsr"
              ? "NVIDIA RTX 超分，只能配合 NVEncC 编码器；输出尺寸由下面的倍率决定。"
              : upscaler === "artcnn"
                ? "2 倍 AI 放大，线条更清晰，保留原有颗粒质感；需要支持 Vulkan 的显卡。输出尺寸在“画质”里设置，宽高都放大超过 1.3 倍才会使用 AI。"
                : "速度最快，画面偏软。输出尺寸在“画质”里设置。"
          }
        />
        {upscaler === "artcnn" && (
          <Select
            id="artcnnModel"
            label="ArtCNN 模型"
            value={s.artcnnModel || "C4F16"}
            options={[
              { value: "C4F16", label: "C4F16 · 轻量（推荐）" },
              { value: "C4F32", label: "C4F32 · 计算量更高" },
            ]}
            onChange={(v) => set("artcnnModel", v as Settings["artcnnModel"])}
            hint="两者画质几乎相同，C4F32 慢约 30%–40%。"
          />
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
              hint="MMD 画面放大选 4。8–19 保持原尺寸（倍率填 1）；强度需要 VFX SDK 1.3+。"
            />
          </>
        )}
        {warnings.length > 0 && (
          <ul className="settings-warnings" role="alert">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-group" aria-labelledby="vfg-title">
        <h3 id="vfg-title" className="settings-group-title">
          补帧
        </h3>
        <label className="checkbox-row">
          <input
            id="vfg"
            type="checkbox"
            checked={s.vfg}
            onChange={(e) => set("vfg", e.target.checked)}
          />
          <span>
            启用 NVIDIA VFG 插帧
            <small className="hint hires-hint">
              需要 RTX 40 / 50 系列显卡、NVEncC 9.36+ 和 NVIDIA VFX
              运行库；不支持 Alpha。
            </small>
          </span>
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
                hint={`输出帧率 = 源帧率 × ${s.vfgMultiplier}`}
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
              hint="留空使用 NVEncC 自带的模型；只有验证时报告找不到模型才需要选择。"
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
          </>
        )}
      </section>

      {(s.vsr || s.vfg) && (
        <section className="rtx-check" aria-labelledby="rtx-check-title">
          <h3 id="rtx-check-title" className="settings-group-title">
            本机验证
          </h3>
          <p className="hint">
            RTX VSR / VFG 要先用当前设置在本机试运行一次，通过后才能压制。
          </p>
          <div className="rtx-check-row">
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
              {state.enhancements.busy ? "正在验证…" : "验证本机 RTX 设置"}
            </Button>
            {message && (
              <p className="hint" role="status">
                {message}
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
