const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Old plugin builds are pruned to the new one plus the previous one, so a
// registry entry pointing back to the previous build still finds its DLL.
test("plugin cleanup keeps the new and the previous build, uninstall removes all", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-plugin-"));
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  delete require.cache[require.resolve("../backend/mmd-plugin.cjs")];
  const plugin = require("../backend/mmd-plugin.cjs");
  const bin = path.join(root, "MMDEncoder", "mmd-plugin", "bin");
  const make = (name, age) => {
    const dir = path.join(bin, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MMDEncoderPlugin.dll"), name);
    const t = new Date(Date.now() - age * 60000);
    fs.utimesSync(dir, t, t);
    return dir;
  };
  const left = () => fs.readdirSync(bin).sort();
  try {
    // The previously registered build is passed in: it and the new one stay.
    make("oldest", 30);
    const prev = make("previous", 20);
    make("other", 10);
    const now = make("current", 0);
    await plugin.cleanup([now, prev]);
    assert.deepEqual(left(), ["current", "previous"]);

    // Nothing registered before: the newest other folder counts as previous.
    make("older", 40);
    const newer = make("newer", 5);
    await plugin.cleanup([now]);
    assert.deepEqual(left(), ["current", "newer"]);
    assert.ok(fs.existsSync(path.join(newer, "MMDEncoderPlugin.dll")));

    await plugin.cleanup([], { all: true });
    assert.deepEqual(left(), []);
  } finally {
    process.env.LOCALAPPDATA = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
