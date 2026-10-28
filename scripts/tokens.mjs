import fs from "node:fs";
import YAML from "yaml";
import { format } from "prettier";
const raw = fs.readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
const t = YAML.parse(raw.split("---")[1]);
const lines = [];
for (const [key, value] of Object.entries(t.colors))
  lines.push(`--color-${key}:${value};`);
for (const [key, value] of Object.entries(t.typography))
  lines.push(`--font-${key}:${value.fontFamily};`);
for (const [group, prefix] of [
  ["rounded", "radius"],
  ["spacing", "space"],
])
  for (const [key, value] of Object.entries(t[group]))
    lines.push(`--${prefix}-${key}:${value};`);
fs.writeFileSync(
  new URL("../src/tokens.css", import.meta.url),
  await format(
    "/* Generated from DESIGN.md. */\n:root{\n" +
      lines.join("\n") +
      "\n}\n" +
      `:root[data-theme="light"]{${Object.entries(t.lightColors)
        .map(([key, value]) => `--color-${key}:${value};`)
        .join("\n")}}`,
    { parser: "css" },
  ),
);
fs.writeFileSync(
  new URL("../desktop/theme-colors.json", import.meta.url),
  await format(JSON.stringify({ dark: t.colors, light: t.lightColors }), {
    parser: "json",
  }),
);
