import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Field, Modal, useDragSort } from "./components";
import { PresetList } from "./PresetList";
import { t, notification } from "./i18n";
import { presetLabel } from "./presentation";
import type { createActions } from "./actions";
import type { MessageDescriptor } from "./i18n";
import type { State, Settings, Preset } from "./types";

// Every preset shows unless the user hid it with the hide / show button.
export const presetHidden = (p: Preset) => p.hidden ?? false;

// Retain only name authority for a notice that can outlive a locale change.
const nameData = (p: Preset) => ({
  id: p.id,
  name: p.name,
  builtin: p.builtin,
  ...(p.nameKey ? { nameKey: p.nameKey } : {}),
  ...(p.nameSource ? { nameSource: p.nameSource } : {}),
  ...(p.nameDisambiguation ? { nameDisambiguation: true } : {}),
});

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
      notify(
        notification("PRESET_APPLIED", {
          name: p.name,
          preset: nameData(p),
          peers: presets.map(nameData),
        }),
      );
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
      notify(notification("PRESET_SAVED"));
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
      notify(
        notification("PRESET_OVERWRITTEN", {
          name: activePreset.name,
          preset: nameData(activePreset),
          peers: presets.map(nameData),
        }),
      );
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
      notify(notification("PRESET_RENAMED"));
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
          open={modal === "save"}
          onClose={() => setModal("")}
          title={t("preset.save.title")}
          description={t("preset.save.description")}
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void savePreset();
            }}
          >
            <Field id="preset-name" label={t("preset.name")}>
              <input
                id="preset-name"
                autoFocus
                data-modal-autofocus
                maxLength={80}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder={t("preset.nameExample")}
              />
            </Field>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button onClick={() => setModal("")}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                disabled={busy || !presetName.trim()}
                type="submit"
              >
                {t("preset.save")}
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
          title={t("preset.conflicts.title")}
          description={t("preset.conflicts.description")}
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
                  <small>
                    {t("preset.conflicts.edited", { name: c.name })}
                  </small>
                </div>
                <Button
                  onClick={() =>
                    call("resolvePresetConflict", { id: c.id, keep: false })
                  }
                >
                  {t("preset.conflicts.replace")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    call(
                      "resolvePresetConflict",
                      { id: c.id, keep: true },
                      notification("PRESET_CONFLICT_KEPT"),
                    )
                  }
                >
                  {t("preset.conflicts.keep")}
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
          title={t("preset.manager.title")}
          description={t("preset.manager.description")}
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
                action(
                  "importPresetsFile",
                  undefined,
                  notification("PRESET_IMPORTED"),
                )
              }
            >
              {t("preset.import")}
            </Button>
            <Button
              onClick={() =>
                action(
                  "exportPresetsFile",
                  undefined,
                  notification("PRESET_EXPORTED"),
                )
              }
            >
              {t("preset.export")}
            </Button>
            <Button
              onClick={() =>
                action(
                  "restoreBuiltinPresets",
                  undefined,
                  notification("PRESET_RESTORED"),
                )
              }
            >
              {t("preset.restore")}
            </Button>
            {activePreset && (
              <Button
                onClick={() => {
                  setSaveId(activePreset.id);
                  setPresetName(activePreset.name);
                  setModal("save");
                }}
              >
                {t("preset.updateCurrent")}
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
              {t("preset.new")}
            </Button>
          </div>
        </Modal>
      ),
      switching: (
        <Modal
          error={error}
          open={!!pendingPreset}
          onClose={() => setPendingPreset(null)}
          title={t("preset.switch.title")}
          description={t("preset.switch.description")}
        >
          <div className="modal-actions">
            <Button onClick={() => setPendingPreset(null)} autoFocus>
              {t("preset.switch.keep")}
            </Button>
            <Button
              variant="primary"
              onClick={() => pendingPreset && applyPreset(pendingPreset)}
            >
              {t("preset.switch.apply", {
                name: pendingPreset ? presetLabel(pendingPreset, presets) : "",
              })}
            </Button>
          </div>
        </Modal>
      ),
      deletion: (
        <Modal
          error={error}
          open={!!pendingDelete}
          onClose={() => setPendingDelete(null)}
          title={t("preset.delete.title")}
          description={
            pendingDelete?.builtin
              ? t("preset.delete.builtin", {
                  name: presetLabel(pendingDelete, presets),
                })
              : t("preset.delete.personal", { name: pendingDelete?.name || "" })
          }
        >
          <div className="modal-actions">
            <Button autoFocus onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await call("deletePreset", { id: pendingDelete?.id });
                  setPendingDelete(null);
                  notify(notification("PRESET_DELETED"));
                } catch {}
              }}
            >
              {t("preset.delete")}
            </Button>
          </div>
        </Modal>
      ),
      rename: (
        <Modal
          error={error}
          open={!!renameTarget}
          onClose={() => setRenameTarget(null)}
          title={t("preset.rename.title")}
          description={t("preset.rename.description")}
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void renamePreset();
            }}
          >
            <Field id="rename-preset" label={t("preset.name")}>
              <input
                id="rename-preset"
                value={presetName}
                maxLength={80}
                onChange={(e) => setPresetName(e.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <Button onClick={() => setRenameTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !presetName.trim()}
              >
                {t("preset.rename.save")}
              </Button>
            </div>
          </form>
        </Modal>
      ),
    },
  };
}
