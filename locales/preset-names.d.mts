import type { Translator } from "./runtime.mjs";
export type NamedPreset = {
  id: string;
  name: string;
  builtin?: boolean;
  nameKey?: string;
  nameSource?: "builtin" | "user";
  nameDisambiguation?: boolean;
};
export function presetDisplayName(
  runtime: Translator,
  preset: NamedPreset,
  peers?: NamedPreset[],
): string;
