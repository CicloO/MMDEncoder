import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AboutDialog, type UpdateCheck } from "../../../src/AboutDialog";
import { LocaleRoot } from "../../../src/LocaleRoot";
import "../../../src/tokens.css";
import "../../../src/style.css";

const calls: Array<{ name: string; payload?: unknown }> = [];
let change = (_update: UpdateCheck) => {};
function Fixture() {
  const [update, setUpdate] = useState<UpdateCheck>({
    checking: false,
    current: "1.6.1",
    latest: "1.6.1",
    newer: false,
  });
  const [open, setOpen] = useState(true);
  change = setUpdate;
  return (
    <AboutDialog
      open={open}
      onClose={() => setOpen(false)}
      update={update}
      appUpdate={{ phase: "idle", received: 0, total: 0, error: "" }}
      blocked=""
      onCheck={() => calls.push({ name: "check" })}
      onDownload={() => calls.push({ name: "download" })}
      onInstall={() => calls.push({ name: "install" })}
      action={(name, payload) => calls.push({ name, payload })}
    />
  );
}
(window as any).aboutFixture = {
  change: (update: UpdateCheck) => change(update),
  calls: () => calls,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
