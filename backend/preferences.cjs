"use strict";
const shippedRegistry = require("../locales/registry.json");

// The first Windows display language that a registered locale covers: exact
// tag first, then the language alone (zh-TW still reads Simplified Chinese).
// Unknown languages get the fallback (English); no list means the default.
function systemLocale(registry, languages) {
  const ids = registry.locales.map(({ id }) => id);
  if (!languages?.length) return registry.defaultLocale;
  for (const tag of languages) {
    const lower = String(tag).toLowerCase();
    const exact = ids.find((id) => id.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split("-")[0];
    const near = ids.find((id) => id.toLowerCase().split("-")[0] === base);
    if (near) return near;
  }
  return ids.includes(registry.fallbackLocale)
    ? registry.fallbackLocale
    : registry.defaultLocale;
}
// Pure preference policy. Persistence stays in the service's settings store.
function createPreferences(registry = shippedRegistry, systemLanguages = []) {
  const supported = new Set(registry.locales.map(({ id }) => id));
  const system = systemLocale(registry, systemLanguages);
  return {
    system,
    normalize(locale) {
      // null follows the Windows display language.
      if (locale == null) return null;
      return supported.has(locale) ? locale : registry.defaultLocale;
    },
    resolve(locale) {
      if (locale == null) return system;
      return supported.has(locale) ? locale : registry.defaultLocale;
    },
  };
}
function normalizeTheme(value) {
  return ["light", "dark"].includes(value) ? value : "light";
}
function resolveTheme(value) {
  return normalizeTheme(value);
}
module.exports = {
  createPreferences,
  systemLocale,
  normalizeTheme,
  resolveTheme,
};
