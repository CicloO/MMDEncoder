import { createRoot } from "react-dom/client";
import App from "../../../src/App";
import { LocaleRoot } from "../../../src/LocaleRoot";
import { localeRuntime } from "../../../src/i18n";
import source from "../../../locales/zh-CN.json";
import { pseudoCatalog } from "./pseudo.mjs";
import "../../../src/tokens.css";
import "../../../src/style.css";
const pseudo = pseudoCatalog(source);
localeRuntime.registerCatalog("en-XA", pseudo);
(window as any).appAboutFixture = { pseudo };
createRoot(document.getElementById("root")!).render(
  <LocaleRoot>{() => <App />}</LocaleRoot>,
);
