import { useEffect, useRef } from "react";
import { Check, Cpu, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, Field, Modal } from "./components";
import { engineLabel, formatSize } from "./presentation";
import {
  diagnosticErrorMessage,
  localeRuntime,
  notification,
  summaryMessage,
  t,
} from "./i18n";
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
      {detecting
        ? t("engine.header.detecting")
        : t("engine.header.available", {
            count,
            formatted: localeRuntime.number(count),
          })}
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
      title={t("engine.title")}
      description={t("engine.description")}
    >
      {tools && (
        <section
          className="modal-section"
          aria-label={t("engine.toolsSection")}
          aria-busy={tools.busy}
        >
          <h3>{t("engine.tools")}</h3>
          <p className="hint">{t("engine.sources")}</p>
          {tools.phase === "downloading" && (
            <p>
              {tools.total
                ? t("engine.progressKnown", {
                    received: formatSize(tools.received),
                    total: formatSize(tools.total),
                  })
                : t("engine.progressUnknown", {
                    received: formatSize(tools.received),
                  })}
            </p>
          )}
          <Field id="tools-root" label={t("engine.root")}>
            <div className="path-picker">
              <input
                id="tools-root"
                value={tools.root}
                readOnly
                title={tools.root}
              />
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                title={t("engine.changeRootHint")}
                onClick={async () => {
                  try {
                    const dir = await call("pickDirectory", {
                      title: t("engine.chooseRootTitle"),
                    });
                    if (dir)
                      await call(
                        "setToolsRoot",
                        { root: dir },
                        notification("TOOLS_ROOT_CHANGED"),
                      );
                  } catch {}
                }}
              >
                <FolderOpen size={15} />
                {t("engine.changeRoot")}
              </Button>
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() =>
                  action(
                    "setToolsRoot",
                    { root: "" },
                    notification("TOOLS_ROOT_RESTORED"),
                  )
                }
              >
                {t("engine.restoreRoot")}
              </Button>
            </div>
          </Field>
          <div className="status-row">
            <div>
              <p role={tools.phase === "error" ? "alert" : "status"}>
                {tools.errorData
                  ? t("engine.failureRetry", {
                      detail: diagnosticErrorMessage(tools.errorData),
                    })
                  : summaryMessage(tools.messageData || tools.message)}
              </p>
              <p className="hint">
                {Object.entries(tools.installed)
                  .map(([id, tool]) =>
                    t(
                      tool.verifiedHash
                        ? "engine.verifiedVersion"
                        : "engine.unverifiedVersion",
                      { id, version: tool.version },
                    ),
                  )
                  .join(t("engine.versionSeparator")) ||
                  t("engine.noneInstalled")}
              </p>
            </div>
            <div className="row-actions">
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() => action("checkTools")}
              >
                {t("engine.checkUpdate")}
              </Button>
              <Button
                disabled={tools.busy || running || trimRunning || detecting}
                onClick={() => action("installTools")}
              >
                {tools.busy
                  ? t("engine.working")
                  : tools.phase === "error"
                    ? t("engine.retryInstall")
                    : t("engine.install")}
              </Button>
            </div>
          </div>
          {(running || trimRunning) && <p>{t("engine.waitTasks")}</p>}
        </section>
      )}
      <div className="engine-list">
        {engines.map((e) => (
          <div className="engine-item" key={e.id}>
            <Cpu size={17} />
            <strong>{engineLabel(e)}</strong>
            <span>
              <Check size={14} />
              {t("engine.available")}
            </span>
          </div>
        ))}
      </div>
      {detecting && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> {t("engine.detecting")}
        </p>
      )}
      {!detecting && !engines.length && (
        <p className="inline-error">{t("engine.empty")}</p>
      )}
      <details className="engine-paths">
        <summary>{t("engine.paths")}</summary>
        {Object.entries(engineInfo).map(([key, value]) => (
          <p key={key}>
            <strong>{key}</strong>
            <code>{value || t("engine.notFound")}</code>
          </p>
        ))}
      </details>
      <div className="modal-actions">
        <Button onClick={() => action("openDataFolder")}>
          {t("engine.openData")}
        </Button>
        <Button
          onClick={async () => {
            try {
              onShowLog(await call("logs", {}));
            } catch {}
          }}
        >
          {t("engine.logs")}
        </Button>
        <Button
          disabled={detecting || running}
          onClick={() => action("detect")}
        >
          <RefreshCw size={15} />
          {t("engine.detect")}
        </Button>
      </div>
    </Modal>
  );
}
