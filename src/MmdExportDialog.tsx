import { Folder, FolderOpen } from "lucide-react";
import { Button, Select, Modal } from "./components";
import { fadeOptions } from "./presentation";
import type { State, Preset } from "./types";
// Presets an MMD export cannot use yet (mirrors backend/mmd-export.cjs).
function mmdUnsupported(p: Preset) {
  if (
    p.settings.alphaMode !== "mask" &&
    p.settings.encoder.startsWith("nvencc:")
  )
    return "NVEncC 暂不支持";
  return "";
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

export function MmdExportDialog({
  open,
  onClose,
  error,
  mmd,
  presets,
  busy,
  onCall,
  action,
}: {
  open: boolean;
  onClose: () => void;
  error: string;
  mmd: State["mmd"];
  presets: Preset[];
  busy: boolean;
  onCall: (
    action: string,
    payload?: unknown,
    message?: string,
  ) => Promise<void>;
  action: (action: string, payload?: unknown, message?: string) => void;
}) {
  return (
    <Modal
      error={error}
      open={open}
      onClose={onClose}
      fixedHeight
      title="MMD 导出"
      description="在 MMD“AVI 输出”中选择 MMDEncoder。这里的选项优先于预设，并与 MMD“詳細設定”同步。"
    >
      {mmd.interrupted.length > 0 && (
        <section className="modal-section" aria-label="中断的导出">
          <h3>中断的导出</h3>
          <p className="hint">
            MMD
            在导出途中崩溃或被关闭时，已导出的画面仍保存在临时文件里。补完会按导出开始时的设置合成音频并改回正式文件名。
          </p>
          {mmd.interrupted.map((x) => (
            <div className="status-row" key={x.id}>
              <p title={x.temp}>
                {baseName(x.output)}
                <small className="row-detail">
                  {x.presetName} · 已导出 {(x.size / 1048576).toFixed(1)} MiB ·{" "}
                  {new Date(x.at).toLocaleString()} 开始
                </small>
              </p>
              <div className="row-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdRecover", { id: x.id }, "已补完中断的导出")
                  }
                >
                  补完
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdDiscard", { id: x.id }, "已删除中断的导出")
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="modal-section" aria-label="插件" aria-busy={busy}>
        <h3>插件</h3>
        <div className="status-row">
          <p className={mmd.plugin.broken ? "inline-error" : undefined}>
            {!mmd.plugin.available
              ? "这个版本没有附带 MMD 导出插件。"
              : mmd.plugin.broken
                ? "插件需要修复：注册的插件文件已不存在，MMD 里会找不到“MMDEncoder”。点“修复插件”重新安装，然后重启 MMD。"
                : !mmd.plugin.installed
                  ? "未安装。安装后在 MMD 的“AVI 输出”里选择视频编码“MMDEncoder”。"
                  : mmd.plugin.upToDate
                    ? "已安装，在 MMD 的“AVI 输出”里选择视频编码“MMDEncoder”。"
                    : "已安装，有新版插件可以更新（MMD 重启后生效）。"}
          </p>
          <div className="row-actions">
            {mmd.plugin.available &&
              (!mmd.plugin.installed || !mmd.plugin.upToDate) && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    onCall("mmdInstall", undefined, "MMD 导出插件已安装")
                  }
                >
                  {mmd.plugin.broken
                    ? "修复插件"
                    : mmd.plugin.installed
                      ? "更新插件"
                      : "安装到 MMD"}
                </Button>
              )}
            {mmd.plugin.installed && (
              <Button
                disabled={busy}
                onClick={() =>
                  onCall("mmdUninstall", undefined, "MMD 导出插件已卸载")
                }
              >
                卸载
              </Button>
            )}
          </div>
        </div>
      </section>
      <section className="modal-section" aria-label="导出设置">
        <h3>导出设置</h3>
        <Select
          id="mmd-export-preset"
          label="导出预设"
          value={mmd.presetId}
          disabled={busy}
          options={[
            { value: "", label: "未选择" },
            ...presets.map((p) => {
              const why = mmdUnsupported(p);
              return {
                value: p.id,
                label: why ? `${p.name}（${why}）` : p.name,
                disabled: !!why,
              };
            }),
          ]}
          onChange={(presetId) => onCall("mmdExportSet", { presetId })}
        />
        <label className="check-card">
          <input
            type="checkbox"
            checked={mmd.followMmd}
            disabled={busy}
            onChange={(e) =>
              onCall("mmdExportSet", { followMmd: e.target.checked })
            }
          />
          <span>
            <strong>分辨率和帧率跟随 MMD</strong>
            <small>使用 MMD“AVI 输出”的尺寸和帧率。</small>
          </span>
        </label>
        <label className="check-card">
          <input
            type="checkbox"
            checked={mmd.rangeSuffix !== false}
            disabled={busy}
            onChange={(e) =>
              onCall("mmdExportSet", { rangeSuffix: e.target.checked })
            }
          />
          <span>
            <strong>文件名加 MMD 帧范围</strong>
            <small>例如 场景_0400-0600f.mp4；支持剪辑时按 MMD 帧号定位。</small>
          </span>
        </label>
        <div className="form-row">
          {/* Overrides the preset's own alpha setting; the same choice as
              in MMD's 詳細設定, where a change wins over this window. */}
          <Select
            id="mmd-mask-mode"
            label="Alpha 遮罩"
            value={mmd.maskMode || "off"}
            disabled={busy}
            hint="无损黑白遮罩：白色不透明，黑色透明。"
            options={[
              { value: "off", label: "不导出" },
              { value: "with", label: "同时导出遮罩" },
              { value: "only", label: "仅导出遮罩" },
            ]}
            onChange={(maskMode) => onCall("mmdExportSet", { maskMode })}
          />
          <Select
            id="mmd-audio-fade"
            label="音频淡入淡出"
            value={String(mmd.audioFade)}
            disabled={busy}
            hint="仅淡化成片首尾。"
            options={fadeOptions}
            onChange={(v) => onCall("mmdExportSet", { audioFade: Number(v) })}
          />
        </div>
      </section>
      <section className="modal-section" aria-label="测试与日志">
        <h3>测试与日志</h3>
        <div className="status-row">
          <p
            className={
              mmd.error || mmd.test?.ok === false ? "inline-error" : undefined
            }
            role={mmd.error ? "alert" : "status"}
          >
            {mmd.error ||
              (mmd.test
                ? mmd.test.message
                : mmd.lastExport
                  ? mmd.lastExport.ok
                    ? `上次导出：${baseName(mmd.lastExport.output || "")}${mmd.lastExport.audio === "wav" ? "（音频取自工程 WAV）" : mmd.lastExport.audio === "avi" ? "（含音频）" : "（无音频）"}${mmd.lastExport.mask ? "，含 Alpha 遮罩" : ""}`
                    : `上次导出失败：${mmd.lastExport.error}`
                  : "成片保存在 AVI 同目录，自动合成音频，完成后删除占位 AVI。")}
          </p>
          <div className="row-actions">
            <Button
              disabled={busy || !mmd.presetId || !!mmd.error}
              onClick={() => onCall("mmdTest")}
            >
              {busy ? "处理中…" : "测试编码"}
            </Button>
            <Button
              disabled={!mmd.lastExport?.output}
              title={mmd.lastExport?.output}
              onClick={() => action("mmdOpenLatest")}
            >
              <Folder size={15} />
              打开最新导出
            </Button>
            <Button onClick={() => action("mmdOpenLog")}>
              <FolderOpen size={15} />
              打开导出日志
            </Button>
          </div>
        </div>
        {(() => {
          // Where the last export's time went, measured by the plugin.
          const e = mmd.lastExport;
          const t = e?.ok ? e.timing : undefined;
          if (!t || !(t.render > 0)) return null;
          const s = (v: number) => `${v.toFixed(1)} 秒`;
          const share = (100 * t.waited) / t.render;
          const total = t.setup + t.render + t.encoderTail + (t.finish || 0);
          return (
            <p className="hint export-timing">
              上次导出耗时 {s(total)}：准备 {s(t.setup)} · 渲染 {s(t.render)}
              {e?.frames ? `（${(e.frames / t.render).toFixed(1)} fps）` : ""} ·
              等待编码器 {s(t.waited)}（{share.toFixed(0)}%，单帧最长{" "}
              {Math.round(t.longestWait * 1000)} 毫秒） · 编码收尾{" "}
              {s(t.encoderTail)}
              {t.finish !== undefined ? ` · 合成音频与整理 ${s(t.finish)}` : ""}
              {share >= 10
                ? "。编码器跟不上 MMD 渲染，换更快的预设（如硬件编码）可缩短导出时间。"
                : "。编码没有拖慢 MMD，导出时间主要花在 MMD 渲染上。"}
            </p>
          );
        })()}
      </section>
    </Modal>
  );
}
