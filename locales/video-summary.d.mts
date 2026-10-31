import type { Translator } from "./runtime.mjs";
import type { MessageDescriptor } from "./messages.mjs";
export function formatVideoSummary(
  runtime: Pick<Translator, "t" | "number">,
  value: MessageDescriptor | string,
): string | null;
