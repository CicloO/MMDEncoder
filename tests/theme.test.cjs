require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const YAML = require("yaml");
const { normalizeTheme, resolveTheme } = require("../backend/preferences.cjs");
const { createService } = require("../backend/service.cjs");
test("theme policy has two explicit modes and defaults to light", () => {
  for (const mode of ["light", "dark"])
    assert.equal(normalizeTheme(mode), mode);
  for (const value of [undefined, null, "auto", "system", "", 0])
    assert.equal(normalizeTheme(value), "light");
  assert.equal(resolveTheme("system", true), "light");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
test("theme uses the existing preference store, survives restart and leaves encoding state unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-theme-"));
  let svc = createService({ dataDir: dir });
  try {
    assert.equal(svc.getState().preferences.theme, "light");
    const before = svc.getState();
    for (const theme of ["dark", "light"]) {
      const state = await svc.invoke("setTheme", { theme });
      assert.equal(state.preferences.theme, theme);
      for (const key of ["settings", "presets", "jobs", "enhancements", "mmd"])
        assert.deepEqual(state[key], before[key], key);
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, "settings.json"), "utf8"),
      );
      assert.equal(saved.preferences.theme, theme);
      assert.equal(saved.settings.theme, undefined);
      assert.ok(saved.presets.every((p) => p.settings.theme === undefined));
      svc.dispose();
      svc = createService({ dataDir: dir });
      assert.equal(svc.getState().preferences.theme, theme);
    }
    assert.equal(svc.getState().preferences.locale, null);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("a rejected theme save rolls back memory and broadcasts no unsaved preference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-theme-fail-")),
    events = [];
  const svc = createService({
    dataDir: dir,
    onUpdate: (s) => events.push(s.preferences.theme),
  });
  try {
    fs.mkdirSync(path.join(dir, "settings.json"));
    await assert.rejects(svc.invoke("setTheme", { theme: "dark" }));
    assert.equal(svc.getState().preferences.theme, "light");
    assert.deepEqual(events, []);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("desktop startup colors are generated from the same source as CSS tokens", () => {
  const design = YAML.parse(
    fs
      .readFileSync(path.join(__dirname, "../DESIGN.md"), "utf8")
      .split("---")[1],
  );
  assert.deepEqual(require("../desktop/theme-colors.json"), {
    dark: design.colors,
    light: design.lightColors,
  });
});
