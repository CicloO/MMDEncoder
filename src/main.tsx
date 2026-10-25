import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LocaleRoot } from "./LocaleRoot";
import "./tokens.css";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleRoot>{() => <App />}</LocaleRoot>
  </React.StrictMode>,
);
