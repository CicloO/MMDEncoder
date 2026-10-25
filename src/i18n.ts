import zhCN from "../locales/zh-CN.json";
import registry from "../locales/registry.json";
import { createTranslator } from "../locales/runtime.mjs";
export type { Catalog, MessageParams } from "../locales/runtime.mjs";
import type { MessageParams } from "../locales/runtime.mjs";

export type MessageKey = keyof typeof zhCN;
export const localeRuntime = createTranslator({
  sourceLocale: registry.sourceLocale,
  catalogs: { "zh-CN": zhCN },
});
export const {
  getLocale,
  setLocale,
  subscribe: subscribeLocale,
} = localeRuntime;
export function t(key: MessageKey, params: MessageParams = {}) {
  return localeRuntime.t(key, params);
}

export function errorMessage(error: unknown) {
  const e = error as {
    code?: string;
    params?: MessageParams;
    message?: string;
  } | null;
  const key = `error.${e?.code}`;
  if (localeRuntime.has(key)) return localeRuntime.t(key, e?.params);
  return String(e?.message ?? error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}
