import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AlignDialog, type Alignment } from "../../../src/AlignDialog";
import { FileMeta } from "../../../src/FileMeta";
import { MediaDetails } from "../../../src/MediaDetails";
import { Modal } from "../../../src/components";
import type { MediaMeta } from "../../../src/types";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime, t } from "../../../src/i18n";
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
let showMetadata = (_value: { meta: MediaMeta; details: any }) => {};
function Fixture() {
  const [options, setOptions] = useState<Options | null>(null);
  const [metadata, setMetadata] = useState<{
    meta: MediaMeta;
    details: any;
  } | null>(null);
  open = setOptions;
  showMetadata = setMetadata;
  return (
    <main>
      <button onClick={() => {}}>Alignment fixture focus target</button>
      <Modal
        open={!!metadata}
        title={t("details.title")}
        description={t("details.description")}
        wide
        onClose={() => setMetadata(null)}
      >
        {metadata && (
          <>
            <FileMeta meta={metadata.meta} />
            <MediaDetails details={metadata.details} media />
          </>
        )}
      </Modal>
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
  showMetadata: (value: { meta: MediaMeta; details: any }) =>
    showMetadata(value),
};
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <Fixture />}</LocaleRoot>,
);
