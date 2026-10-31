import type { Translator } from "./runtime.mjs";
import type { ErrorData } from "./messages.mjs";
export function formatTrimDifferences(
  runtime: Pick<Translator, "t">,
  differences: Array<{
    key: string;
    name: string;
    reference: string;
    value: unknown;
    expected: unknown;
  }>,
): string;
export function formatTrimMessage(
  runtime: Translator,
  value: ErrorData | string | null | undefined,
): string | undefined;
