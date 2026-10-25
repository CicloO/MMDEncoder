import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BackgroundColor } from "../../../src/BackgroundColor";
import { MmdExportDialog } from "../../../src/MmdExportDialog";
import { PresetChoice } from "../../../src/PresetChoice";
import { PresetList } from "../../../src/PresetList";
import { Modal, Select, useDragSort } from "../../../src/components";
import {
  audioLabels,
  fadeOptions,
  formatDuration,
  formatFPS,
  formatSize,
  statusLabel,
  targetLabel,
} from "../../../src/presentation";
import type { State } from "../../../src/types";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime, errorMessage } from "../../../src/i18n";
import { serializeError } from "../../../locales/messages.mjs";
import type { ErrorData } from "../../../src/i18n";
import { invoke } from "../../../src/ipc";
import source from "../../../locales/zh-CN.json";
import { pseudoCatalog } from "./pseudo.mjs";
import { VideoFixture, videoSnapshot } from "./VideoFixture";
import "../../../src/tokens.css";
import "../../../src/style.css";

const pseudo = pseudoCatalog(source);
delete pseudo["background.customLabel"];
localeRuntime.registerCatalog("en-XA", pseudo);
let mounts = 0;
let openMmd = () => {};
let failPreset = async () => {};
let openPresets = () => {};
let openVideo = () => {};
function Fixture() {
  const [color, setColor] = useState("#00FF00");
  const [state, setState] = useState<State | null>(null);
  const [mmdOpen, setMmdOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [presetId, setPresetId] = useState("builtin-4k");
  const [presetError, setPresetError] = useState<ErrorData | null>(null);
  const sort = useDragSort(state?.presets.map((p) => p.id) || [], () => {});
  openMmd = () => setMmdOpen(true);
  openPresets = () => setPresetsOpen(true);
  openVideo = () => setVideoOpen(true);
  failPreset = async () => {
    try {
      await invoke("renamePreset", { id: "builtin-4k", name: "" });
    } catch (e) {
      setPresetError(serializeError(e));
    }
  };
  useEffect(() => {
    mounts++;
    void invoke("state").then((current: State) => {
      const preset = current.presets[0];
      setState({
        ...current,
        presets: [
          ...current.presets,
          {
            ...preset,
            id: "test-preset-policy",
            name: "User name 用户名称",
            nameSource: "user",
            settings: {
              ...preset.settings,
              encoder: "nvencc:hevc",
              alphaMode: "discard",
            },
          },
        ],
      });
    });
  }, []);
  if (videoOpen && state) return <VideoFixture state={state} />;
  return (
    <main>
      <input aria-label="draft" defaultValue="" />
      <BackgroundColor value={color} onChange={setColor} />
      {state && (
        <section aria-label="shared presentation">
          <PresetChoice
            presets={state.presets}
            value={presetId}
            modified={false}
            hidden={() => false}
            onChange={setPresetId}
          />
          <Select
            id="audio-fixture"
            label="audio fixture"
            value="none"
            options={Object.entries(audioLabels()).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={() => {}}
          />
          <Select
            id="fade-fixture"
            label="fade fixture"
            value="0.5"
            options={fadeOptions()}
            onChange={() => {}}
          />
          <output aria-label="status fixture">
            {statusLabel("cancelled")}
          </output>
          <output aria-label="unknown fixture">{formatFPS()}</output>
          <output aria-label="duration fixture">
            {formatDuration(360001)}
          </output>
          <output aria-label="size fixture">{formatSize(1536)}</output>
          <output aria-label="target fixture">
            {targetLabel(
              { ...state.settings, alphaMode: "mask" },
              state.engines,
            )}
          </output>
          {presetError && <p role="alert">{errorMessage(presetError)}</p>}
          <Modal
            open={presetsOpen}
            onClose={() => setPresetsOpen(false)}
            fixedHeight
            title="preset fixture"
            description="Shared preset controls in the application modal."
          >
            <PresetList
              presets={state.presets}
              sort={sort}
              hidden={() => false}
              onApply={(p) => setPresetId(p.id)}
              onRename={() => {}}
              onHide={() => {}}
              onDelete={() => {}}
            />
          </Modal>
        </section>
      )}
      {state && (
        <MmdExportDialog
          open={mmdOpen}
          onClose={() => setMmdOpen(false)}
          error=""
          mmd={state.mmd}
          presets={state.presets}
          busy={false}
          action={() => {}}
          onCall={async (name, patch) => {
            if (name === "mmdExportSet")
              setState((current) =>
                current
                  ? {
                      ...current,
                      mmd: { ...current.mmd, ...(patch as object) },
                    }
                  : current,
              );
          }}
        />
      )}
    </main>
  );
}
(window as any).localeFixture = {
  invoke,
  openMmd: () => openMmd(),
  failPreset: () => failPreset(),
  openPresets: () => openPresets(),
  openVideo: () => openVideo(),
  videoSnapshot,
  choose: localeRuntime.setLocale,
  pseudo,
  mounts: () => mounts,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
