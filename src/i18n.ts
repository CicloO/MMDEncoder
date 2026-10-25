import zhCN from "../locales/zh-CN.json";
import registry from "../locales/registry.json";
import { createTranslator } from "../locales/runtime.mjs";
import { formatVideoSummary } from "../locales/video-summary.mjs";
import { formatMediaMessage } from "../locales/media-messages.mjs";
import {
  formatDescriptor,
  serializeError,
  messageDescriptor,
} from "../locales/messages.mjs";
import type {
  MessageDescriptor,
  StageDescriptor,
} from "../locales/messages.mjs";
export type {
  ErrorData,
  MessageDescriptor,
  StageDescriptor,
} from "../locales/messages.mjs";
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
  const e = serializeError(error);
  const lines = [
    formatMediaMessage(localeRuntime, "error", e) ??
      formatDescriptor(localeRuntime, "error", e),
    ...(e.issues || []).map(
      (issue) =>
        formatMediaMessage(localeRuntime, "error", issue) ??
        formatDescriptor(localeRuntime, "error", issue),
    ),
  ];
  return lines
    .filter(Boolean)
    .join("\n")
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function stageMessage(value: StageDescriptor | string) {
  return formatDescriptor(localeRuntime, "stage", value);
}

export function summaryMessage(value: MessageDescriptor | string) {
  return (
    formatVideoSummary(localeRuntime, value) ??
    formatMediaMessage(localeRuntime, "message", value) ??
    formatDescriptor(localeRuntime, "message", value)
  );
}
export function notification(code: string, params: MessageParams = {}) {
  return messageDescriptor(
    code,
    params,
    localeRuntime.t(`message.${code}`, params),
  );
}
