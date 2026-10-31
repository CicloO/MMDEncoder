// Packs the curated size-specific PNGs into assets/icon.ico.
// 16/24 use simplified art, 32/48 heavier art, and 64+ the full design.
// Do not regenerate every size from assets/icon.svg: small details would be lost.
const fs = require("node:fs");
const path = require("node:path");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
(async () => {
  const images = SIZES.map((size) => {
    const png = fs.readFileSync(
      path.join(__dirname, `../assets/logo/icon-${size}.png`),
    );
    if (
      !png
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(16) !== size ||
      png.readUInt32BE(20) !== size
    )
      throw new Error(`Invalid curated icon PNG: ${size}`);
    return png;
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  images.forEach((png, i) => {
    const e = Buffer.alloc(16);
    e[0] = SIZES[i] % 256; // 256 is stored as 0
    e[1] = SIZES[i] % 256;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  });
  fs.writeFileSync(
    path.join(__dirname, "../assets/icon.ico"),
    Buffer.concat([header, ...entries, ...images]),
  );
})();
