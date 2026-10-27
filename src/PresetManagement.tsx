import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Field, Modal, useDragSort } from "./components";
import { PresetList } from "./PresetList";
import { presetLabel } from "./presentation";
import type { createActions } from "./actions";
import type { MessageDescriptor } from "./i18n";
import type { State, Settings, Preset } from "./types";

// Every preset shows unless the user hid it with the hide / show button.
export const presetHidden = (p: Preset) => p.hidden ?? false;

// Own the complete preset workflow without owning the shared encoding draft,
// autosave chain or modal router. Accessors keep reads after awaits live.
export function usePresetManagement({
  presets,
  presetConflicts,
  settings: s,
  selection,
  draft,
  modal,
  setModal,
  busy,
  setBusy,
  error,
  clearError,
  actions: { call, action },
  notify,
}: {
  presets: Preset[];
  presetConflicts: State["presetConflicts"];
  settings: Settings | null;
  selection: {
    id: string;
    active?: Preset;
    modified: boolean;
    select: (id: string) => void;
    resetCustomFPS: () => void;
  };
  draft: {
    latest: () => Settings | null;
    isOwn: () => boolean;
    change: (settings: Settings) => void;
    persist: (settings: Settings) => Promise<void>;
    beforeApply: () => Promise<void>;
    beforeRename: () => Promise<void>;
  };
  modal: string;
  setModal: (modal: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  clearError: () => void;
  actions: ReturnType<typeof createActions>;
  notify: (message: string | MessageDescriptor) => void;
}) {
  const [presetName, setPresetName] = useState(""),
    [pendingPreset, setPendingPreset] = useState<Preset | null>(null),
    [pendingDelete, setPendingDelete] = useState<Preset | null>(null),
    [renameTarget, setRenameTarget] = useState<Preset | null>(null),
    [saveId, setSaveId] = useState("");
  const {
    id: presetId,
    active: activePreset,
    modified,
    select: setPresetId,
    resetCustomFPS,
  } = selection;
  const { change: changed, persist } = draft;
  const sortPreset = useDragSort(
    presets.map((p) => p.id),
    (ids) => void call("reorderPresets", { ids }).catch(() => {}),
    true,
    { handle: true },
  );
  async function applyPreset(p: Preset) {
    try {
      await draft.beforeApply();
      if (draft.isOwn()) {
        // A video's own settings: the preset replaces them, keeping where to save.
        changed({
          ...p.settings,
          outputMode: draft.latest()?.outputMode ?? p.settings.outputMode,
          outputDir: draft.latest()?.outputDir ?? p.settings.outputDir,
          presetName: p.name,
        });
      } else {
        const result: State = await call("applyPreset", { id: p.id });
        changed(result.settings);
      }
      setPresetId(p.id);
      resetCustomFPS();
      setPendingPreset(null);
      notify(`已应用“${p.name}”`);
    } catch {}
  }
  async function savePreset() {
    if (!s || !presetName.trim()) return;
    setBusy(true);
    try {
      await persist(s);
      const r: State = await call("savePreset", {
        name: presetName.trim(),
        ...(saveId ? { id: saveId } : {}),
        ...(draft.isOwn() ? { settings: s } : {}),
      });
      changed(
        draft.isOwn() ? { ...s, presetName: presetName.trim() } : r.settings,
      );
      setPresetId(
        r.presets.find((p) => p.name === presetName.trim())?.id || "",
      );
      setModal("");
      notify("预设已保存");
    } catch {
    } finally {
      setBusy(false);
    }
  }
  // Overwrite the selected preset with the current settings, keeping its name.
  async function overwritePreset() {
    if (!s || !activePreset) return;
    setBusy(true);
    try {
      await persist(s);
      const r: State = await call("savePreset", {
        id: activePreset.id,
        name: activePreset.name,
        ...(draft.isOwn() ? { settings: s } : {}),
      });
      changed(
        draft.isOwn() ? { ...s, presetName: activePreset.name } : r.settings,
      );
      setPresetId(activePreset.id);
      notify(`已保存到“${activePreset.name}”`);
    } catch {
    } finally {
      setBusy(false);
    }
  }
  async function renamePreset() {
    if (!renameTarget || !presetName.trim()) return;
    setBusy(true);
    try {
      await draft.beforeRename();
      const r: State = await call("renamePreset", {
        id: renameTarget.id,
        name: presetName.trim(),
      });
      changed({
        ...r.settings,
        presetName:
          presetId === renameTarget.id
            ? presetName.trim()
            : r.settings.presetName,
      });
      setRenameTarget(null);
      notify("预设名称已更新");
    } catch {
    } finally {
      setBusy(false);
    }
  }

  function select(id: string) {
    const p = presets.find((p) => p.id === id);
    if (p) {
      if (modified) setPendingPreset(p);
      else void applyPreset(p);
    } else setPresetId("");
  }
  function saveAs() {
    setSaveId("");
    setPresetName("");
    setModal("save");
  }
  return {
    select,
    saveAs,
    overwrite: overwritePreset,
    // Elements keep the existing Modal component type and App portal order.
    dialogs: {
      save: (
        <Modal
          error={error}
          open={modal === "save"}
          onClose={() => setModal("")}
          title="保存当前配置"
          description="把画质、音频和帧率保存为可重复使用的预设。输出目录单独记忆。"
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void savePreset();
            }}
          >
            <Field id="preset-name" label="预设名称">
              <input
                id="preset-name"
                autoFocus
                data-modal-autofocus
                maxLength={80}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="例如：MMD · HEVC 30帧"
              />
            </Field>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button onClick={() => setModal("")}>取消</Button>
              <Button
                variant="primary"
                disabled={busy || !presetName.trim()}
                type="submit"
              >
                保存预设
              </Button>
            </div>
          </form>
        </Modal>
      ),
      conflicts: (
        <Modal
          error={error}
          open={modal === "conflicts" && !!presetConflicts?.length}
          onClose={() => setModal("")}
          title="内置预设已更新"
          description="新版本改动了下面这些内置预设，而你之前修改过它们。内置预设已换成新版；你的修改可以丢弃，也可以另存为个人预设。关闭这个窗口后，下次打开软件还会再问。"
        >
          <div className="preset-list">
            {presetConflicts?.map((c) => (
              <div className="preset-item" key={c.id}>
                <div>
                  <strong>
                    {presets.find((p) => p.id === c.id)
                      ? presetLabel(
                          presets.find((p) => p.id === c.id)!,
                          presets,
                        )
                      : c.builtinName}
                  </strong>
                  <small>你修改过的版本：{c.name}</small>
                </div>
                <Button
                  onClick={() =>
                    call("resolvePresetConflict", { id: c.id, keep: false })
                  }
                >
                  用新版覆盖
                </Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    call(
                      "resolvePresetConflict",
                      { id: c.id, keep: true },
                      "已另存为个人预设",
                    )
                  }
                >
                  保留我的版本
                </Button>
              </div>
            ))}
          </div>
        </Modal>
      ),
      manager: (
        <Modal
          error={error}
          open={modal === "presets"}
          onClose={() => setModal("")}
          fixedHeight
          title="预设管理"
          description="拖动排序；隐藏的预设不出现在预设下拉框里。内置预设也可以改名、更新或删除，随时可以恢复。导入导出只包含个人预设。"
        >
          <PresetList
            presets={presets}
            sort={sortPreset}
            hidden={presetHidden}
            onApply={(p) => {
              setModal("");
              if (modified) setPendingPreset(p);
              else void applyPreset(p);
            }}
            onRename={(p) => {
              setRenameTarget(p);
              setPresetName(p.name);
              clearError();
            }}
            onHide={(p) => {
              void call("hidePreset", {
                id: p.id,
                hidden: !presetHidden(p),
              }).catch(() => {});
            }}
            onDelete={setPendingDelete}
          />
          <div className="modal-actions">
            <Button
              onClick={() =>
                action("importPresetsFile", undefined, "预设已导入")
              }
            >
              导入 JSON
            </Button>
            <Button
              onClick={() =>
                action("exportPresetsFile", undefined, "预设导出操作已完成")
              }
            >
              导出预设
            </Button>
            <Button
              onClick={() =>
                action("restoreBuiltinPresets", undefined, "内置预设已恢复")
              }
            >
              恢复内置预设
            </Button>
            {activePreset && (
              <Button
                onClick={() => {
                  setSaveId(activePreset.id);
                  setPresetName(activePreset.name);
                  setModal("save");
                }}
              >
                用当前设置更新预设
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => {
                setSaveId("");
                setPresetName("");
                setModal("save");
              }}
            >
              <Plus size={15} />
              新建预设
            </Button>
          </div>
        </Modal>
      ),
      switching: (
        <Modal
          error={error}
          open={!!pendingPreset}
          onClose={() => setPendingPreset(null)}
          title="切换编码预设"
          description="当前配置有未保存到预设的修改。切换将替换当前编码设置，输出目录保留。"
        >
          <div className="modal-actions">
            <Button onClick={() => setPendingPreset(null)} autoFocus>
              保留当前设置
            </Button>
            <Button
              variant="primary"
              onClick={() => pendingPreset && applyPreset(pendingPreset)}
            >
              应用“{pendingPreset ? presetLabel(pendingPreset, presets) : ""}”
            </Button>
          </div>
        </Modal>
      ),
      deletion: (
        <Modal
          error={error}
          open={!!pendingDelete}
          onClose={() => setPendingDelete(null)}
          title="删除个人预设"
          description={
            pendingDelete?.builtin
              ? `删除内置预设“${presetLabel(pendingDelete, presets)}”后，可在预设管理中点“恢复内置预设”找回。`
              : `删除“${pendingDelete?.name || ""}”后无法恢复。不会影响视频文件。`
          }
        >
          <div className="modal-actions">
            <Button autoFocus onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await call("deletePreset", { id: pendingDelete?.id });
                  setPendingDelete(null);
                  notify("预设已删除");
                } catch {}
              }}
            >
              删除预设
            </Button>
          </div>
        </Modal>
      ),
      rename: (
        <Modal
          error={error}
          open={!!renameTarget}
          onClose={() => setRenameTarget(null)}
          title="修改预设名称"
          description="仅修改名称，已保存的编码参数保持不变。"
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void renamePreset();
            }}
          >
            <Field id="rename-preset" label="预设名称">
              <input
                id="rename-preset"
                value={presetName}
                maxLength={80}
                onChange={(e) => setPresetName(e.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <Button onClick={() => setRenameTarget(null)}>取消</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !presetName.trim()}
              >
                保存名称
              </Button>
            </div>
          </form>
        </Modal>
      ),
    },
  };
}
