import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AlignDialog, type Alignment } from "../../../src/AlignDialog";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime } from "../../../src/i18n";
import { invoke } from "../../../src/ipc";
import source from "../../../locales/zh-CN.json";
import { pseudoCatalog } from "./pseudo.mjs";
import "../../../src/tokens.css";
import "../../../src/style.css";

type Options = {
  targetPath: string;
  fixedReference?: string;
  initial?: Partial<Alignment>;
};
const pseudo = pseudoCatalog(source);
localeRuntime.registerCatalog("en-XA", pseudo);
let open = (_options: Options) => {};
let applied: Alignment | null = null;
function Fixture() {
  const [options, setOptions] = useState<Options | null>(null);
  open = setOptions;
  return (
    <main>
      <button onClick={() => {}}>Alignment fixture focus target</button>
      <AlignDialog
        open={!!options}
        targetPath={options?.targetPath}
        fixedReference={options?.fixedReference}
        initial={options?.initial}
        withTrim
        description="User alignment 文件名"
        call={invoke}
        onApply={async (value) => {
          applied = value;
        }}
        onClose={() => setOptions(null)}
      />
    </main>
  );
}
(window as any).alignLocale = {
  open: (options: Options) => open(options),
  applied: () => applied,
  choose: localeRuntime.setLocale,
  pseudo,
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
