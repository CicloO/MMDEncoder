const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
// Every action the renderer sends must pass both the preload allowlist and the
// main-process handler, otherwise the UI only shows "不支持的操作".
test("every renderer action is allowed by preload and handled by main", () => {
  const ui = fs
    .readdirSync(path.join(root, "src"))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => read(path.join("src", f)))
    .join("\n");
  const used = new Set(
    [...ui.matchAll(/\b(?:invoke|call|action)\(\s*"([A-Za-z]+)"/g)].map(
      (m) => m[1],
    ),
  );
  const preload = read("desktop/preload.cjs");
  const main = read("desktop/main.cjs");
  const preloadList = /new Set\(\[([\s\S]*?)\]\)/.exec(preload)[1];
  const mainList = /const allowed = \[([\s\S]*?)\];/.exec(main)[1];
  assert.ok(used.size > 20, "expected to find the renderer actions");
  for (const action of used) {
    assert.match(preloadList, new RegExp(`"${action}"`), `preload: ${action}`);
    assert.ok(
      mainList.includes(`"${action}"`) ||
        main.includes(`action === "${action}"`),
      `main: ${action}`,
    );
  }
});
