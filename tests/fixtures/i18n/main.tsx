import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BackgroundColor } from "../../../src/BackgroundColor";
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
function Fixture() {
  const [color, setColor] = useState("#00FF00");
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <main>
      <input aria-label="draft" defaultValue="" />
      <BackgroundColor value={color} onChange={setColor} />
    </main>
  );
}
(window as any).localeFixture = {
  invoke,
  choose: localeRuntime.setLocale,
  pseudo,
  mounts: () => mounts,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
