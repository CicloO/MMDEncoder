const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
test("the approved ICO keeps all seven size-specific PNG drawings", () => {
  const root = path.resolve(__dirname, "../assets"),
    ico = fs.readFileSync(path.join(root, "icon.ico"));
  assert.equal(
    crypto.createHash("sha256").update(ico).digest("hex"),
    "d1a9b17c4c9c1fb84e4d4a1425d42fe047bd077fee3aaeeb202a9beff47b5d73",
  );
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(4), sizes.length);
  for (const [i, size] of sizes.entries()) {
    const offset = 6 + i * 16,
      length = ico.readUInt32LE(offset + 8),
      start = ico.readUInt32LE(offset + 12);
    assert.equal(ico[offset] || 256, size);
    assert.equal(ico[offset + 1] || 256, size);
    const png = fs.readFileSync(path.join(root, `logo/icon-${size}.png`));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.deepEqual(ico.subarray(start, start + length), png);
  }
});
