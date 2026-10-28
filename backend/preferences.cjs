"use strict";
const shippedRegistry = require("../locales/registry.json");

// Pure preference policy. Persistence stays in the service's settings store.
function createPreferences(registry = shippedRegistry) {
  const supported = new Set(registry.locales.map(({ id }) => id));
  return {
    normalize(locale) {
      // null reserves "follow system" for the formal multilingual stage.
      // Preparation deliberately resolves that mode to Chinese on all systems.
      if (locale == null) return null;
      return supported.has(locale) ? locale : registry.defaultLocale;
    },
    resolve(locale) {
      return supported.has(locale) ? locale : registry.defaultLocale;
    },
  };
}
function normalizeTheme(value) {
  return ["system", "light", "dark"].includes(value) ? value : "system";
}
function resolveTheme(value, systemDark) {
  const theme = normalizeTheme(value);
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}
module.exports = { createPreferences, normalizeTheme, resolveTheme };
