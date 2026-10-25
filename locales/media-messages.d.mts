import type { Translator } from "./runtime.mjs";
import type { ErrorData, MessageDescriptor } from "./messages.mjs";
export function formatMediaMessage(
  runtime: Translator,
  namespace: "error" | "message",
  value: ErrorData | MessageDescriptor | string | null | undefined,
): string | undefined;
