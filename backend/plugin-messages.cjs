"use strict";
const registry = require("../locales/registry.json");
const source = require("../locales/zh-CN.json");
const keys = require("../locales/plugin-keys.json");
const { createTranslator } = require("../locales/runtime.mjs");

// A window receives a snapshot, not a second mutable language preference.
function pluginMessages(locale, catalogs = { "zh-CN": source }) {
  const runtime = createTranslator({
    sourceLocale: registry.sourceLocale,
    catalogs,
    initialLocale: locale,
  });
  return {
    locale: runtime.getLocale(),
    messages: Object.fromEntries(
      keys.map((key) => {
        const translated = catalogs[runtime.getLocale()]?.[key];
        return [
          key,
          typeof translated === "string" && translated
            ? translated
            : source[key],
        ];
      }),
    ),
  };
}
module.exports = { pluginMessages };
