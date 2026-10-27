import { useEffect, useRef } from "react";
import { Check, Cpu, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, Field, Modal } from "./components";
import { engineLabel, formatSize } from "./presentation";
import type { createActions } from "./actions";
import type { State } from "./types";

type EngineView = Pick<
  State,
  "tools" | "engines" | "engineInfo" | "detecting" | "running"
> & {
  trimRunning: State["trim"]["running"];
};

export function useEngineInstallationPrompt(
  located: State["located"],
  engineInfo: State["engineInfo"] | undefined,
  onPrompt: () => void,
) {
  const installationPrompted = useRef(false);
  useEffect(() => {
    if (located && !installationPrompted.current) {
      installationPrompted.current = true;
      if (!engineInfo?.ffmpeg || !engineInfo?.ffprobe) onPrompt();
    }
  }, [located]);
}

export function EngineStatusButton({
  detecting,
  count,
  onOpen,
}: {
  detecting: boolean;
  count: number;
  onOpen: () => void;
}) {
  return (
    <Button onClick={onOpen}>
      <span className={`status-dot ${detecting ? "pending" : ""}`} />
      {detecting ? "检测编码器…" : `${count} 个可用编码器`}
    </Button>
  );
}

export function EngineManagementDialog({
  open,
  onClose,
  error,
  status,
  actions,
  onShowLog,
}: {
  open: boolean;
  onClose: () => void;
  error: string;
  status: EngineView;
  actions: ReturnType<typeof createActions>;
  onShowLog: (text: string) => void;
}) {
  const { tools, engines, engineInfo, detecting, running, trimRunning } =
    status;
  const { call, action } = actions;
  return (
    <Modal
      error={error}
      open={open}
      onClose={onClose}
      fixedHeight
      title="编码引擎"
      description="首次使用从官方来源下载工具到本机；安装后可离线编码，无需管理员权限。"
    >
      {tools && (
        <section
          className="modal-section"
          aria-label="工具安装与更新"
          aria-busy={tools.busy}
        >
          <h3>编码工具</h3>
          <p className="hint">
            FFmpeg / ffprobe：Gyan · NVEncC：rigaya / GitHub
          </p>
          {tools.phase === "downloading" && (
            <p>
              {formatSize(tools.received)}
              {tools.total
                ? ` / ${formatSize(tools.total)}`
                : " · 总大小待服务器确认"}
            </p>
          )}
          <Field id="tools-root" label="安装位置">
            <div className="path-picker">
              <input
                id="tools-root"
                value={tools.root}
                readOnly
                title={tools.root}
              />
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                title="已安装的工具会一起移到新位置；选择已装有本软件工具的文件夹则直接使用"
                onClick={async () => {
                  try {
                    const dir = await call("pickDirectory", {
                      title: "选择编码工具安装位置",
                    });
                    if (dir)
                      await call(
                        "setToolsRoot",
                        { root: dir },
                        "已更改编码工具安装位置",
                      );
                  } catch {}
                }}
              >
                <FolderOpen size={15} />
                更改位置
              </Button>
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() =>
                  action("setToolsRoot", { root: "" }, "已恢复默认安装位置")
                }
              >
                恢复默认
              </Button>
            </div>
          </Field>
          <div className="status-row">
            <div>
              <p role={tools.phase === "error" ? "alert" : "status"}>
                {tools.message}
              </p>
              <p className="hint">
                {Object.entries(tools.installed)
                  .map(
                    ([id, tool]) =>
                      `${id} ${tool.version}（${tool.verifiedHash ? "发布 SHA-256 已验证" : "发布方未提供校验值"}）`,
                  )
                  .join(" · ") || "尚未安装编码工具"}
              </p>
            </div>
            <div className="row-actions">
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() => action("checkTools")}
              >
                检查工具更新
              </Button>
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() => action("installTools")}
              >
                {tools.busy
                  ? "正在处理…"
                  : tools.phase === "error"
                    ? "重试下载并安装"
                    : "下载并安装最新工具"}
              </Button>
            </div>
          </div>
          {(running || trimRunning) && <p>编码或剪辑导出结束后可更新工具。</p>}
        </section>
      )}
      <div className="engine-list">
        {engines.map((e) => (
          <div className="engine-item" key={e.id}>
            <Cpu size={17} />
            <strong>{engineLabel(e)}</strong>
            <span>
              <Check size={14} />
              可用
            </span>
          </div>
        ))}
      </div>
      {detecting && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> 正在测试硬件编码能力…
        </p>
      )}
      {!detecting && !engines.length && (
        <p className="inline-error">
          尚无可用编码器。请下载编码工具，或在安装完成后重新检测。
        </p>
      )}
      <details className="engine-paths">
        <summary>引擎位置</summary>
        {Object.entries(engineInfo).map(([key, value]) => (
          <p key={key}>
            <strong>{key}</strong>
            <code>{value || "未找到"}</code>
          </p>
        ))}
      </details>
      <div className="modal-actions">
        <Button onClick={() => action("openDataFolder")}>配置与日志</Button>
        <Button
          onClick={async () => {
            try {
              onShowLog(await call("logs", {}));
            } catch {}
          }}
        >
          检测日志与版本
        </Button>
        <Button
          disabled={detecting || running}
          onClick={() => action("detect")}
        >
          <RefreshCw size={15} />
          重新检测
        </Button>
      </div>
    </Modal>
  );
}
