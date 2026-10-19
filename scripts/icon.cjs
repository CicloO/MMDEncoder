// Builds assets/icon.ico from assets/icon.svg with every size Windows asks for
// (Explorer, taskbar, title bar), each stored as PNG. The packaging script
// writes this icon into MMDEncoder.exe; the window uses it at runtime too.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require(
  require.resolve("sharp", {
    paths: [
      process.env.MMD_BUILD_MODULES ||
        "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
    ],
  }),
);
const SIZES = [16, 24, 32, 48, 64, 128, 256];
(async () => {
  const svg = path.join(__dirname, "../assets/icon.svg");
  const images = await Promise.all(
    SIZES.map((size) =>
      sharp(svg, { density: Math.ceil((72 * size) / 32) })
        .resize(size, size)
        .png()
        .toBuffer(),
    ),
  );
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
