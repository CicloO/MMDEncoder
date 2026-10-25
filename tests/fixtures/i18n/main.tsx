import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BackgroundColor } from "../../../src/BackgroundColor";
import { MmdExportDialog } from "../../../src/MmdExportDialog";
import type { State } from "../../../src/types";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime } from "../../../src/i18n";
import { invoke } from "../../../src/ipc";
import source from "../../../locales/zh-CN.json";
import { pseudoCatalog } from "./pseudo.mjs";
import "../../../src/tokens.css";
import "../../../src/style.css";

const pseudo = pseudoCatalog(source);
delete pseudo["background.customLabel"];
localeRuntime.registerCatalog("en-XA", pseudo);
let mounts = 0;
let openMmd = () => {};
function Fixture() {
  const [color, setColor] = useState("#00FF00");
  const [state, setState] = useState<State | null>(null);
  const [mmdOpen, setMmdOpen] = useState(false);
  openMmd = () => setMmdOpen(true);
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
  return (
    <main>
      <input aria-label="draft" defaultValue="" />
      <BackgroundColor value={color} onChange={setColor} />
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
  choose: localeRuntime.setLocale,
  pseudo,
  mounts: () => mounts,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
