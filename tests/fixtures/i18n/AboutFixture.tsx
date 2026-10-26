import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AboutDialog,
  type UpdateCheck,
  type AppUpdate,
} from "../../../src/AboutDialog";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime } from "../../../src/i18n";
import source from "../../../locales/zh-CN.json";
import { pseudoCatalog } from "./pseudo.mjs";
import "../../../src/tokens.css";
import "../../../src/style.css";

const calls: Array<{ name: string; payload?: unknown }> = [];
const pseudo = pseudoCatalog(source);
localeRuntime.registerCatalog("en-XA", pseudo);
let change = (_update: UpdateCheck) => {};
let progress = (_update: AppUpdate) => {};
function Fixture() {
  const [update, setUpdate] = useState<UpdateCheck>({
    checking: false,
    current: "1.6.1",
    latest: "1.6.1",
    newer: false,
  });
  const [open, setOpen] = useState(true);
  const [appUpdate, setAppUpdate] = useState<AppUpdate>({
    phase: "idle",
    received: 0,
    total: 0,
    error: "",
  });
  change = setUpdate;
  progress = setAppUpdate;
  return (
    <AboutDialog
      open={open}
      onClose={() => setOpen(false)}
      update={update}
      appUpdate={appUpdate}
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
  progress: (update: AppUpdate) => progress(update),
  choose: localeRuntime.setLocale,
  pseudo,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
