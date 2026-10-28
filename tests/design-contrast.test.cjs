const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const design = YAML.parse(
  fs.readFileSync(path.join(__dirname, "../DESIGN.md"), "utf8").split("---")[1],
);

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, "Theme tokens use opaque RGB values");
  const rgb = hex
    .slice(1)
    .match(/../g)
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(foreground, background) {
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
for (const [theme, colors] of [
  ["dark", design.colors],
  ["light", design.lightColors],
])
  test(`${theme} body, titles, captions and button labels retain readable contrast`, () => {
    for (const text of ["text", "muted"])
      for (const background of ["background", "surface", "raised"])
        assert.ok(
          contrast(colors[text], colors[background]) >= 4.5,
          `${theme} ${text} on ${background}: ${contrast(colors[text], colors[background])}`,
        );
    for (const [text, backgrounds] of [
      ["caption", ["background", "surface"]],
      ["captionRaised", ["raised"]],
    ])
      for (const background of backgrounds)
        assert.ok(
          contrast(colors[text], colors[background]) >= 4.5,
          `${theme} ${text} on ${background}: ${contrast(colors[text], colors[background])}`,
        );
    assert.ok(
      contrast(colors.onPrimary, colors.primary) >= 4.5,
      `${theme} primary button label`,
    );
  });
