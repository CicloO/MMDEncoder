import type { Translator } from "./runtime.mjs";
import type { ErrorData } from "./messages.mjs";
export function formatTrimMessage(
  runtime: Translator,
  value: ErrorData | string | null | undefined,
): string | undefined;
