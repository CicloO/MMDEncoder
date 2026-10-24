const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { commit } = require("../backend/commit.cjs");

test("commit links, falls back to an exclusive copy, and never overwrites", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-commit-"));
  const file = (name, text) => {
    const p = path.join(dir, name);
    if (text !== undefined) fs.writeFileSync(p, text);
    return p;
  };
  try {
    // Hard link: the temporary file goes, the output has its contents.
    await commit(file("a.tmp", "A"), file("a.mp4"));
    assert.equal(fs.readFileSync(file("a.mp4"), "utf8"), "A");
    assert.equal(fs.existsSync(file("a.tmp")), false);
    // No hard links on the volume: copied instead.
    const link = fs.promises.link;
    fs.promises.link = async () => {
      throw Object.assign(Error("no links"), { code: "EXDEV" });
    };
    try {
      await commit(file("b.tmp", "B"), file("b.mp4"));
      assert.equal(fs.readFileSync(file("b.mp4"), "utf8"), "B");
      assert.equal(fs.existsSync(file("b.tmp")), false);
      // An existing output is kept and the temporary file too (the caller
      // picks another name).
      file("c.mp4", "old");
      await assert.rejects(commit(file("c.tmp", "new"), file("c.mp4")), {
        code: "EEXIST",
      });
      assert.equal(fs.readFileSync(file("c.mp4"), "utf8"), "old");
      assert.equal(fs.existsSync(file("c.tmp")), true);
    } finally {
      fs.promises.link = link;
    }
    // The same with links available.
    file("d.mp4", "old");
    await assert.rejects(commit(file("d.tmp", "new"), file("d.mp4")), {
      code: "EEXIST",
    });
    assert.equal(fs.readFileSync(file("d.mp4"), "utf8"), "old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
