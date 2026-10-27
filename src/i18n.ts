import zhCN from "../locales/zh-CN.json";
import registry from "../locales/registry.json";
import { createTranslator } from "../locales/runtime.mjs";
import { formatVideoSummary } from "../locales/video-summary.mjs";
import { formatMediaMessage } from "../locales/media-messages.mjs";
import { formatTrimMessage } from "../locales/trim-messages.mjs";
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

function formatErrorValue(value: ReturnType<typeof serializeError>): string {
  if (
    [
      "TOOLS_MOVE_FAILED",
      "VIDEO_ENGINE_FAILED",
      "DETAILS_READ_FAILED",
    ].includes(value.code || "") &&
    value.params.error
  )
    return localeRuntime.t(`error.${value.code}`, {
      detail: diagnosticErrorMessage(value.params.error),
    });
  return (
    formatTrimMessage(localeRuntime, value) ??
    formatMediaMessage(localeRuntime, "error", value) ??
    formatDescriptor(localeRuntime, "error", value)
  );
}

export function diagnosticErrorMessage(error: unknown) {
  const e = serializeError(error);
  const lines = [
    formatErrorValue(e),
    ...(e.issues || []).map(formatErrorValue),
  ];
  return lines.filter(Boolean).join("\n");
}

export function errorMessage(error: unknown) {
  return diagnosticErrorMessage(error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

export function stageMessage(value: StageDescriptor | string) {
  return formatDescriptor(localeRuntime, "stage", value);
}

export function summaryMessage(value: MessageDescriptor | string) {
  if (
    typeof value !== "string" &&
    [
      "ENGINE_DETECTION_INCOMPLETE",
      "ENGINE_DETECTION_CAUSE",
      "RTX_FAILED",
    ].includes(value?.code || "") &&
    value?.params?.error
  )
    return localeRuntime.t(`message.${value.code}`, {
      detail: diagnosticErrorMessage(value.params.error),
    });
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
