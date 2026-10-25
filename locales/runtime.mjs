// Shared, synchronous runtime for the renderer and Node helpers. No filesystem,
// DOM, process state or test catalogs: callers supply the available resources.
export function createTranslator({ sourceLocale, catalogs, initialLocale }) {
  const resources = new Map(Object.entries(catalogs));
  if (!resources.has(sourceLocale)) throw Error("Source catalog is required");
  const listeners = new Set();
  let locale = resources.has(initialLocale) ? initialLocale : sourceLocale;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const pattern = (value, params) => {
    if (typeof value === "string") return value || undefined;
    if (!value || typeof value !== "object") return undefined;
    const count = Number(params.count);
    const form = Number.isFinite(count)
      ? new Intl.PluralRules(locale).select(count)
      : "other";
    return value[form] || value.other || undefined;
  };
  return {
    getLocale: () => locale,
    getLocales: () => [...resources.keys()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerCatalog(id, catalog) {
      // Validate the Intl locale before accepting resources.
      Intl.getCanonicalLocales(id);
      resources.set(id, catalog);
      if (locale === id) notify();
    },
    setLocale(next) {
      const resolved = resources.has(next) ? next : sourceLocale;
      if (locale !== resolved) {
        locale = resolved;
        notify();
      }
      return locale;
    },
    has(key) {
      return (
        Object.hasOwn(resources.get(sourceLocale), key) ||
        Object.hasOwn(resources.get(locale), key)
      );
    },
    t(key, params = {}) {
      const message =
        pattern(resources.get(locale)?.[key], params) ??
        pattern(resources.get(sourceLocale)?.[key], params) ??
        key;
      return message.replace(/\{(\w+)\}/g, (token, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : token,
      );
    },
    number(value, options = {}) {
      return new Intl.NumberFormat(locale, options).format(value);
    },
    dateTime(value, options = {}) {
      return new Intl.DateTimeFormat(locale, options).format(new Date(value));
    },
    unit(value, unit, options = {}) {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        ...options,
      }).format(value);
    },
    bytes(value) {
      const exponent =
        value > 0
          ? Math.min(
              3,
              Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
            )
          : 0;
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: ["byte", "kilobyte", "megabyte", "gigabyte"][exponent],
        maximumFractionDigits: exponent ? 2 : 0,
      }).format(value / 1024 ** exponent);
    },
  };
}
