import fs from "node:fs";
import YAML from "yaml";
import { format } from "prettier";
const raw = fs.readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
const t = YAML.parse(raw.split("---")[1]);
const lines = [];
const vars = (colors) =>
  Object.entries(colors)
    .map(([key, value]) => `--color-${key}:${value};`)
    .join("\n");
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
      `:root[data-theme="light"]{${vars(t.lightColors)}}` +
      // Accent after the light base; the light+accent rule is more specific.
      Object.entries(t.accents)
        .map(
          ([name, { dark, light }]) =>
            `:root[data-accent="${name}"]{${vars(dark)}}` +
            `:root[data-theme="light"][data-accent="${name}"]{${vars(light)}}`,
        )
        .join(""),
    { parser: "css" },
  ),
);
fs.writeFileSync(
  new URL("../desktop/theme-colors.json", import.meta.url),
  await format(JSON.stringify({ dark: t.colors, light: t.lightColors }), {
    parser: "json",
  }),
);
